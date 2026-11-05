// The capture engine. Exactly one runs per tablet (see protocol.js). It owns
// the camera, the capture timer, the Auto evaluation, sessions, the small
// retry buffer and the wake lock, and broadcasts its state to every UI.

import '../auto.js' // UMD: defines self.TimelapseAuto
import * as API from './api.js'
import { createCamera } from './camera.js'
import { prefs } from './prefs.js'
import { openChannel, HEARTBEAT_MS } from './protocol.js'
import { stampJpeg } from './stamp.js'

const Auto = self.TimelapseAuto
const BUFFER_MAX = 6
const STATUS_POLL_MS = 10000
const log = (...a) => console.log('[timelapse]', ...a)

function pad (n) { return String(n).padStart(2, '0') }
function sessionIdNow () {
  const d = new Date() // the tablet's local time
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export async function startEngine ({ host }) {
  const S = {
    host,
    startedAt: Date.now(),
    cfg: null,
    configError: null,
    status: null,
    statusError: null,
    mode: 'off',
    auto: { active: false, raw: false, reason: 'missing' },
    capturing: false,
    sessionId: null,
    sessionFrames: 0,
    lastCaptureAt: null,
    lastCaptureBytes: null,
    skipped: 0,
    buffer: [],
    uploadError: null,
    hiddenSince: null,
    lastPause: null
  }
  let evaluator = null
  let wsFirstValue = false
  let timer = null
  let busy = false
  let wakeLock = null
  let stopped = false
  const intervals = []
  const every = (fn, ms) => { const t = setInterval(fn, ms); intervals.push(t); return t }

  const cam = createCamera({
    onChange: () => broadcast(),
    jpegQuality: () => (S.cfg ? S.cfg.jpegQuality : 0.85)
  })
  const ch = openChannel(onMessage)

  // ---------- state out ----------
  function snapshot () {
    const c = cam.state
    return {
      host: S.host,
      secure: window.isSecureContext,
      configError: S.configError,
      statusError: S.statusError,
      cfg: S.cfg,
      status: S.status,
      mode: S.mode,
      auto: S.auto,
      capturing: S.capturing,
      sessionId: S.sessionId,
      sessionFrames: S.sessionFrames,
      lastCaptureAt: S.lastCaptureAt,
      lastCaptureBytes: S.lastCaptureBytes,
      skipped: S.skipped,
      buffered: S.buffer.length,
      uploadError: S.uploadError,
      lastPause: S.lastPause,
      camera: {
        open: !!c.stream,
        error: c.error,
        label: cam.label,
        cameras: c.cameras,
        cameraId: c.track ? c.track.getSettings().deviceId : prefs.get('cameraId', null),
        resolutions: c.resolutions,
        resolution: c.resolution,
        resChoice: c.resChoice,
        method: cam.usesImageCapture ? 'takePhoto' : 'canvas'
      },
      at: Date.now()
    }
  }
  let bTimer = null
  function broadcast () {
    // Coalesce bursts of changes into one message.
    if (bTimer) return
    bTimer = setTimeout(() => { bTimer = null; if (!stopped) ch.postMessage({ t: 'state', s: snapshot() }) }, 30)
  }
  every(() => ch.postMessage({ t: 'state', s: snapshot() }), HEARTBEAT_MS)

  // ---------- commands in ----------
  async function onMessage (m) {
    switch (m.t) {
      case 'hello': broadcast(); break
      case 'refresh': await refreshStatus(); break
      case 'setCamera': await cam.setCamera(m.id); reconcile(); break
      case 'setResolution': await (m.choice ? cam.setResolution(m.choice) : cam.setResolution(m.w, m.h)); break
      case 'testShot': testShot(m.id); break
      case 'probe': probeCamera(); break
    }
  }

  // ---------- server ----------
  function autoConfigured () { return !!(S.cfg && S.cfg.auto && S.cfg.auto.configured) }

  // Settings changed in the app reach us with the status (every 10 s, or at
  // once when a UI sends 'refresh' after saving).
  function applySettings (st) {
    if (!st || !S.cfg) return
    const intervalChanged = st.intervalSeconds !== S.cfg.intervalSeconds
    S.cfg = { ...S.cfg, intervalSeconds: st.intervalSeconds, stamp: st.stamp }
    if (intervalChanged && timer) {
      clearInterval(timer)
      timer = setInterval(captureTick, S.cfg.intervalSeconds * 1000)
      log('interval now', S.cfg.intervalSeconds, 's')
    }
  }

  async function refreshStatus () {
    try {
      S.status = await API.getStatus()
      S.statusError = null
      applySettings(S.status.settings)
      if (S.status.mode !== S.mode) {
        // Any deliberate mode change starts a fresh session folder.
        if (S.mode) prefs.set('session', null)
        S.mode = S.status.mode
      }
    } catch (e) {
      S.status = null
      S.statusError = e.status === 401 || e.status === 403 ? 'auth' : e.message
    }
    reconcile()
  }

  // ---------- Auto: own Signal K websocket ----------
  let ws = null
  let wsBackoff = 1000
  function connectWs () {
    if (!autoConfigured() || stopped) return
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    try { ws = new WebSocket(`${proto}//${location.host}/signalk/v1/stream?subscribe=none`) } catch (e) { return scheduleWs() }
    ws.onopen = () => {
      wsBackoff = 1000
      ws.send(JSON.stringify({ context: 'vessels.self', subscribe: [{ path: S.cfg.auto.autoPath, policy: 'instant' }] }))
    }
    ws.onmessage = (m) => {
      let msg
      try { msg = JSON.parse(m.data) } catch (e) { return }
      if (!msg.updates) return
      for (const u of msg.updates) {
        for (const v of (u.values || [])) {
          if (v.path === S.cfg.auto.autoPath) {
            wsFirstValue = true
            S.auto = evaluator.update(v.value)
          }
        }
      }
      onAutoChange()
    }
    ws.onclose = () => { ws = null; scheduleWs() }
    ws.onerror = () => { try { ws.close() } catch (e) { /* ignore */ } }
  }
  function scheduleWs () {
    if (stopped) return
    setTimeout(connectWs, wsBackoff)
    wsBackoff = Math.min(30000, wsBackoff * 2)
  }
  let lastAutoActive = false
  function onAutoChange () {
    if (S.auto.active !== lastAutoActive) {
      lastAutoActive = S.auto.active
      if (S.mode === 'auto') reconcile()
    }
    broadcast()
  }
  function startAuto () {
    if (!autoConfigured()) return
    evaluator = Auto.createEvaluator(S.cfg.auto)
    // Seed from the server's debounced state so a reload mid-session does not
    // wait out the debounce again.
    const sa = S.status && S.status.auto
    if (sa && sa.configured && sa.active) evaluator.seed(true, Date.parse(sa.activeSince) || Date.now())
    S.auto = evaluator.evaluate()
    every(() => {
      // Give the websocket a few seconds to deliver the cached value first.
      if (!wsFirstValue && Date.now() - S.startedAt < 8000) return
      S.auto = evaluator.evaluate()
      onAutoChange()
    }, 1000)
    connectWs()
  }

  // ---------- decisions ----------
  const modeWantsCapture = () => S.mode === 'on' || (S.mode === 'auto' && S.auto.active)
  const blocked = () => !!(S.status && S.status.ingestBlocked)
  function shouldCapture () {
    return document.visibilityState === 'visible' && window.isSecureContext && !blocked() && modeWantsCapture()
  }
  function wantStream () {
    return document.visibilityState === 'visible' && (S.mode === 'on' || S.mode === 'auto')
  }

  // ---------- capture ----------
  async function flushBuffer () {
    while (S.buffer.length) {
      try {
        await API.uploadFrame(S.buffer[0], 1)
      } catch (e) {
        if (e.permanent) { S.buffer.shift(); log('dropped buffered frame:', e.message); continue }
        throw e
      }
      S.buffer.shift()
    }
  }

  async function captureTick () {
    if (!shouldCapture() || !S.sessionId) return
    if (busy) { S.skipped++; return }
    busy = true
    try {
      const at = new Date()
      const ts = at.toISOString()
      const f = await stamped(await cam.takeFrame(), at)
      const frame = { ...f, ts, session: S.sessionId, mode: S.mode, device: cam.label }
      S.lastCaptureAt = Date.now()
      S.lastCaptureBytes = f.blob.size
      try {
        const r = await API.uploadFrame(frame)
        if (r && !r.duplicate) sendGalleryCopies(frame)
        S.sessionFrames++
        prefs.set('session', { id: frame.session, lastAt: Date.now() })
        S.uploadError = null
        if (r && r.cacheFull) refreshStatus()
      } catch (e) {
        S.uploadError = e.message
        if (e.status === 507) refreshStatus()
        else if (e.permanent) log('frame rejected by server:', e.message)
        else {
          S.buffer.push(frame)
          if (S.buffer.length > BUFFER_MAX) S.buffer.shift()
        }
      }
      if (S.buffer.length && !S.uploadError) {
        try { await flushBuffer() } catch (e) { S.uploadError = `${S.buffer.length} buffered frame(s) waiting: ${e.message}` }
      }
    } catch (e) {
      S.uploadError = e.message
      log('capture failed:', e.message)
    } finally {
      busy = false
      broadcast()
    }
  }

  // Timestamp burned into the frame when the app asks for it. A failure keeps
  // the unstamped frame rather than losing it.
  async function stamped (f, at) {
    const pos = S.cfg && S.cfg.stamp
    if (!pos || pos === 'off') return f
    try {
      const r = await stampJpeg(f.blob, at, pos, S.cfg.jpegQuality || 0.85)
      return { ...f, blob: r.blob, w: r.w, h: r.h }
    } catch (e) {
      log('timestamp failed:', e.message)
      return f
    }
  }

  // Thumbnail + HD proxy for the gallery, after the frame itself is safe.
  async function sendGalleryCopies (frame) {
    const hdWidth = S.cfg && S.cfg.proxyWidth > 0 && (!frame.w || frame.w > S.cfg.proxyWidth) ? S.cfg.proxyWidth : 0
    const c = await cam.galleryCopies(frame.blob, hdWidth)
    if (!c) return
    await API.uploadThumb({ session: frame.session, ts: frame.ts, blob: c.thumb })
    if (c.hd) await API.uploadThumb({ session: frame.session, ts: frame.ts, blob: c.hd, kind: 'hd' })
  }

  async function testShot (id) {
    const t0 = performance.now()
    try {
      while (busy) await new Promise(r => setTimeout(r, 100))
      busy = true
      const at = new Date()
      const ts = at.toISOString()
      const f = await stamped(await cam.takeFrame(), at)
      const ms = Math.round(performance.now() - t0)
      const r = await API.uploadFrame({ ...f, ts, session: 'test-shots', mode: 'test', device: cam.label })
      sendGalleryCopies({ ...f, ts, session: 'test-shots' })
      S.lastCaptureBytes = f.blob.size
      ch.postMessage({ t: 'testResult', id, ok: true, blob: f.blob, w: f.w, h: f.h, method: f.method, ms, file: r.file, bytes: f.blob.size })
      refreshStatus()
    } catch (e) {
      ch.postMessage({ t: 'testResult', id, ok: false, error: e.message })
    } finally {
      busy = false
      reconcile()
    }
  }

  // A settings view opened and the camera list is unknown: open the camera
  // once to learn the cameras and still sizes, then let reconcile close it.
  let probing = null
  function probeCamera () {
    if (probing || cam.state.stream || cam.state.resolutions.length || document.visibilityState !== 'visible') return
    probing = cam.open().catch(() => {}).finally(() => { probing = null; reconcile() })
  }

  // ---------- wake lock ----------
  async function acquireWakeLock () {
    if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return
    try {
      wakeLock = await navigator.wakeLock.request('screen')
      wakeLock.addEventListener('release', () => { wakeLock = null })
    } catch (e) { /* not allowed here; capture still runs */ }
  }
  function releaseWakeLock () {
    if (wakeLock) wakeLock.release().catch(() => {})
    wakeLock = null
  }

  // ---------- reconcile ----------
  let chain = Promise.resolve()
  function reconcile () {
    chain = chain.then(doReconcile, doReconcile)
    return chain
  }
  async function doReconcile () {
    if (!S.cfg || stopped) return
    const wants = modeWantsCapture()
    if (wants && !S.sessionId) {
      // Resume the previous session after a reload, a host switching
      // contexts, or a brief Auto dropout, so one passage stays in one folder.
      const last = prefs.get('session', null)
      const resumeMs = Math.max(5 * 60000, 10 * S.cfg.intervalSeconds * 1000)
      if (last && last.id && Date.now() - last.lastAt < resumeMs) {
        S.sessionId = last.id
        log('session resume', S.sessionId)
      } else {
        S.sessionId = sessionIdNow()
        log('session start', S.sessionId)
      }
      S.sessionFrames = 0
      prefs.set('session', { id: S.sessionId, lastAt: Date.now() })
    } else if (!wants && S.sessionId) {
      log('session end', S.sessionId, S.sessionFrames, 'frames')
      S.sessionId = null
    }

    if (wantStream()) {
      if (!cam.state.stream) await cam.open()
    } else if (cam.state.stream && !busy) {
      cam.close()
    }

    const shoot = shouldCapture() && !!cam.state.stream
    if (shoot && !timer) {
      timer = setInterval(captureTick, S.cfg.intervalSeconds * 1000)
      captureTick()
    } else if (!shoot && timer) {
      clearInterval(timer)
      timer = null
    }
    S.capturing = shoot
    if (shoot) acquireWakeLock()
    else releaseWakeLock()
    broadcast()
  }

  function onVisibility () {
    if (document.visibilityState === 'hidden') {
      if (S.capturing) S.hiddenSince = Date.now()
      if (timer) { clearInterval(timer); timer = null }
      cam.close()
      S.capturing = false
      wakeLock = null
    } else {
      if (S.hiddenSince) {
        S.lastPause = { from: S.hiddenSince, to: Date.now() }
        S.hiddenSince = null
      }
      refreshStatus()
    }
    broadcast()
  }
  document.addEventListener('visibilitychange', onVisibility)

  /** Tear everything down so another context can take over. */
  function stop () {
    stopped = true
    intervals.forEach(clearInterval)
    if (timer) clearInterval(timer)
    timer = null
    document.removeEventListener('visibilitychange', onVisibility)
    if (ws) { ws.onclose = null; try { ws.close() } catch (e) { /* ignore */ } }
    releaseWakeLock()
    cam.close()
    ch.close()
    log(`engine stopped in ${host}`)
  }

  // ---------- boot ----------
  // Retry until the plugin answers; UIs show configError meanwhile.
  while (!stopped) {
    try {
      S.cfg = await API.getClientConfig()
      S.mode = S.cfg.mode || 'off'
      S.configError = null
      break
    } catch (e) {
      S.configError = e.status === 401 || e.status === 403 ? 'auth' : (e.status === 404 || e.status === 503 ? 'disabled' : e.message)
      broadcast()
      await new Promise(r => setTimeout(r, 15000))
    }
  }
  if (stopped) return { snapshot, stop }
  await refreshStatus()
  startAuto()
  await reconcile()
  every(refreshStatus, STATUS_POLL_MS)
  log(`engine running in ${host}`)
  return { snapshot, stop }
}
