'use strict'

const SELF = 'signalk-tablet-camera-timelapse'

function buildSchema () {
  return {
    type: 'object',
    properties: {
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
      proxyWidth: {
        type: 'number',
        title: 'Gallery HD proxy width (px)',
        description: 'The tablet also saves a reduced copy of each frame on the Pi (never uploaded) so videos up to this width export without pulling full-size frames over Wi-Fi. About 400 KB per frame at 1920. 0 turns it off.',
        minimum: 0,
        default: 1920
      },
      writeExif: { type: 'boolean', title: 'Write GPS and time into JPEG EXIF', default: true },
      publishDeltas: { type: 'boolean', title: 'Publish status to Signal K (plugins.tabletCameraTimelapse.*)', default: true },
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
  proxyWidth: 1920,
  writeExif: true,
  publishDeltas: true,
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

module.exports = { buildSchema, withDefaults, DEFAULTS, SELF }
