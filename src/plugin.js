'use strict'

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const { buildSchema, withDefaults, SELF } = require('./schema')
const { buildManifest } = require('./manifest')
const { Storage, isValidSessionId, atomicWrite } = require('./storage')
const { DriveAuth } = require('./drive/oauth')
const { DriveTarget } = require('./drive/target')
const { Uploader } = require('./uploader')
const { snapshot, buildSidecar, addExif } = require('./metadata')
const Auto = require('../public/js/auto')

const MODES = ['off', 'auto', 'on']
const MAX_FRAME_BYTES = 40 * 1024 * 1024
const WEBAPP_PATH = `/${SELF}/`
const DELTA_PREFIX = 'plugins.tabletCameraTimelapse'

function readBody (req, limit) {
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body)
  return new Promise((resolve, reject) => {
    let chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > limit) { chunks = null; return } // keep draining so the 413 response reaches the client
      if (chunks) chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks) reject(Object.assign(new Error('frame too large'), { status: 413 }))
      else resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

module.exports = function (app) {
  const plugin = {
    id: SELF,
    name: 'Tablet Camera Timelapse',
    description: 'Wraps a Signal K web app full screen and takes timelapse photos with the tablet camera, stored on the server and uploaded to Google Drive.'
  }

  let opts = withDefaults({})
  let dataDir = null
  let storage = null
  let auth = null
  let target = null
  let uploader = null
  let evaluator = null
  let autoState = null
  let unsubAuto = null
  let timers = []
  let started = false

  const state = {
    mode: 'off',
    modeChangedAt: null,
    lastFrameAt: null,
    lastFrameBytes: null,
    avgFrameBytes: null,
    framesReceived: 0,
    sessionId: null,
    errors: [],
    lastPruneAt: null
  }
  const lastLogged = new Map()

  const log = {
    debug: (m) => app.debug(m),
    error: (m) => recordError(m)
  }

  function recordError (msg) {
    const at = new Date().toISOString()
    state.errors.unshift({ at, message: msg })
    state.errors.length = Math.min(state.errors.length, 10)
    // Log each distinct message at most every 10 minutes.
    const key = String(msg).slice(0, 80)
    const prev = lastLogged.get(key)
    if (!prev || Date.now() - prev > 600000) {
      lastLogged.set(key, Date.now())
      app.error(msg)
    }
  }

  function modeFile () { return path.join(dataDir, 'mode.json') }

  async function saveMode () {
    try {
      await atomicWrite(modeFile(), JSON.stringify({ mode: state.mode, at: state.modeChangedAt }))
    } catch (e) { recordError(`saving mode: ${e.message}`) }
  }

  function loadLastMode () {
    try {
      const m = JSON.parse(fs.readFileSync(modeFile(), 'utf8')).mode
      return MODES.includes(m) ? m : 'off'
    } catch (e) { return 'off' }
  }

  function autoConfig () {
    return {
      autoPath: opts.autoPath,
      autoOperator: opts.autoOperator,
      autoValue: opts.autoValue,
      autoCaseSensitive: opts.autoCaseSensitive,
      autoStaleSeconds: opts.autoStaleSeconds,
      autoDebounceSeconds: opts.autoDebounceSeconds
    }
  }

  function capturing () {
    if (!state.lastFrameAt) return false
    return Date.now() - state.lastFrameAt < Math.max(3 * opts.intervalSeconds * 1000, 30000)
  }

  function startAuto () {
    const cfg = autoConfig()
    if (!Auto.isConfigured(cfg)) return
    evaluator = Auto.createEvaluator(cfg)
    // Seed with the current value unless it is already stale.
    try {
      const cur = app.getSelfPath(cfg.autoPath)
      const v = cur && typeof cur === 'object' && 'value' in cur ? cur : (cur !== undefined ? { value: cur } : null)
      if (v && v.value !== undefined) {
        const ts = v.timestamp ? Date.parse(v.timestamp) : NaN
        const staleMs = (Number(cfg.autoStaleSeconds) || 0) * 1000
        const seenAt = Number.isFinite(ts) && ts <= Date.now() ? ts : Date.now()
        if (!staleMs || Date.now() - seenAt < staleMs) evaluator.update(v.value, seenAt)
      }
    } catch (e) { /* no data */ }
    try {
      const bus = app.streambundle.getSelfBus(cfg.autoPath)
      unsubAuto = bus.onValue(nd => {
        if (evaluator) autoState = evaluator.update(nd && 'value' in nd ? nd.value : nd)
      })
    } catch (e) {
      recordError(`cannot subscribe to ${cfg.autoPath}: ${e.message}`)
    }
    autoState = evaluator.evaluate()
  }

  function publishDeltas () {
    if (!opts.publishDeltas) return
    app.handleMessage(plugin.id, {
      updates: [{
        values: [
          { path: `${DELTA_PREFIX}.mode`, value: state.mode },
          { path: `${DELTA_PREFIX}.capturing`, value: capturing() },
          { path: `${DELTA_PREFIX}.queueLength`, value: storage ? storage.stats.queueCount : 0 },
          { path: `${DELTA_PREFIX}.sessionId`, value: capturing() ? state.sessionId : null }
        ]
      }]
    })
  }

  function summary () {
    const parts = [`Mode ${state.mode}`]
    if (state.mode === 'auto' && autoState) parts[0] += autoState.active ? ' (active)' : ' (waiting)'
    if (capturing()) parts.push('capturing')
    if (storage) parts.push(`queue ${storage.stats.queueCount} files / ${(storage.stats.queueBytes / 1048576).toFixed(0)} MB`)
    const blocker = storage && storage.ingestBlocker()
    if (blocker) parts.push(blocker === 'disk_low' ? 'DISK LOW' : 'CACHE FULL')
    if (opts.drive.enabled && auth) {
      const s = auth.status()
      if (s.state === 'pending') parts.push(`Drive: open ${s.verificationUrl} and enter ${s.userCode}`)
      else if (s.state === 'authorized') parts.push(`Drive ${uploader ? uploader.state : 'ok'}`)
      else parts.push(`Drive: ${s.state.replace('_', ' ')}`)
    }
    return parts.join(' · ')
  }

  function updateStatus () {
    const blocker = storage && storage.ingestBlocker()
    const driveBad = opts.drive.enabled && auth && ['needs_auth', 'unconfigured'].includes(auth.state())
    if (blocker || driveBad) app.setPluginError(summary())
    else app.setPluginStatus(summary())
  }

  function statusPayload () {
    const free = storage ? storage.freeBytes() : null
    const blocker = storage ? storage.ingestBlocker() : null
    return {
      mode: state.mode,
      modeChangedAt: state.modeChangedAt,
      capturing: capturing(),
      sessionId: state.sessionId,
      lastFrameAt: state.lastFrameAt ? new Date(state.lastFrameAt).toISOString() : null,
      framesReceived: state.framesReceived,
      avgFrameBytes: state.avgFrameBytes,
      auto: evaluator
        ? { configured: true, ...autoState, activeSince: autoState && autoState.activeSince ? new Date(autoState.activeSince).toISOString() : null, lastUpdateAt: autoState && autoState.lastUpdateAt ? new Date(autoState.lastUpdateAt).toISOString() : null }
        : { configured: false },
      queue: storage ? { count: storage.stats.queueCount, bytes: storage.stats.queueBytes, oldest: storage.stats.oldestQueued } : null,
      uploaded: storage ? { count: storage.stats.uploadedCount, bytes: storage.stats.uploadedBytes } : null,
      cache: storage ? { bytes: storage.cacheBytes(), maxBytes: storage.maxCacheBytes, full: blocker === 'cache_full' } : null,
      disk: { freeBytes: free, minFreeBytes: storage ? storage.minFreeBytes : null, low: blocker === 'disk_low' },
      ingestBlocked: blocker,
      drive: {
        enabled: !!opts.drive.enabled,
        auth: auth ? auth.status() : { state: 'unconfigured' },
        uploader: uploader ? uploader.status() : null,
        folderName: opts.drive.folderName
      },
      errors: state.errors
    }
  }

  /*
   * Freeboard-SK (and any host implementing the Signal K plotter extensions
   * API) discovers us through the plotterExtensions resource type. The
   * server unregisters the provider when the plugin stops.
   */
  function registerExtension () {
    if (typeof app.registerResourceProvider !== 'function') {
      app.debug('registerResourceProvider unavailable; Freeboard extension not offered')
      return
    }
    const version = require('../package.json').version
    const readOnly = async () => { throw new Error(`${plugin.id} is a read-only provider`) }
    try {
      app.registerResourceProvider({
        type: 'plotterExtensions',
        methods: {
          listResources: async () => (started ? { [plugin.id]: buildManifest({ version, base: WEBAPP_PATH }) } : {}),
          getResource: async (id) => {
            if (!started || id !== plugin.id) throw new Error(`No such plotterExtensions resource: ${id}`)
            return buildManifest({ version, base: WEBAPP_PATH })
          },
          setResource: readOnly,
          deleteResource: readOnly
        }
      })
    } catch (e) {
      recordError(`registering the Freeboard extension failed: ${e.message}`)
    }
  }

  function every (ms, fn) {
    const t = setInterval(() => {
      Promise.resolve().then(fn).catch(e => recordError(e.message))
    }, ms)
    timers.push(t)
  }

  plugin.start = function (options) {
    opts = withDefaults(options)
    dataDir = app.getDataDirPath()
    const storagePath = opts.storagePath && opts.storagePath.trim() ? opts.storagePath.trim() : path.join(dataDir, 'frames')

    state.mode = opts.defaultMode === 'last' ? loadLastMode() : (MODES.includes(opts.defaultMode) ? opts.defaultMode : 'off')
    if (state.mode === 'auto' && !Auto.isConfigured(autoConfig())) state.mode = 'off'
    state.modeChangedAt = new Date().toISOString()

    storage = new Storage({
      storagePath,
      afterUpload: opts.afterUpload,
      keepUploadedDays: opts.keepUploadedDays,
      minFreeDiskMB: opts.minFreeDiskMB,
      maxCacheMB: opts.maxCacheMB,
      log
    })

    auth = new DriveAuth({
      dataDir,
      clientId: opts.drive.clientId,
      clientSecret: opts.drive.clientSecret,
      log,
      onChange: (ev) => {
        if (ev === 'authorized' && uploader) uploader.kick()
        updateStatus()
      }
    })
    target = new DriveTarget({ auth, folderCachePath: path.join(dataDir, 'drive-folders.json'), rootName: opts.drive.folderName, log })
    uploader = new Uploader({
      storage,
      target,
      dataDir,
      intervalSeconds: opts.uploadIntervalSeconds,
      concurrency: opts.uploadConcurrency,
      log,
      isReady: () => auth.state() === 'authorized',
      onPass: () => updateStatus()
    })

    startAuto()
    started = true
    registerExtension()

    storage.init()
      .then(async () => {
        await target.init()
        const free = storage.freeBytes()
        if (free !== null && free < storage.minFreeBytes) recordError(`low disk at start: ${(free / 1048576).toFixed(0)} MB free`)
        await storage.pruneUploaded()
        await storage.evictForCap()
        state.lastPruneAt = Date.now()
        if (opts.drive.enabled && started) uploader.start()
        publishDeltas()
        updateStatus()
      })
      .catch(e => {
        recordError(`storage init failed: ${e.message}`)
        app.setPluginError(`Storage init failed: ${e.message}`)
      })

    every(1000, () => { if (evaluator) autoState = evaluator.evaluate() })
    every(10000, () => { publishDeltas(); updateStatus() })
    every(30000, async () => {
      await storage.refreshStats()
      await storage.evictForCap()
    })
    every(3600000, async () => {
      if (Date.now() - (state.lastPruneAt || 0) >= 86400000) {
        const n = await storage.pruneUploaded()
        state.lastPruneAt = Date.now()
        if (n) app.debug(`pruned ${n} uploaded files`)
      }
    })
    updateStatus()
  }

  plugin.stop = function () {
    started = false
    for (const t of timers) clearInterval(t)
    timers = []
    if (uploader) uploader.stop()
    if (auth) auth.stop()
    if (unsubAuto) { try { unsubAuto() } catch (e) { /* ignore */ } }
    unsubAuto = null
    evaluator = null
    autoState = null
  }

  plugin.schema = () => buildSchema()

  plugin.uiSchema = () => ({
    'ui:order': ['intervalSeconds', 'jpegQuality', 'defaultMode', 'autoPath', 'autoOperator', 'autoValue', 'autoCaseSensitive', 'autoStaleSeconds', 'autoDebounceSeconds', 'drive', '*'],
    drive: { clientSecret: { 'ui:widget': 'password' } }
  })

  plugin.registerWithRouter = function (router) {
    const r = (level) => (typeof router.access === 'function' ? router.access(level) : router)
    const fail = (res, status, error, extra) => res.status(status).json({ error, ...(extra || {}) })
    const ready = (res) => {
      if (!started || !storage) { fail(res, 503, 'plugin not started'); return false }
      return true
    }

    r('readonly').get('/config/client', (req, res) => {
      res.json({
        pluginId: plugin.id,
        webappPath: WEBAPP_PATH,
        intervalSeconds: opts.intervalSeconds,
        jpegQuality: opts.jpegQuality,
        auto: { configured: Auto.isConfigured(autoConfig()), ...autoConfig() },
        driveEnabled: !!opts.drive.enabled,
        mode: state.mode
      })
    })

    r('readonly').get('/mode', (req, res) => res.json({ mode: state.mode, modeChangedAt: state.modeChangedAt }))

    r('readwrite').put('/mode', async (req, res) => {
      let body = req.body
      if (!body || typeof body !== 'object' || Buffer.isBuffer(body)) {
        try { body = JSON.parse((await readBody(req, 4096)).toString() || '{}') } catch (e) { body = {} }
      }
      const mode = String(body.mode || '').toLowerCase()
      if (!MODES.includes(mode)) return fail(res, 400, 'mode must be off, auto or on')
      if (mode === 'auto' && !Auto.isConfigured(autoConfig())) return fail(res, 400, 'Auto is not configured')
      if (mode !== state.mode) {
        state.mode = mode
        state.modeChangedAt = new Date().toISOString()
        await saveMode()
        publishDeltas()
        updateStatus()
      }
      res.json({ mode: state.mode, modeChangedAt: state.modeChangedAt })
    })

    r('readonly').get('/status', (req, res) => {
      if (!ready(res)) return
      res.json(statusPayload())
    })

    r('readwrite').post('/frames', async (req, res) => {
      if (!ready(res)) return
      const blocker = storage.ingestBlocker()
      if (blocker) {
        req.resume()
        if (blocker === 'disk_low') recordError('frame rejected: free disk below minimum')
        return fail(res, 507, blocker)
      }
      const ctype = String(req.headers['content-type'] || '').split(';')[0].trim()
      if (ctype !== 'image/jpeg') { req.resume(); return fail(res, 415, 'Content-Type must be image/jpeg') }
      const q = req.query || {}
      const sessionId = String(q.session || '')
      if (!isValidSessionId(sessionId)) { req.resume(); return fail(res, 400, 'invalid or missing session') }
      let jpeg
      try {
        jpeg = await readBody(req, MAX_FRAME_BYTES)
      } catch (e) {
        return fail(res, e.status || 400, e.message)
      }
      if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return fail(res, 400, 'body is not a JPEG')
      const received = new Date()
      let captureDate = q.ts ? new Date(String(q.ts)) : received
      if (isNaN(captureDate.getTime())) captureDate = received
      const nav = snapshot(app)
      if (opts.writeExif) {
        const r = addExif(jpeg, { captureDate, nav })
        if (r.error) recordError(`EXIF skipped: ${r.error}`)
        jpeg = r.buf
      }
      const sidecar = buildSidecar({
        captureDate,
        receivedDate: received,
        sessionId,
        mode: String(q.mode || ''),
        device: q.device ? String(q.device).slice(0, 120) : null,
        width: Number(q.w) || null,
        height: Number(q.h) || null,
        bytes: jpeg.length,
        nav
      })
      try {
        const { base, duplicate } = await storage.writeFrame({ sessionId, captureDate, jpeg, sidecar })
        if (duplicate) {
          return res.status(200).json({ ok: true, duplicate: true, file: `${sessionId}/${base}.jpg`, queueCount: storage.stats.queueCount })
        }
        if (sessionId !== 'test-shots') {
          state.lastFrameAt = Date.now()
          state.sessionId = sessionId
        }
        state.framesReceived++
        state.lastFrameBytes = jpeg.length
        state.avgFrameBytes = state.avgFrameBytes ? Math.round(state.avgFrameBytes * 0.9 + jpeg.length * 0.1) : jpeg.length
        if (state.framesReceived % 100 === 0) app.debug(`${state.framesReceived} frames received; queue ${storage.stats.queueCount}`)
        res.status(201).json({
          ok: true,
          file: `${sessionId}/${base}.jpg`,
          bytes: jpeg.length,
          queueCount: storage.stats.queueCount,
          cacheFull: storage.ingestBlocker() === 'cache_full'
        })
      } catch (e) {
        recordError(`writing frame: ${e.message}`)
        fail(res, 500, 'write failed')
      }
    })

    r('readwrite').post('/drive/auth/start', async (req, res) => {
      if (!ready(res)) return
      try {
        res.json(await auth.startDeviceFlow())
      } catch (e) {
        fail(res, 400, e.message)
      }
    })

    r('readonly').get('/drive/auth/poll', (req, res) => {
      if (!ready(res)) return
      res.json(auth.status())
    })

    r('readwrite').post('/drive/auth/revoke', async (req, res) => {
      if (!ready(res)) return
      await auth.revoke()
      res.json(auth.status())
    })

    r('readwrite').post('/drive/upload-now', (req, res) => {
      if (!ready(res)) return
      uploader.kick()
      res.json({ ok: true })
    })
  }

  return plugin
}
