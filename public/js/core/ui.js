// Shared UI for every host: an engine client, the status derivation, the full
// settings view and the compact control. Visuals come from CSS variables in
// css/ui.css that each host adapter sets to match its host's theme.

import * as API from './api.js'
import { openChannel, ENGINE_STALE_MS } from './protocol.js'

const MODES = ['off', 'auto', 'on']

// ---------- engine client ----------
export function createEngineClient () {
  const listeners = new Set()
  const pending = new Map()
  let state = null
  let lastAt = 0
  const ch = openChannel((m) => {
    if (m.t === 'state') {
      state = m.s
      lastAt = Date.now()
      listeners.forEach(fn => fn(state))
    } else if (m.t === 'testResult' && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  })
  ch.postMessage({ t: 'hello' })
  // Tell listeners when the engine goes quiet.
  setInterval(() => { if (state && !alive()) listeners.forEach(fn => fn(state)) }, 2000)

  function alive () { return Date.now() - lastAt < ENGINE_STALE_MS }

  return {
    get state () { return state },
    alive,
    onState (fn) { listeners.add(fn); if (state) fn(state); return () => listeners.delete(fn) },
    send (m) { ch.postMessage(m) },
    testShot () {
      const id = Math.random().toString(36).slice(2)
      return new Promise((resolve) => {
        pending.set(id, resolve)
        ch.postMessage({ t: 'testShot', id })
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ ok: false, error: 'no answer from the capture engine' }) } }, 30000)
      })
    },
    /** Change mode on the server (shared by all tablets), then poke the engine. */
    async setMode (mode) {
      await API.setMode(mode)
      ch.postMessage({ t: 'refresh' })
    },
    async cycleMode () {
      const s = state
      const autoOk = !!(s && s.cfg && s.cfg.auto && s.cfg.auto.configured)
      const order = autoOk ? MODES : ['off', 'on']
      const cur = s ? s.mode : 'off'
      const next = order[(order.indexOf(cur) + 1) % order.length]
      await this.setMode(next)
      return next
    }
  }
}

// ---------- status derivation (one place for every host) ----------
export function describe (s, alive = true) {
  if (!s) return { dot: 'off', mode: 'off', label: 'OFF', problem: 'Starting…', detail: null }
  const mode = s.mode || 'off'
  let problem = null
  if (!alive) problem = 'Capture engine not running on this tablet'
  else if (s.configError === 'auth' || s.statusError === 'auth') problem = 'Log in to Signal K with a read/write user'
  else if (s.configError === 'disabled') problem = 'Timelapse plugin is disabled'
  else if (s.configError) problem = `Plugin unreachable: ${s.configError}`
  else if (mode !== 'off' && !s.secure) problem = 'Camera blocked: not a secure context'
  else if (mode !== 'off' && s.camera.error === 'denied') problem = 'Camera permission denied'
  else if (mode !== 'off' && s.camera.error && s.camera.error !== 'insecure') problem = `Camera: ${s.camera.error}`
  else if (s.status && s.status.ingestBlocked === 'disk_low') problem = 'Pi disk space low'
  else if (mode !== 'off' && s.status && s.status.ingestBlocked === 'cache_full') problem = 'Pi cache full, waiting for uploads'
  else if (mode !== 'off' && s.uploadError) problem = s.uploadError
  else if (s.status && s.status.drive.enabled && s.status.queue && s.status.queue.count > 0 &&
    ['needs_auth', 'unauthorized', 'unconfigured'].includes(s.status.drive.auth.state)) problem = 'Upload backlog: Google Drive not connected'
  else if (s.status && s.status.drive.uploader && s.status.drive.uploader.state === 'drive_full') problem = 'Google Drive is full'
  else if (s.statusError) problem = `Server: ${s.statusError}`
  let dot = 'off'
  if (problem) dot = 'error'
  else if (mode === 'off') dot = 'off'
  else if (s.capturing) dot = 'capturing'
  else dot = 'waiting'
  let detail
  if (mode === 'off') detail = 'Off'
  else if (s.capturing) detail = `Capturing every ${s.cfg ? s.cfg.intervalSeconds : '?'} s`
  else if (mode === 'auto') detail = autoText(s.auto, true)
  else detail = 'Waiting'
  return { dot, mode, label: mode.toUpperCase(), problem, detail }
}

function autoText (a, long) {
  if (!a) return '—'
  if (a.reason === 'missing') return long ? 'Auto: no data yet' : 'no data'
  if (a.reason === 'stale') return long ? 'Auto: data stale' : 'stale'
  if (a.reason === 'null') return long ? 'Auto: value is null' : 'null'
  let t = a.active ? 'active' : 'waiting'
  if (a.pendingTarget !== null && a.pendingTarget !== undefined) t += ` → ${a.pendingTarget ? 'active' : 'off'} in ${Math.ceil(a.pendingRemainingMs / 1000)} s`
  return long ? `Auto: ${t}` : t
}

// ---------- helpers ----------
export function fmtTime (t) {
  if (!t) return '—'
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
export function fmtBytes (b) {
  if (b === null || b === undefined) return '—'
  if (b < 1048576) return (b / 1024).toFixed(0) + ' KB'
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB'
  return (b / 1073741824).toFixed(2) + ' GB'
}
function h (tag, attrs = {}, ...kids) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') e.className = v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else if (k === 'text') e.textContent = v
    else e.setAttribute(k, v === true ? '' : v)
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c)
  return e
}
function escapeHtml (s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

const CAMERA_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 4.5 7.6 6.5H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-2.6L15 4.5H9Zm3 4a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Zm0 1.8a2.7 2.7 0 1 0 0 5.4 2.7 2.7 0 0 0 0-5.4Z"/></svg>'

/**
 * Still-size picker entries: Lowest and Highest (which follow the camera in
 * use), then each exact size this camera offers.
 */
export function resolutionOptions (list) {
  if (!list.length) return []
  const area = (r) => r.w * r.h
  const sorted = [...list].sort((a, b) => area(b) - area(a))
  const dims = (r) => `${r.w} × ${r.h}${r.src === 'video' ? ' · video frame' : ''}`
  return [
    { value: 'lowest', text: `Lowest (${dims(sorted[sorted.length - 1])})` },
    { value: 'highest', text: `Highest (${dims(sorted[0])})` },
    ...sorted.map(r => ({ value: `${r.w}x${r.h}`, text: dims(r) }))
  ]
}

export function resolutionValue (c) {
  if (c.resChoice === 'lowest' || c.resChoice === 'highest') return c.resChoice
  return c.resolution ? `${c.resolution.w}x${c.resolution.h}` : 'lowest'
}

export function insecureHelp () {
  return `Chrome only allows the camera on HTTPS or on an origin you trust. On a dedicated tablet, open <code>chrome://flags/#unsafely-treat-insecure-origin-as-secure</code>, add <code>${escapeHtml(location.origin)}</code>, enable it and restart Chrome. Otherwise enable HTTPS on the Signal K server with a locally trusted CA.`
}

// ---------- in-page dialog ----------
/**
 * Ask a question in the page itself. confirm() is unavailable inside
 * Freeboard's sandboxed extension frames (no allow-modals).
 * buttons: [{ label, value, kind: 'primary'|'danger'|undefined }]. Resolves
 * the chosen value, or null when dismissed.
 */
export function ask (message, buttons = [{ label: 'Cancel', value: null }, { label: 'OK', value: true, kind: 'primary' }], { detail } = {}) {
  return new Promise((resolve) => {
    const done = (v) => { overlay.remove(); resolve(v) }
    const overlay = h('div', { class: 'tl-dialog-backdrop', onclick: (e) => { if (e.target === overlay) done(null) } },
      h('div', { class: 'tl-dialog', role: 'dialog', 'aria-modal': 'true' },
        h('p', { class: 'tl-dialog-msg', text: message }),
        detail ? h('p', { class: 'tl-hint', text: detail }) : null,
        h('div', { class: 'tl-dialog-buttons' },
          ...buttons.map(b => h('button', { type: 'button', class: b.kind === 'primary' ? 'tl-primary' : (b.kind === 'danger' ? 'tl-danger' : null), text: b.label, onclick: () => done(b.value) })))))
    document.body.append(overlay)
    overlay.querySelector('.tl-dialog-buttons button:last-child').focus()
  })
}

// ---------- compact control (widget tiles) ----------
/**
 * A round mode button with a status dot, a label and one status line.
 * Tap cycles the mode; long-press calls onLongPress.
 */
export function mountCompact (root, client, { onLongPress, showLine = true } = {}) {
  const btn = h('button', { class: 'tl-mode-btn', type: 'button' })
  btn.innerHTML = CAMERA_SVG + '<span class="tl-mode-label">OFF</span><span class="tl-dot" data-state="off"></span>'
  const line = h('div', { class: 'tl-compact-line' })
  root.classList.add('tl-compact')
  root.append(btn)
  if (showLine) root.append(line)

  let pressTimer = null
  let long = false
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    long = false
    clearTimeout(pressTimer)
    pressTimer = setTimeout(() => { long = true; if (onLongPress) onLongPress() }, 700)
  })
  btn.addEventListener('pointerup', () => {
    clearTimeout(pressTimer)
    if (!long) client.cycleMode().catch(e => flash(e.status === 401 || e.status === 403 ? 'Needs a read/write login' : e.message))
  })
  btn.addEventListener('pointercancel', () => clearTimeout(pressTimer))
  btn.addEventListener('pointerleave', () => clearTimeout(pressTimer))
  btn.addEventListener('contextmenu', (e) => e.preventDefault())

  let flashUntil = 0
  function flash (msg) { line.textContent = msg; flashUntil = Date.now() + 4000 }

  function render (s) {
    const d = describe(s, client.alive())
    btn.querySelector('.tl-dot').dataset.state = d.dot
    btn.querySelector('.tl-mode-label').textContent = d.label
    btn.title = `Timelapse ${d.mode}${d.problem ? ': ' + d.problem : ''}. Tap to change${onLongPress ? ', hold for settings' : ''}.`
    btn.setAttribute('aria-label', btn.title)
    if (Date.now() > flashUntil) {
      line.textContent = d.problem || d.detail
      line.classList.toggle('tl-warn', !!d.problem)
    }
  }
  client.onState(render)
  render(client.state)
  return { render }
}

// ---------- full settings view ----------
const STAMPS = [
  ['off', 'Off'],
  ['bottom-left', 'Bottom left'],
  ['bottom-right', 'Bottom right'],
  ['top-left', 'Top left'],
  ['top-right', 'Top right']
]

export function mountSettings (root, client, { openGallery } = {}) {
  root.classList.add('tl-settings')
  root.innerHTML = ''

  const modeSeg = h('div', { class: 'tl-seg', role: 'radiogroup', 'aria-label': 'Mode' },
    ...MODES.map(m => h('button', { type: 'button', 'data-mode': m, role: 'radio', text: m[0].toUpperCase() + m.slice(1) })))
  modeSeg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]')
    if (b && !b.disabled) client.setMode(b.dataset.mode).catch(err => toast(err.status === 401 || err.status === 403 ? 'Changing the mode needs a read/write login' : err.message))
  })
  const autoDesc = h('p', { class: 'tl-hint' })
  const problem = h('div', { class: 'tl-banner', hidden: true })
  const statusList = h('dl', { class: 'tl-kv' })

  const camSel = h('select', { 'aria-label': 'Camera' })
  const resSel = h('select', { 'aria-label': 'Resolution' })
  camSel.addEventListener('change', () => client.send({ t: 'setCamera', id: camSel.value }))
  resSel.addEventListener('change', () => {
    if (resSel.value === 'lowest' || resSel.value === 'highest') return client.send({ t: 'setResolution', choice: resSel.value })
    const [w, hh] = resSel.value.split('x').map(Number)
    client.send({ t: 'setResolution', w, h: hh })
  })
  // Capture settings live on the Pi (shared by every tablet, kept across
  // reloads). Saved on change; the engine picks them up at once.
  const intervalIn = h('input', { type: 'number', min: 1, max: 3600, step: 1, inputmode: 'decimal', 'aria-label': 'Interval in seconds' })
  const stampSel = h('select', { 'aria-label': 'Timestamp' })
  for (const [v, t] of STAMPS) stampSel.append(h('option', { value: v, text: t }))
  const saveFail = (e) => toast(e.status === 401 || e.status === 403 ? 'Changing settings needs a read/write login' : e.message)
  async function saveSetting (patch) {
    try {
      await API.putSettings(patch)
      client.send({ t: 'refresh' })
    } catch (e) {
      saveFail(e)
      if (client.state) render(client.state) // put the stored value back
    }
  }
  intervalIn.addEventListener('change', () => {
    const v = Number(intervalIn.value)
    if (!(v >= 1 && v <= 3600)) { toast('Interval must be 1 to 3600 s'); return render(client.state) }
    saveSetting({ intervalSeconds: v })
  })
  stampSel.addEventListener('change', () => saveSetting({ stamp: stampSel.value }))

  const testBtn = h('button', { type: 'button', class: 'tl-primary', text: 'Take test photo' })
  const testResult = h('span', { class: 'tl-hint' })
  const testImg = h('img', { class: 'tl-test-img', alt: 'Last test shot', hidden: true })
  const estimate = h('p', { class: 'tl-hint' })
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true
    testResult.textContent = 'Capturing…'
    const r = await client.testShot()
    testBtn.disabled = false
    if (!r.ok) { testResult.textContent = `Failed: ${r.error}`; return }
    const url = URL.createObjectURL(r.blob)
    testImg.onload = () => {
      testResult.textContent = `${testImg.naturalWidth}×${testImg.naturalHeight} · ${fmtBytes(r.bytes)} · ${r.method} ${r.ms} ms · saved ${r.file}`
      URL.revokeObjectURL(url)
    }
    testImg.src = url
    testImg.hidden = false
  })

  // ---------- Google Drive ----------
  const driveBox = h('div') // connection state: connect, code, connected
  const driveOn = h('input', { type: 'checkbox' })
  const shareCb = h('input', { type: 'checkbox' })
  const folderIn = h('input', { type: 'text', maxlength: 100, 'aria-label': 'Drive folder' })
  const afterSel = h('select', { 'aria-label': 'After upload' })
  for (const [v, t] of [['move', 'Keep on the Pi for a while, then delete'], ['delete', 'Delete from the Pi right away'], ['keep', 'Keep on the Pi forever']]) afterSel.append(h('option', { value: v, text: t }))
  const keepIn = h('input', { type: 'number', min: 0, max: 3650, step: 1, 'aria-label': 'Days to keep on the Pi' })
  const keepLabel = h('label', {}, 'Days to keep on the Pi', keepIn)
  const ownCb = h('input', { type: 'checkbox' })
  const ownIdIn = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Client ID' })
  const ownSecretIn = h('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Client secret' })
  const ownSave = h('button', { type: 'button', text: 'Save credentials' })
  const driveOpts = h('div', {},
    h('label', { class: 'tl-check' }, shareCb, 'Anyone with the link can view'),
    h('p', { class: 'tl-hint', text: 'Each session folder in Drive gets a view link (shown in Photos & videos). Photos carry the boat\'s GPS position.' }),
    h('label', {}, 'Drive folder', folderIn),
    h('label', {}, 'After upload', afterSel),
    keepLabel)
  const advanced = h('details', { class: 'tl-advanced' },
    h('summary', { text: 'Advanced' }),
    h('label', { class: 'tl-check' }, ownCb, 'Use my own Google Cloud client'),
    h('p', { class: 'tl-hint', text: 'Only needed if the built-in client stops working. Create an OAuth client of type "TVs and Limited Input devices" in Google Cloud; the README has the steps. Changing the client means connecting again.' }),
    h('label', {}, 'Client ID', ownIdIn),
    h('label', {}, 'Client secret', ownSecretIn),
    h('div', { class: 'tl-row' }, ownSave))
  let driveSet = null
  async function loadDriveSettings () {
    try { driveSet = (await API.getDriveSettings()).settings } catch (e) { driveSet = null }
    renderDriveSettings()
  }
  async function saveDrive (patch, okMsg) {
    try {
      driveSet = (await API.putDriveSettings(patch)).settings
      if (okMsg) toast(okMsg)
      client.send({ t: 'refresh' })
    } catch (e) {
      toast(e.status === 401 || e.status === 403 ? 'Changing Drive settings needs a read/write login' : e.message)
    }
    renderDriveSettings()
  }
  function renderDriveSettings () {
    const d = driveSet
    for (const el of [driveOn, shareCb, folderIn, afterSel, keepIn, ownCb, ownIdIn, ownSecretIn, ownSave]) el.disabled = !d
    if (!d) return
    driveOn.checked = d.enabled
    driveOpts.hidden = !d.enabled
    shareCb.checked = d.shareLinks
    if (document.activeElement !== folderIn) folderIn.value = d.folderName
    afterSel.value = d.afterUpload
    if (document.activeElement !== keepIn) keepIn.value = String(d.keepUploadedDays)
    keepLabel.hidden = d.afterUpload !== 'move'
    ownCb.checked = d.useOwnClient
    if (document.activeElement !== ownIdIn) ownIdIn.value = d.ownClientId || ''
    ownSecretIn.placeholder = d.hasOwnSecret ? 'saved (enter to replace)' : ''
  }
  driveOn.addEventListener('change', () => saveDrive({ enabled: driveOn.checked }))
  shareCb.addEventListener('change', () => saveDrive({ shareLinks: shareCb.checked }, shareCb.checked ? 'Session folders will be viewable by link' : 'Link sharing will be removed from session folders'))
  folderIn.addEventListener('change', () => saveDrive({ folderName: folderIn.value }))
  afterSel.addEventListener('change', () => saveDrive({ afterUpload: afterSel.value }))
  keepIn.addEventListener('change', () => saveDrive({ keepUploadedDays: Number(keepIn.value) }))
  ownCb.addEventListener('change', () => saveDrive({ useOwnClient: ownCb.checked }))
  ownSave.addEventListener('click', () => {
    const patch = { clientId: ownIdIn.value }
    if (ownSecretIn.value) patch.clientSecret = ownSecretIn.value
    ownSecretIn.value = ''
    saveDrive(patch, 'Credentials saved')
  })
  loadDriveSettings()
  client.send({ t: 'probe' }) // fill the camera and resolution pickers
  const toastEl = h('div', { class: 'tl-toast', hidden: true })
  let toastTimer
  function toast (msg) {
    toastEl.textContent = msg
    toastEl.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { toastEl.hidden = true }, 4000)
  }

  const galleryBtn = openGallery
    ? h('button', { type: 'button', class: 'tl-gallery-btn', onclick: () => Promise.resolve(openGallery()).catch(e => toast(e.message)) }, 'Photos & videos')
    : null
  root.append(
    h('section', {}, modeSeg, autoDesc, galleryBtn),
    problem,
    h('section', {}, h('h2', { text: 'Status' }), statusList),
    h('section', {}, h('h2', { text: 'Capture' }),
      h('label', {}, 'Interval (seconds)', intervalIn),
      h('label', {}, 'Timestamp on each photo', stampSel),
      estimate),
    h('section', {}, h('h2', { text: 'Camera' }),
      h('label', {}, 'Camera', camSel),
      h('label', {}, 'Still resolution', resSel),
      h('div', { class: 'tl-row' }, testBtn, testResult),
      testImg),
    h('section', {}, h('h2', { text: 'Google Drive' }),
      h('label', { class: 'tl-check' }, driveOn, 'Upload to Google Drive'),
      driveBox, driveOpts, advanced),
    toastEl
  )

  function fillSelect (sel, items, value) {
    const sig = JSON.stringify(items) + value
    if (sel.dataset.sig === sig) return
    sel.dataset.sig = sig
    sel.innerHTML = ''
    for (const it of items) sel.append(h('option', { value: it.value, text: it.text }))
    if (value !== undefined && value !== null) sel.value = value
  }

  function kv (rows) {
    statusList.innerHTML = ''
    for (const [k, v, warn] of rows) {
      statusList.append(h('dt', { text: k }), h('dd', { text: v, class: warn ? 'tl-warn' : null }))
    }
  }

  function render (s) {
    const alive = client.alive()
    const d = describe(s, alive)
    for (const b of modeSeg.querySelectorAll('button')) {
      b.setAttribute('aria-checked', String(s ? b.dataset.mode === s.mode : b.dataset.mode === 'off'))
      if (b.dataset.mode === 'auto') b.disabled = !(s && s.cfg && s.cfg.auto && s.cfg.auto.configured)
    }
    if (!s) { kv([['Engine', 'starting…']]); return }
    const a = s.cfg && s.cfg.auto
    autoDesc.textContent = a && a.configured
      ? `Auto: ${a.autoPath} ${a.autoOperator === 'equals' ? '=' : '≠'} "${a.autoValue}", debounce ${a.autoDebounceSeconds} s, stale ${a.autoStaleSeconds ? a.autoStaleSeconds + ' s' : 'off'}`
      : 'Auto is off: set autoPath in the plugin config.'
    problem.hidden = !d.problem
    problem.innerHTML = d.problem ? escapeHtml(d.problem) + (d.problem.startsWith('Camera blocked') ? `<p>${insecureHelp()}</p>` : '') : ''

    const st = s.status
    const rows = [
      ['State', d.detail],
      ['Session', s.sessionId || '—'],
      ['Frames this session', String(s.sessionFrames)],
      ['Last capture', s.lastCaptureAt ? `${fmtTime(s.lastCaptureAt)} · ${fmtBytes(s.lastCaptureBytes)}` : '—'],
      ['Running in', s.host + (alive ? '' : ' (stopped)'), !alive]
    ]
    if (s.lastPause) rows.push(['Last pause (screen hidden)', `${fmtTime(s.lastPause.from)} – ${fmtTime(s.lastPause.to)}`])
    if (s.buffered) rows.push(['Waiting to send', `${s.buffered} frame(s)`, true])
    if (a && a.configured) {
      rows.push(['Auto (this tablet)', autoText(s.auto)])
      if (st) rows.push(['Auto (server)', autoText(st.auto)])
    }
    if (st) {
      rows.push(['Pi queue', `${st.queue.count} files · ${fmtBytes(st.queue.bytes)}`])
      rows.push(['Pi cache', `${fmtBytes(st.cache.bytes)}${st.cache.maxBytes ? ' / ' + fmtBytes(st.cache.maxBytes) : ''}`, st.cache.full])
      rows.push(['Pi free disk', fmtBytes(st.disk.freeBytes), st.disk.low])
      rows.push(['Last upload', st.drive.uploader && st.drive.uploader.lastUploadAt ? fmtTime(st.drive.uploader.lastUploadAt) : '—'])
    }
    kv(rows)

    const c = s.camera
    fillSelect(camSel, c.cameras.map(x => ({ value: x.id, text: x.label })), c.cameraId)
    fillSelect(resSel, resolutionOptions(c.resolutions), resolutionValue(c))
    camSel.disabled = !c.cameras.length
    resSel.disabled = !c.resolutions.length
    testBtn.disabled = !alive || !s.secure

    // Prefer the server's copy (fresh after a save); the engine's otherwise.
    const set = (st && st.settings) || s.cfg
    if (set) {
      if (document.activeElement !== intervalIn) intervalIn.value = String(set.intervalSeconds)
      stampSel.value = set.stamp || 'off'
    }
    intervalIn.disabled = stampSel.disabled = !set

    if (s.cfg) {
      const perHour = Math.round(3600 / s.cfg.intervalSeconds)
      const bytes = s.lastCaptureBytes || (st && st.avgFrameBytes) || 3 * 1048576
      estimate.textContent = `${perHour} frames/hour at ${s.cfg.intervalSeconds} s ≈ ${fmtBytes(perHour * bytes)}/hour (${s.lastCaptureBytes || (st && st.avgFrameBytes) ? 'measured' : 'assumed'} ${fmtBytes(bytes)} per frame).`
    }
    renderDrive(st)
  }

  let drivePoll = null
  let driveStatusSig = null
  function renderDrive (st) {
    if (!st) { driveBox.textContent = 'Server unreachable.'; return }
    // Another tablet changed the Drive settings: fetch them again.
    const ss = JSON.stringify([st.drive.enabled, st.drive.folderName, st.drive.shareLinks, st.drive.clientSource])
    if (driveStatusSig !== null && ss !== driveStatusSig) loadDriveSettings()
    driveStatusSig = ss
    if (!st.drive.enabled) { driveBox.dataset.sig = ''; driveBox.innerHTML = '<p class="tl-hint">Off. Frames stay on the Pi.</p>'; return }
    const a = st.drive.auth
    const sig = JSON.stringify(a) + (st.drive.uploader && st.drive.uploader.state) + st.drive.clientSource
    if (driveBox.dataset.sig === sig) return
    driveBox.dataset.sig = sig
    driveBox.innerHTML = ''
    const p = (html, cls = 'tl-hint') => { const e = h('p', { class: cls }); e.innerHTML = html; driveBox.append(e) }
    const btn = (text, fn, cls) => h('button', { type: 'button', class: cls, text, onclick: fn })
    const fail = (e) => toast(e.status === 401 || e.status === 403 ? 'Needs a read/write login' : e.message)
    if (a.state === 'unconfigured') {
      p(st.drive.clientSource === 'none' && driveSet && !driveSet.useOwnClient
        ? 'This version has no built-in Google client. Open Advanced below and enter your own.'
        : 'Enter your Google client ID and secret under Advanced below.')
    } else if (a.state === 'pending') {
      p(`On your phone, open <a href="${escapeHtml(a.verificationUrl)}" target="_blank" rel="noopener">${escapeHtml(a.verificationUrl)}</a> and enter:`)
      p(escapeHtml(a.userCode), 'tl-code')
      p(`Code expires ${fmtTime(a.expiresAt)}.`)
      driveBox.append(btn('Cancel', () => API.driveRevoke().then(() => client.send({ t: 'refresh' })).catch(fail)))
      if (!drivePoll) {
        drivePoll = setInterval(async () => {
          try {
            const r = await API.drivePoll()
            if (r.state !== 'pending') {
              clearInterval(drivePoll); drivePoll = null
              if (r.state === 'authorized') toast('Google Drive connected')
              client.send({ t: 'refresh' })
            }
          } catch (e) { /* keep trying */ }
        }, 3000)
      }
    } else if (a.state === 'authorized') {
      const up = st.drive.uploader
      p(`Connected. Folder <b>${escapeHtml(st.drive.folderName)}</b>${up ? ` · uploader ${escapeHtml(up.state.replace('_', ' '))}` : ''}.`)
      driveBox.append(h('div', { class: 'tl-row' },
        btn('Upload now', () => API.uploadNow().then(() => toast('Upload pass started')).catch(fail)),
        btn('Disconnect', async () => {
          if (await ask('Disconnect Google Drive?', [{ label: 'Cancel', value: null }, { label: 'Disconnect', value: true, kind: 'danger' }], { detail: 'Queued frames stay on the Pi and upload after you reconnect.' })) {
            API.driveRevoke().then(() => client.send({ t: 'refresh' })).catch(fail)
          }
        })))
    } else {
      if (a.state === 'needs_auth') p('Authorization expired or was revoked. Reconnect to resume uploads.')
      if (a.error) p(escapeHtml(a.error))
      driveBox.append(btn('Connect Google Drive', () => API.driveStart().then(() => client.send({ t: 'refresh' })).catch(fail), 'tl-primary'))
    }
  }

  client.onState(render)
  render(client.state)
  return { render, toast }
}
