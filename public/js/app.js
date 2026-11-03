/* Tablet Camera Timelapse wrapper. Plain browser JS, no build step. */
(function () {
  'use strict'

  const PLUGIN_ID = 'signalk-tablet-camera-timelapse'
  const API = `/plugins/${PLUGIN_ID}`
  const MODES = ['off', 'auto', 'on']
  const LONG_PRESS_MS = 600
  const UPLOAD_RETRIES = 3
  const BUFFER_MAX = 6
  const STATUS_POLL_MS = 10000

  const $ = (id) => document.getElementById(id)
  const el = {
    iframe: $('hosted'),
    shield: $('fs-shield'),
    banner: $('banner'),
    toast: $('toast'),
    overlay: $('overlay'),
    btn: $('mode-btn'),
    dot: document.querySelector('#mode-btn .dot'),
    label: document.querySelector('#mode-btn .mode-label'),
    drawer: $('drawer'),
    drawerClose: $('drawer-close'),
    modeSeg: $('mode-seg'),
    autoDesc: $('auto-desc'),
    statusList: $('status-list'),
    cameraSelect: $('camera-select'),
    resSelect: $('res-select'),
    preview: $('preview'),
    testShot: $('test-shot'),
    testResult: $('test-result'),
    testImg: $('test-img'),
    estimate: $('estimate'),
    appSelect: $('app-select'),
    driveBox: $('drive-box'),
    installBtn: $('install-btn'),
    fsBtn: $('fs-btn'),
    reloadBtn: $('reload-btn')
  }

  // ---------- storage helpers (per-tablet prefs) ----------
  const prefs = {
    get (k, d) {
      try { const v = localStorage.getItem('sktl:' + k); return v === null ? d : JSON.parse(v) } catch (e) { return d }
    },
    set (k, v) {
      try { localStorage.setItem('sktl:' + k, JSON.stringify(v)) } catch (e) { /* private mode */ }
    }
  }

  // ---------- state ----------
  const S = {
    cfg: null,
    pluginOk: false,
    mode: 'off',
    status: null,
    auto: { active: false, raw: false, reason: 'missing' },
    evaluator: null,
    wsFirstValue: false,
    loadedAt: Date.now(),
    stream: null,
    track: null,
    imageCapture: null,
    photoCaps: null,
    cameraError: null,
    capturing: false, // capture loop actively shooting
    sessionId: null,
    sessionFrames: 0,
    totalFrames: 0,
    lastCaptureAt: null,
    lastCaptureBytes: null,
    busy: false,
    skipped: 0,
    buffer: [],
    uploadError: null,
    timer: null,
    wakeLock: null,
    hiddenAt: null,
    pausedFromHidden: false,
    drawerOpen: false,
    installPrompt: null,
    resolution: null
  }

  // ---------- small utils ----------
  function pad (n) { return String(n).padStart(2, '0') }
  function sessionIdNow () {
    const d = new Date() // local boat (tablet) time
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  }
  function fmtTime (t) {
    if (!t) return '—'
    const d = new Date(t)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }
  function fmtBytes (b) {
    if (b === null || b === undefined) return '—'
    if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB'
    if (b < 1024 * 1024 * 1024) return (b / 1048576).toFixed(1) + ' MB'
    return (b / 1073741824).toFixed(2) + ' GB'
  }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  function log (...a) { console.log('[timelapse]', ...a) }

  let toastTimer = null
  function toast (msg, ms = 4000) {
    el.toast.textContent = msg
    el.toast.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { el.toast.hidden = true }, ms)
  }

  function banner (html) {
    el.banner.querySelector('.banner-body').innerHTML = html
    el.banner.hidden = false
  }
  el.banner.querySelector('.banner-close').addEventListener('click', () => { el.banner.hidden = true })

  async function api (path, opts = {}) {
    const res = await fetch(API + path, { credentials: 'same-origin', ...opts })
    let body = null
    try { body = await res.json() } catch (e) { /* none */ }
    if (!res.ok) {
      const err = new Error((body && body.error) || `HTTP ${res.status}`)
      err.status = res.status
      err.body = body
      throw err
    }
    return body
  }

  // ---------- hosted app ----------
  function hostedUrl (name) {
    return '/' + String(name).replace(/^\/+|\/+$/g, '') + '/'
  }
  function setHostedApp (name) {
    const url = hostedUrl(name)
    if (el.iframe.getAttribute('src') !== url) el.iframe.setAttribute('src', url)
  }
  async function loadWebappList () {
    let list = []
    try {
      const r = await fetch('/skServer/webapps', { credentials: 'same-origin' })
      if (r.ok) {
        list = (await r.json()).map(w => ({ name: w.name, displayName: (w.signalk && w.signalk.displayName) || w.name }))
      }
    } catch (e) { /* fall through */ }
    if (!list.length) {
      try { list = await api('/webapps') } catch (e) { /* none */ }
    }
    list = list.filter(w => w.name !== PLUGIN_ID)
    const current = prefs.get('hostedApp', null) || (S.cfg && S.cfg.hostedWebapp) || '@signalk/freeboard-sk'
    if (!list.find(w => w.name === current)) list.unshift({ name: current, displayName: current })
    el.appSelect.innerHTML = ''
    for (const w of list) {
      const o = document.createElement('option')
      o.value = w.name
      o.textContent = w.displayName
      el.appSelect.appendChild(o)
    }
    el.appSelect.value = current
  }
  el.appSelect.addEventListener('change', () => {
    const v = el.appSelect.value
    // Remember a per-tablet override only if it differs from the server default.
    prefs.set('hostedApp', S.cfg && v === S.cfg.hostedWebapp ? null : v)
    setHostedApp(v)
  })

  // ---------- mode ----------
  function autoConfigured () { return !!(S.cfg && S.cfg.auto && S.cfg.auto.configured) }

  async function setMode (mode, { local = false } = {}) {
    if (!MODES.includes(mode)) return
    if (mode === 'auto' && !autoConfigured()) mode = 'off'
    const prev = S.mode
    S.mode = mode
    render()
    if (!local) {
      try {
        const r = await api('/mode', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) })
        S.mode = r.mode
      } catch (e) {
        S.mode = prev
        toast(`Could not change mode: ${e.message}${e.status === 401 || e.status === 403 ? ' (log in with read/write access)' : ''}`)
      }
    }
    await reconcile()
  }

  function cycleMode () {
    const order = autoConfigured() ? ['off', 'auto', 'on'] : ['off', 'on']
    const i = order.indexOf(S.mode)
    setMode(order[(i + 1) % order.length])
  }

  // ---------- overlay button: tap cycles, long-press opens drawer ----------
  ;(function bindButton () {
    let pressTimer = null
    let longFired = false
    el.btn.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      longFired = false
      clearTimeout(pressTimer)
      pressTimer = setTimeout(() => { longFired = true; openDrawer() }, LONG_PRESS_MS)
    })
    const end = (fire) => () => {
      clearTimeout(pressTimer)
      if (fire && !longFired) cycleMode()
      longFired = false
    }
    el.btn.addEventListener('pointerup', end(true))
    el.btn.addEventListener('pointercancel', end(false))
    el.btn.addEventListener('pointerleave', () => clearTimeout(pressTimer))
    el.btn.addEventListener('contextmenu', (e) => e.preventDefault())
    el.btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cycleMode() }
      if (e.key === 's') openDrawer()
    })
  })()

  el.modeSeg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]')
    if (b && !b.disabled) setMode(b.dataset.mode)
  })

  // ---------- should we be shooting right now? ----------
  function wantStream () {
    return S.mode === 'on' || S.mode === 'auto' || S.drawerOpen
  }
  function cacheBlocked () {
    return !!(S.status && S.status.ingestBlocked)
  }
  function shouldCapture () {
    if (document.visibilityState !== 'visible') return false
    if (cacheBlocked()) return false
    if (!window.isSecureContext) return false
    if (S.mode === 'on') return true
    if (S.mode === 'auto') return !!S.auto.active
    return false
  }
  function modeWantsCapture () {
    return S.mode === 'on' || (S.mode === 'auto' && S.auto.active)
  }

  // ---------- camera ----------
  function cameraKey () {
    return S.track ? (S.track.getSettings().deviceId || S.track.label) : 'default'
  }

  async function openStream () {
    if (S.stream) return true
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      S.cameraError = 'insecure'
      render()
      return false
    }
    const deviceId = prefs.get('cameraId', null)
    const res = deviceId ? prefs.get('res:' + deviceId, null) : null
    const hasImageCapture = typeof window.ImageCapture === 'function'
    const video = {}
    if (deviceId) video.deviceId = { exact: deviceId }
    else video.facingMode = { ideal: 'environment' }
    if (hasImageCapture) {
      // Stills come from takePhoto at full resolution; keep the preview stream modest.
      video.width = { ideal: 1920 }
      video.height = { ideal: 1080 }
    } else if (res) {
      video.width = { ideal: res.w }
      video.height = { ideal: res.h }
    } else {
      video.width = { ideal: 4096 }
      video.height = { ideal: 3072 }
    }
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false })
    } catch (e) {
      if (deviceId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
        prefs.set('cameraId', null) // camera vanished; fall back to rear
        return openStream()
      }
      S.cameraError = e.name === 'NotAllowedError' ? 'denied' : (e.message || e.name)
      render()
      return false
    }
    S.cameraError = null
    S.stream = stream
    S.track = stream.getVideoTracks()[0]
    S.imageCapture = null
    S.photoCaps = null
    if (hasImageCapture) {
      try {
        S.imageCapture = new ImageCapture(S.track)
        S.photoCaps = await S.imageCapture.getPhotoCapabilities()
      } catch (e) {
        log('ImageCapture unavailable, using canvas fallback:', e.message)
        S.imageCapture = null
      }
    }
    S.track.addEventListener('ended', () => {
      log('camera track ended')
      closeStream()
      reconcile()
    })
    if (S.drawerOpen) el.preview.srcObject = stream
    await populateCameras()
    populateResolutions()
    render()
    return true
  }

  function closeStream () {
    if (S.stream) S.stream.getTracks().forEach(t => t.stop())
    S.stream = null
    S.track = null
    S.imageCapture = null
    S.photoCaps = null
    el.preview.srcObject = null
  }

  async function populateCameras () {
    let devices = []
    try { devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput') } catch (e) { /* none */ }
    const current = S.track ? S.track.getSettings().deviceId : prefs.get('cameraId', null)
    el.cameraSelect.innerHTML = ''
    devices.forEach((d, i) => {
      const o = document.createElement('option')
      o.value = d.deviceId
      o.textContent = d.label || `Camera ${i + 1}`
      el.cameraSelect.appendChild(o)
    })
    if (current) el.cameraSelect.value = current
  }

  /** Candidate still sizes: max plus scaled-down steps at the same aspect. */
  function resolutionOptions () {
    const out = []
    const add = (w, h, src) => {
      w = Math.round(w); h = Math.round(h)
      if (w > 0 && h > 0 && !out.find(r => r.w === w && r.h === h)) out.push({ w, h, src })
    }
    if (S.photoCaps && S.photoCaps.imageWidth && S.photoCaps.imageWidth.max) {
      const W = S.photoCaps.imageWidth
      const H = S.photoCaps.imageHeight
      const step = (v, s) => (s && s.step ? Math.round(v / s.step) * s.step : v)
      for (const f of [1, 0.75, 0.5, 0.25]) {
        const w = step(W.max * f, W)
        const h = step(H.max * f, H)
        if (w >= (W.min || 1) && h >= (H.min || 1)) add(w, h, 'photo')
      }
    }
    if (!out.length && S.track && S.track.getCapabilities) {
      const c = S.track.getCapabilities()
      if (c.width && c.height) {
        for (const f of [1, 0.75, 0.5]) add(c.width.max * f, c.height.max * f, 'video')
      }
    }
    if (!out.length && S.track) {
      const s = S.track.getSettings()
      add(s.width, s.height, 'video')
    }
    return out
  }

  function populateResolutions () {
    const opts = resolutionOptions()
    el.resSelect.innerHTML = ''
    opts.forEach((r, i) => {
      const o = document.createElement('option')
      o.value = `${r.w}x${r.h}`
      o.textContent = `${r.w} × ${r.h}${i === 0 ? ' (max)' : ''}${r.src === 'video' ? ' · video frame' : ''}`
      el.resSelect.appendChild(o)
    })
    const saved = prefs.get('res:' + cameraKey(), null)
    const pick = saved && opts.find(r => r.w === saved.w && r.h === saved.h) ? saved : opts[0]
    S.resolution = pick || null
    if (pick) el.resSelect.value = `${pick.w}x${pick.h}`
  }

  el.cameraSelect.addEventListener('change', async () => {
    prefs.set('cameraId', el.cameraSelect.value || null)
    closeStream()
    await openStream()
    await reconcile()
  })
  el.resSelect.addEventListener('change', async () => {
    const [w, h] = el.resSelect.value.split('x').map(Number)
    S.resolution = { w, h }
    prefs.set('res:' + cameraKey(), { w, h })
    if (!S.imageCapture) {
      // Canvas fallback: resolution is the stream's, so reopen.
      closeStream()
      await openStream()
      await reconcile()
    }
    renderEstimate()
  })

  async function toJpeg (source, w, h, quality) {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    canvas.getContext('2d').drawImage(source, 0, 0, w, h)
    return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', quality))
  }

  let frameVideo = null
  async function grabVideoFrame () {
    if (!frameVideo) {
      frameVideo = document.createElement('video')
      frameVideo.muted = true
      frameVideo.playsInline = true
    }
    if (frameVideo.srcObject !== S.stream) {
      frameVideo.srcObject = S.stream
      await frameVideo.play().catch(() => {})
    }
    if (!frameVideo.videoWidth) await new Promise(r => frameVideo.addEventListener('loadedmetadata', r, { once: true }))
    const w = frameVideo.videoWidth
    const h = frameVideo.videoHeight
    return { blob: await toJpeg(frameVideo, w, h, S.cfg.jpegQuality), w, h }
  }

  async function takeFrame () {
    if (!S.stream && !(await openStream())) throw new Error('camera unavailable')
    if (S.imageCapture) {
      try {
        const settings = {}
        if (S.resolution && S.resolution.src === 'photo') {
          settings.imageWidth = S.resolution.w
          settings.imageHeight = S.resolution.h
        }
        let blob = await S.imageCapture.takePhoto(settings)
        let w = S.resolution ? S.resolution.w : null
        let h = S.resolution ? S.resolution.h : null
        if (blob.type !== 'image/jpeg') {
          const bmp = await createImageBitmap(blob)
          w = bmp.width; h = bmp.height
          blob = await toJpeg(bmp, w, h, S.cfg.jpegQuality)
        }
        return { blob, w, h, method: 'takePhoto' }
      } catch (e) {
        log('takePhoto failed, falling back to video frame:', e.message)
        if (e.name === 'InvalidStateError' && S.track && S.track.readyState === 'ended') throw e
      }
    }
    const f = await grabVideoFrame()
    return { ...f, method: 'canvas' }
  }

  async function uploadFrame (frame) {
    const q = new URLSearchParams({
      ts: frame.ts,
      session: frame.session,
      mode: frame.mode,
      device: frame.device || '',
      w: frame.w || '',
      h: frame.h || ''
    })
    let lastErr
    for (let i = 0; i < UPLOAD_RETRIES; i++) {
      try {
        const res = await fetch(`${API}/frames?${q}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'image/jpeg' },
          body: frame.blob
        })
        let body = null
        try { body = await res.json() } catch (e) { /* none */ }
        if (res.status === 507) {
          const err = new Error(body && body.error === 'disk_low' ? 'Pi disk space low' : 'Pi cache full')
          err.status = 507
          err.code = body && body.error
          throw err
        }
        if (res.status === 401 || res.status === 403) {
          const err = new Error('Not authorized to upload (needs read/write login)')
          err.status = res.status
          throw err
        }
        if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`)
        return body
      } catch (e) {
        lastErr = e
        if (e.status === 507 || e.status === 401 || e.status === 403) throw e
        await sleep(1000 * Math.pow(2, i))
      }
    }
    throw lastErr
  }

  async function flushBuffer () {
    while (S.buffer.length) {
      const f = S.buffer[0]
      await uploadFrame(f)
      S.buffer.shift()
    }
  }

  async function captureTick () {
    if (!shouldCapture() || !S.sessionId) return
    if (S.busy) {
      S.skipped++
      log(`tick skipped: previous capture/upload still in flight (${S.skipped} skipped)`)
      return
    }
    S.busy = true
    try {
      if (S.buffer.length) await flushBuffer()
      const ts = new Date().toISOString()
      const f = await takeFrame()
      const frame = { ...f, ts, session: S.sessionId, mode: S.mode, device: S.track ? S.track.label : '' }
      S.lastCaptureAt = Date.now()
      S.lastCaptureBytes = f.blob.size
      try {
        const r = await uploadFrame(frame)
        S.sessionFrames++
        S.totalFrames++
        prefs.set('session', { id: frame.session, lastAt: Date.now() })
        S.uploadError = null
        if (r && r.cacheFull) refreshStatus()
      } catch (e) {
        S.uploadError = e.message
        if (e.status === 507) {
          refreshStatus()
        } else if (e.status !== 401 && e.status !== 403) {
          S.buffer.push(frame)
          if (S.buffer.length > BUFFER_MAX) S.buffer.shift()
        }
      }
    } catch (e) {
      S.uploadError = S.buffer.length ? `${S.buffer.length} frame(s) waiting: ${e.message}` : e.message
      log('capture failed:', e.message)
    } finally {
      S.busy = false
      render()
    }
  }

  // ---------- wake lock ----------
  async function acquireWakeLock () {
    if (!('wakeLock' in navigator) || S.wakeLock || document.visibilityState !== 'visible') return
    try {
      S.wakeLock = await navigator.wakeLock.request('screen')
      S.wakeLock.addEventListener('release', () => { S.wakeLock = null })
    } catch (e) { log('wake lock failed:', e.message) }
  }
  function releaseWakeLock () {
    if (S.wakeLock) S.wakeLock.release().catch(() => {})
    S.wakeLock = null
  }

  // ---------- reconcile stream/timer/session with desired state ----------
  let reconciling = Promise.resolve()
  function reconcile () {
    reconciling = reconciling.then(doReconcile, doReconcile)
    return reconciling
  }
  async function doReconcile () {
    // Session lifetime follows the mode/auto decision, not visibility or cache pauses.
    const wants = modeWantsCapture()
    if (wants && !S.sessionId) {
      // Resume the previous session after a reload or short interruption so
      // one passage stays in one folder.
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
      prefs.set('session', null)
    }

    if (wantStream() && document.visibilityState === 'visible') {
      if (!S.stream) await openStream()
    } else if (S.stream && !S.drawerOpen) {
      closeStream()
    }

    const shoot = shouldCapture() && !!S.stream
    if (shoot && !S.timer) {
      S.timer = setInterval(captureTick, S.cfg.intervalSeconds * 1000)
      captureTick()
    } else if (!shoot && S.timer) {
      clearInterval(S.timer)
      S.timer = null
    }
    S.capturing = shoot
    if (shoot) acquireWakeLock()
    else releaseWakeLock()
    render()
  }

  // ---------- visibility ----------
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (S.capturing) { S.hiddenAt = Date.now(); S.pausedFromHidden = true }
      // Close the camera while hidden; Chrome would stall it anyway.
      if (S.timer) { clearInterval(S.timer); S.timer = null }
      closeStream()
      S.capturing = false
      S.wakeLock = null
    } else {
      if (S.pausedFromHidden) {
        toast(`Capture was paused while the screen was hidden (${fmtTime(S.hiddenAt)} – ${fmtTime(Date.now())}). Resuming.`, 7000)
        S.pausedFromHidden = false
      }
      refreshStatus()
      reconcile()
    }
  })

  // ---------- Auto: websocket subscription ----------
  let ws = null
  let wsBackoff = 1000
  function connectWs () {
    if (!autoConfigured()) return
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    try {
      ws = new WebSocket(`${proto}//${location.host}/signalk/v1/stream?subscribe=none`)
    } catch (e) { return scheduleWs() }
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
            S.wsFirstValue = true
            S.auto = S.evaluator.update(v.value)
          }
        }
      }
      onAutoChange()
    }
    ws.onclose = () => { ws = null; scheduleWs() }
    ws.onerror = () => { try { ws.close() } catch (e) { /* ignore */ } }
  }
  function scheduleWs () {
    setTimeout(connectWs, wsBackoff)
    wsBackoff = Math.min(30000, wsBackoff * 2)
  }

  let lastAutoActive = false
  function onAutoChange () {
    if (S.auto.active !== lastAutoActive) {
      lastAutoActive = S.auto.active
      if (S.mode === 'auto') reconcile()
    }
    if (S.drawerOpen) renderDrawer()
  }

  function startAutoEval () {
    if (!autoConfigured()) return
    S.evaluator = TimelapseAuto.createEvaluator(S.cfg.auto)
    // Seed from the server's debounced state so a reload mid-session does not wait out the debounce again.
    const sa = S.status && S.status.auto
    if (sa && sa.configured && sa.active) S.evaluator.seed(true, Date.parse(sa.activeSince) || Date.now())
    S.auto = S.evaluator.evaluate()
    setInterval(() => {
      // Give the websocket a few seconds to deliver the cached value before
      // treating the path as missing.
      if (!S.wsFirstValue && Date.now() - S.loadedAt < 8000) return
      S.auto = S.evaluator.evaluate()
      onAutoChange()
    }, 1000)
    connectWs()
  }

  // ---------- server status ----------
  async function refreshStatus () {
    try {
      S.status = await api('/status')
      S.pluginOk = true
      if (S.status.mode !== S.mode) {
        // Another client changed the mode.
        S.mode = S.status.mode
        reconcile()
      } else if (S.capturing !== shouldCapture()) {
        reconcile()
      }
    } catch (e) {
      S.status = null
    }
    render()
  }

  // ---------- rendering ----------
  function errorState () {
    if (S.mode === 'off') {
      if (S.status && S.status.ingestBlocked === 'disk_low') return 'Pi disk space low'
      return null
    }
    if (!window.isSecureContext) return 'Insecure context: camera blocked'
    if (S.cameraError === 'denied') return 'Camera permission denied'
    if (S.cameraError && S.cameraError !== 'insecure') return `Camera: ${S.cameraError}`
    if (S.status && S.status.ingestBlocked === 'cache_full') return 'Cache full on the Pi'
    if (S.status && S.status.ingestBlocked === 'disk_low') return 'Pi disk space low'
    if (S.uploadError) return S.uploadError
    if (S.status && S.status.drive && S.status.drive.enabled && S.status.queue && S.status.queue.count > 0) {
      const a = S.status.drive.auth.state
      if (a === 'needs_auth' || a === 'unauthorized' || a === 'unconfigured') return 'Upload backlog: Drive not authorized'
    }
    if (!S.pluginOk) return 'Plugin not reachable'
    return null
  }

  function dotState () {
    if (errorState()) return 'error'
    if (S.mode === 'off') return 'off'
    if (S.capturing) return 'capturing'
    return 'waiting'
  }

  function render () {
    const ds = dotState()
    el.dot.dataset.state = ds
    el.label.textContent = S.mode.toUpperCase()
    const err = errorState()
    el.btn.title = `Timelapse: ${S.mode}${err ? ' — ' + err : ''}. Tap to change, hold for settings.`
    el.btn.setAttribute('aria-label', el.btn.title)
    for (const b of el.modeSeg.querySelectorAll('button')) {
      b.setAttribute('aria-checked', String(b.dataset.mode === S.mode))
      if (b.dataset.mode === 'auto') b.disabled = !autoConfigured()
    }
    if (S.drawerOpen) renderDrawer()
  }

  function kv (rows) {
    el.statusList.innerHTML = ''
    for (const [k, v, warn] of rows) {
      const dt = document.createElement('dt')
      dt.textContent = k
      const dd = document.createElement('dd')
      dd.textContent = v
      if (warn) dd.className = 'warn'
      el.statusList.append(dt, dd)
    }
  }

  function autoText (a) {
    if (!a) return '—'
    if (a.reason === 'missing') return 'no data'
    if (a.reason === 'stale') return 'stale'
    if (a.reason === 'null') return 'null'
    let s = a.active ? 'active' : 'inactive'
    if (a.pendingTarget !== null && a.pendingTarget !== undefined) s += ` → ${a.pendingTarget ? 'active' : 'inactive'} in ${Math.ceil(a.pendingRemainingMs / 1000)}s`
    return s
  }

  function renderDrawer () {
    const st = S.status
    const a = S.cfg && S.cfg.auto
    el.autoDesc.textContent = autoConfigured()
      ? `Auto: ${a.autoPath} ${a.autoOperator === 'equals' ? '=' : '≠'} "${a.autoValue}"${a.autoCaseSensitive ? ' (case-sensitive)' : ''}, debounce ${a.autoDebounceSeconds}s, stale ${a.autoStaleSeconds ? a.autoStaleSeconds + 's' : 'off'}`
      : 'Auto is not configured (set autoPath in the plugin config).'
    const err = errorState()
    const rows = [
      ['State', S.capturing ? `capturing every ${S.cfg.intervalSeconds}s` : (S.mode === 'off' ? 'off' : (shouldCapture() ? 'starting' : 'waiting'))],
      ['Problem', err || 'none', !!err],
      ['Session', S.sessionId || '—'],
      ['Frames this session', String(S.sessionFrames)],
      ['Last capture', S.lastCaptureAt ? `${fmtTime(S.lastCaptureAt)} · ${fmtBytes(S.lastCaptureBytes)}` : '—'],
      ['Skipped ticks', String(S.skipped)]
    ]
    if (autoConfigured()) {
      rows.push(['Auto (tablet)', autoText(S.auto)])
      rows.push(['Auto (server)', st ? autoText(st.auto) : '—'])
      if (S.auto && S.auto.lastValue !== null && S.auto.lastValue !== undefined) rows.push(['Auto value', String(typeof S.auto.lastValue === 'object' ? JSON.stringify(S.auto.lastValue) : S.auto.lastValue)])
    }
    if (st) {
      rows.push(['Server queue', `${st.queue.count} files · ${fmtBytes(st.queue.bytes)}`])
      rows.push(['Pi cache', `${fmtBytes(st.cache.bytes)}${st.cache.maxBytes ? ' / ' + fmtBytes(st.cache.maxBytes) : ''}`, st.cache.full])
      rows.push(['Pi free disk', fmtBytes(st.disk.freeBytes), st.disk.low])
      rows.push(['Last upload', st.drive.uploader && st.drive.uploader.lastUploadAt ? fmtTime(st.drive.uploader.lastUploadAt) : '—'])
      rows.push(['Drive', st.drive.enabled ? `${st.drive.auth.state.replace('_', ' ')}${st.drive.uploader ? ' · ' + st.drive.uploader.state.replace('_', ' ') : ''}` : 'disabled'])
    } else {
      rows.push(['Server', 'unreachable', true])
    }
    kv(rows)
    renderEstimate()
    renderDrive()
    el.installBtn.hidden = !S.installPrompt || isInstalled()
  }

  function renderEstimate () {
    if (!S.cfg) return
    const perHour = Math.round(3600 / S.cfg.intervalSeconds)
    const bytes = S.lastCaptureBytes || (S.status && S.status.avgFrameBytes) || 3 * 1048576
    const measured = !!(S.lastCaptureBytes || (S.status && S.status.avgFrameBytes))
    el.estimate.textContent = `${perHour} frames/hour at ${S.cfg.intervalSeconds}s ≈ ${fmtBytes(perHour * bytes)}/hour (${measured ? 'measured' : 'assumed'} ${fmtBytes(bytes)}/frame).`
  }

  let drivePollTimer = null
  function renderDrive () {
    const st = S.status
    const box = el.driveBox
    if (!st) { box.textContent = 'Server unreachable.'; return }
    if (!st.drive.enabled) { box.innerHTML = '<p class="hint">Drive upload is disabled in the plugin config. Frames stay on the Pi.</p>'; return }
    const a = st.drive.auth
    const sig = JSON.stringify(a)
    if (box.dataset.sig === sig) return
    box.dataset.sig = sig
    box.innerHTML = ''
    const p = (html, cls) => { const e = document.createElement('p'); e.className = cls || 'hint'; e.innerHTML = html; box.appendChild(e); return e }
    const btn = (text, fn, cls) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; if (cls) b.className = cls; b.addEventListener('click', fn); box.appendChild(b); return b }
    if (a.state === 'unconfigured') {
      p('Enter a Google OAuth client ID and secret in the plugin config (Server → Plugin Config). See the README.')
    } else if (a.state === 'pending') {
      p(`On your phone, open <a href="${a.verificationUrl}" target="_blank" rel="noopener">${a.verificationUrl}</a> and enter:`)
      p(a.userCode, 'code')
      p(`Code expires ${fmtTime(a.expiresAt)}.`)
      btn('Cancel', () => api('/drive/auth/revoke', { method: 'POST' }).then(refreshStatus))
      startDrivePoll()
    } else if (a.state === 'authorized') {
      p(`Connected${a.authorizedAt ? ' since ' + new Date(a.authorizedAt).toLocaleDateString() : ''}. Folder: <b>${escapeHtml(st.drive.folderName)}</b>`)
      const row = document.createElement('div'); row.className = 'row'; box.appendChild(row)
      const up = btn('Upload now', () => api('/drive/upload-now', { method: 'POST' }).then(() => toast('Upload pass started')).catch(e => toast(e.message)))
      const rv = btn('Disconnect', () => { if (confirm('Disconnect Google Drive? Queued frames stay on the Pi.')) api('/drive/auth/revoke', { method: 'POST' }).then(refreshStatus).catch(e => toast(e.message)) })
      row.append(up, rv)
    } else {
      if (a.state === 'needs_auth') p('Drive authorization expired or was revoked. Reconnect to resume uploads.', 'hint')
      if (a.error) p(escapeHtml(a.error))
      btn('Connect Google Drive', () => api('/drive/auth/start', { method: 'POST' }).then(r => { S.status.drive.auth = r; renderDrive() }).catch(e => toast(e.message)), 'primary')
    }
  }
  function startDrivePoll () {
    if (drivePollTimer) return
    drivePollTimer = setInterval(async () => {
      try {
        const a = await api('/drive/auth/poll')
        if (S.status) S.status.drive.auth = a
        if (a.state !== 'pending') {
          clearInterval(drivePollTimer)
          drivePollTimer = null
          if (a.state === 'authorized') toast('Google Drive connected')
          refreshStatus()
        }
        renderDrive()
      } catch (e) { /* keep trying */ }
    }, 3000)
  }
  function escapeHtml (s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  }

  // ---------- drawer ----------
  async function openDrawer () {
    S.drawerOpen = true
    el.drawer.hidden = false
    refreshStatus()
    loadWebappList()
    await reconcile()
    if (S.stream) el.preview.srcObject = S.stream
    renderDrawer()
  }
  function closeDrawer () {
    S.drawerOpen = false
    el.drawer.hidden = true
    el.preview.srcObject = null
    if (drivePollTimer) { clearInterval(drivePollTimer); drivePollTimer = null }
    reconcile()
  }
  el.drawerClose.addEventListener('click', closeDrawer)

  el.testShot.addEventListener('click', async () => {
    el.testShot.disabled = true
    el.testResult.textContent = 'Capturing…'
    try {
      while (S.busy) await sleep(100)
      S.busy = true
      const ts = new Date().toISOString()
      const t0 = performance.now()
      const f = await takeFrame()
      const t1 = performance.now()
      const r = await uploadFrame({ ...f, ts, session: 'test-shots', mode: 'test', device: S.track ? S.track.label : '' })
      el.testImg.src = URL.createObjectURL(f.blob)
      el.testImg.hidden = false
      el.testImg.onload = () => {
        el.testResult.textContent = `${el.testImg.naturalWidth}×${el.testImg.naturalHeight} · ${fmtBytes(f.blob.size)} · ${f.method} ${Math.round(t1 - t0)} ms · saved ${r.file}`
        URL.revokeObjectURL(el.testImg.src)
      }
      S.lastCaptureBytes = f.blob.size
      refreshStatus()
    } catch (e) {
      el.testResult.textContent = `Failed: ${e.message}`
    } finally {
      S.busy = false
      el.testShot.disabled = false
    }
  })

  // ---------- fullscreen / install ----------
  function isInstalled () {
    return matchMedia('(display-mode: fullscreen)').matches || matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
  }
  function goFullscreen () {
    const d = document.documentElement
    if (!document.fullscreenElement && d.requestFullscreen) d.requestFullscreen({ navigationUI: 'hide' }).catch(() => {})
  }
  function armFullscreenShield () {
    // The iframe swallows touches, so a transparent shield catches the first
    // tap, requests fullscreen and removes itself.
    if (!S.cfg || S.cfg.displayMode !== 'fullscreen' || isInstalled() || document.fullscreenElement) {
      el.shield.hidden = true
      return
    }
    if (!document.documentElement.requestFullscreen) return
    el.shield.hidden = false
  }
  el.shield.addEventListener('pointerdown', () => {
    el.shield.hidden = true
    goFullscreen()
  })
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) armFullscreenShield()
  })
  el.fsBtn.addEventListener('click', goFullscreen)
  el.reloadBtn.addEventListener('click', () => location.reload())
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    S.installPrompt = e
    render()
  })
  window.addEventListener('appinstalled', () => { S.installPrompt = null; render() })
  el.installBtn.addEventListener('click', async () => {
    if (!S.installPrompt) return
    S.installPrompt.prompt()
    try { await S.installPrompt.userChoice } catch (e) { /* ignore */ }
    S.installPrompt = null
    render()
  })

  // ---------- secure-context banner ----------
  function checkSecureContext () {
    if (window.isSecureContext) return
    if (prefs.get('dismissedInsecure', false) && prefs.get('dismissedInsecureOrigin', '') === location.origin) return
    const origin = location.origin
    banner(`<b>Camera blocked: this page is not a secure context.</b><br>
      Chrome only allows the camera on HTTPS or on origins you mark as trusted. Pick one:<br>
      <b>(a) Recommended for one dedicated tablet:</b> open <code>chrome://flags/#unsafely-treat-insecure-origin-as-secure</code>, add <code>${escapeHtml(origin)}</code>, set it to Enabled, and restart Chrome.<br>
      <b>(b)</b> Enable HTTPS in the Signal K server (a locally trusted CA works best; self-signed certificates are clumsy in Chrome).`)
    el.banner.querySelector('.banner-close').addEventListener('click', () => {
      prefs.set('dismissedInsecure', true)
      prefs.set('dismissedInsecureOrigin', origin)
    }, { once: true })
  }

  // ---------- boot ----------
  async function boot () {
    checkSecureContext()
    if ('serviceWorker' in navigator && window.isSecureContext) {
      navigator.serviceWorker.register('sw.js').catch(e => log('service worker:', e.message))
    }
    try {
      S.cfg = await api('/config/client')
      S.pluginOk = true
    } catch (e) {
      S.cfg = { hostedWebapp: '@signalk/freeboard-sk', buttonCorner: 'bottom-left', intervalSeconds: 10, jpegQuality: 0.85, displayMode: 'fullscreen', auto: { configured: false }, mode: 'off' }
      if (e.status === 401 || e.status === 403) {
        banner('Timelapse: not logged in to Signal K (or the plugin needs a read/write user). <a href="/admin/#/login" target="_top">Log in</a>, then reload.')
      } else {
        banner(`Timelapse plugin is not reachable (${escapeHtml(e.message)}). Enable it under Server → Plugin Config.`)
      }
    }
    el.overlay.className = `overlay corner-${S.cfg.buttonCorner || 'bottom-left'}`
    setHostedApp(prefs.get('hostedApp', null) || S.cfg.hostedWebapp)
    S.mode = S.cfg.mode || 'off'
    await refreshStatus()
    startAutoEval()
    armFullscreenShield()
    render()
    await reconcile()
    setInterval(refreshStatus, STATUS_POLL_MS)
  }

  boot()
})()
