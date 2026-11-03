'use strict'

const fs = require('fs')
const path = require('path')

const SELF = 'signalk-tablet-camera-timelapse'
const DEFAULT_WEBAPP = '@signalk/freeboard-sk'

/*
 * Installed web apps for the config dropdown. The server's own list
 * (app.webapps, served at /skServer/webapps) is filled after plugins start,
 * so scan node_modules the same way the server does: configPath and appPath.
 */
function scanWebapps (config) {
  const dirs = []
  if (config && config.configPath) dirs.push(path.join(config.configPath, 'node_modules'))
  if (config && config.appPath && config.appPath !== config.configPath) dirs.push(path.join(config.appPath, 'node_modules'))
  const found = new Map()
  const readPkg = (dir) => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      const kw = pkg.keywords || []
      if (pkg.name && pkg.name !== SELF && (kw.includes('signalk-webapp') || kw.includes('signalk-embeddable-webapp')) && !found.has(pkg.name)) {
        found.set(pkg.name, { name: pkg.name, displayName: (pkg.signalk && pkg.signalk.displayName) || pkg.name })
      }
    } catch (e) { /* not a package */ }
  }
  for (const d of dirs) {
    let entries = []
    try { entries = fs.readdirSync(d) } catch (e) { continue }
    for (const e of entries) {
      if (e.startsWith('@')) {
        let scoped = []
        try { scoped = fs.readdirSync(path.join(d, e)) } catch (err) { continue }
        for (const s of scoped) readPkg(path.join(d, e, s))
      } else if (!e.startsWith('.')) {
        readPkg(path.join(d, e))
      }
    }
  }
  return [...found.values()].sort((a, b) => a.displayName.localeCompare(b.displayName))
}

function buildSchema (webapps) {
  const apps = webapps && webapps.length ? webapps : [{ name: DEFAULT_WEBAPP, displayName: 'Freeboard-SK' }]
  if (!apps.find(a => a.name === DEFAULT_WEBAPP)) apps.unshift({ name: DEFAULT_WEBAPP, displayName: 'Freeboard-SK (not installed)' })
  return {
    type: 'object',
    properties: {
      hostedWebapp: {
        type: 'string',
        title: 'Hosted web app',
        description: 'Web app shown full screen inside the wrapper',
        enum: apps.map(a => a.name),
        enumNames: apps.map(a => a.displayName),
        default: DEFAULT_WEBAPP
      },
      buttonCorner: {
        type: 'string',
        title: 'Button corner',
        description: 'Freeboard-SK uses the top-left (menu) and bottom-right (drop waypoint) corners',
        enum: ['bottom-left', 'bottom-right', 'top-right'],
        default: 'bottom-left'
      },
      intervalSeconds: { type: 'number', title: 'Capture interval (s)', minimum: 1, default: 10 },
      jpegQuality: {
        type: 'number',
        title: 'JPEG quality (0-1)',
        description: 'Used when the browser encodes the frame (canvas fallback). ImageCapture.takePhoto() JPEGs come from the camera as-is.',
        minimum: 0.1,
        maximum: 1,
        default: 0.85
      },
      defaultMode: {
        type: 'string',
        title: 'Mode at plugin start',
        enum: ['off', 'auto', 'on', 'last'],
        enumNames: ['Off', 'Auto', 'On', 'Last used'],
        default: 'off'
      },
      autoPath: { type: 'string', title: 'Auto: Signal K path', description: 'Leave empty to disable Auto mode', default: 'navigation.state' },
      autoOperator: { type: 'string', title: 'Auto: operator', enum: ['equals', 'notEquals'], default: 'equals' },
      autoValue: { type: 'string', title: 'Auto: value', default: 'sailing' },
      autoCaseSensitive: { type: 'boolean', title: 'Auto: case-sensitive compare', default: false },
      autoStaleSeconds: {
        type: 'number',
        title: 'Auto: stale after (s)',
        description: 'No update within this window makes the condition false. 0 (default) disables the check, which suits paths that only publish on change, such as navigation.state. Set e.g. 120 for continuously updated paths.',
        minimum: 0,
        default: 0
      },
      autoDebounceSeconds: { type: 'number', title: 'Auto: debounce (s)', minimum: 0, default: 30 },
      storagePath: { type: 'string', title: 'Storage path', description: 'Empty = <plugin data dir>/frames' },
      minFreeDiskMB: { type: 'number', title: 'Reject frames below free disk (MB)', minimum: 0, default: 500 },
      maxCacheMB: {
        type: 'number',
        title: 'Max frames stored on the Pi (MB)',
        description: 'Queued + kept uploaded files. In move mode the oldest uploaded files are evicted first; capture stops only if queued frames alone reach the cap. 0 = no cap.',
        minimum: 0,
        default: 1024
      },
      afterUpload: {
        type: 'string',
        title: 'After upload',
        enum: ['move', 'delete', 'keep'],
        enumNames: ['Move to uploaded/ and prune after N days', 'Delete', 'Move to uploaded/ and keep forever'],
        default: 'move'
      },
      keepUploadedDays: { type: 'number', title: 'Keep uploaded files (days, move mode)', minimum: 0, default: 7 },
      writeExif: { type: 'boolean', title: 'Write GPS and time into JPEG EXIF', default: true },
      publishDeltas: { type: 'boolean', title: 'Publish status to Signal K (plugins.tabletCameraTimelapse.*)', default: true },
      displayMode: {
        type: 'string',
        title: 'Installed app display mode',
        enum: ['fullscreen', 'standalone', 'browser'],
        default: 'fullscreen'
      },
      orientation: { type: 'string', title: 'Installed app orientation', enum: ['any', 'landscape', 'portrait'], default: 'any' },
      uploadIntervalSeconds: { type: 'number', title: 'Upload pass interval (s)', minimum: 5, default: 60 },
      uploadConcurrency: { type: 'number', title: 'Parallel uploads', minimum: 1, maximum: 8, default: 1 },
      drive: {
        type: 'object',
        title: 'Google Drive',
        properties: {
          enabled: { type: 'boolean', title: 'Upload to Google Drive', default: false },
          folderName: { type: 'string', title: 'Drive folder', default: 'Signal K Timelapse' },
          clientId: { type: 'string', title: 'OAuth client ID', description: 'Google Cloud OAuth client of type "TVs and Limited Input devices"' },
          clientSecret: { type: 'string', title: 'OAuth client secret' }
        }
      }
    }
  }
}

const DEFAULTS = {
  hostedWebapp: DEFAULT_WEBAPP,
  buttonCorner: 'bottom-left',
  intervalSeconds: 10,
  jpegQuality: 0.85,
  defaultMode: 'off',
  autoPath: 'navigation.state',
  autoOperator: 'equals',
  autoValue: 'sailing',
  autoCaseSensitive: false,
  autoStaleSeconds: 0,
  autoDebounceSeconds: 30,
  storagePath: '',
  minFreeDiskMB: 500,
  maxCacheMB: 1024,
  afterUpload: 'move',
  keepUploadedDays: 7,
  writeExif: true,
  publishDeltas: true,
  displayMode: 'fullscreen',
  orientation: 'any',
  uploadIntervalSeconds: 60,
  uploadConcurrency: 1,
  drive: { enabled: false, folderName: 'Signal K Timelapse', clientId: '', clientSecret: '' }
}

function withDefaults (opts) {
  const o = { ...DEFAULTS, ...(opts || {}) }
  o.drive = { ...DEFAULTS.drive, ...((opts && opts.drive) || {}) }
  o.intervalSeconds = Math.max(1, Number(o.intervalSeconds) || DEFAULTS.intervalSeconds)
  o.jpegQuality = Math.min(1, Math.max(0.1, Number(o.jpegQuality) || DEFAULTS.jpegQuality))
  return o
}

module.exports = { buildSchema, scanWebapps, withDefaults, DEFAULTS, SELF, DEFAULT_WEBAPP }
