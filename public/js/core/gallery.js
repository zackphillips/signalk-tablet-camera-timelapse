// Photo gallery and video maker, shared by every host. Browses the sessions
// stored on the Pi, plays them back from thumbnails, trims or deletes frames,
// and encodes timelapse videos in the browser.

import { api, PLUGIN_ID } from './api.js'
import { fmtBytes, ask } from './ui.js'
import { canEncode, encodeVideo, outputSize, bitrateFor, drawInfoOverlay } from './video.js'

const BASE = `/plugins/${PLUGIN_ID}`
const frameUrl = (session, name, size) => `${BASE}/sessions/${encodeURIComponent(session)}/frames/${encodeURIComponent(name)}?size=${size}`

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
const fmtDate = (t) => (t ? new Date(t).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—')
const fmtClock = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—')
function fmtDuration (ms) {
  if (!(ms >= 0)) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ${s % 60 ? (s % 60) + ' s' : ''}`.trim()
  return `${Math.floor(m / 60)} h ${m % 60} min`
}

/**
 * Whether this document may start a file download. Freeboard's extension
 * iframes are sandboxed without allow-downloads, so downloads silently fail
 * there; we offer "save to the Pi" and sharing instead.
 */
export function downloadsAllowed () {
  try {
    let w = window
    while (w !== w.parent) {
      const fe = w.frameElement
      if (!fe) return true // cross-origin parent: can't tell, assume yes
      const sb = fe.getAttribute('sandbox')
      if (sb !== null && !sb.split(/\s+/).includes('allow-downloads')) return false
      w = w.parent
    }
  } catch (e) { /* cross-origin */ }
  return true
}

function saveBlob (blob, name) {
  const url = URL.createObjectURL(blob)
  const a = h('a', { href: url, download: name })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

async function shareBlob (blob, name) {
  const file = new File([blob], name, { type: blob.type })
  if (!navigator.canShare || !navigator.canShare({ files: [file] })) throw new Error('Sharing files is not available here')
  await navigator.share({ files: [file], title: name })
}

/**
 * Drive link for a folder: open it, and copy it. Freeboard's sandbox blocks
 * new tabs and sometimes the clipboard, so the URL is also shown selectable.
 */
function driveLink (url, shared, label = 'Drive folder') {
  if (!url) return null
  const field = h('input', { type: 'text', readonly: true, value: url, class: 'tl-g-link', onfocus: (e) => e.target.select() })
  const copy = h('button', { type: 'button', text: 'Copy link', onclick: async () => {
    try { await navigator.clipboard.writeText(url); copy.textContent = 'Copied' } catch (e) { field.focus(); field.select(); copy.textContent = 'Select and copy' }
    setTimeout(() => { copy.textContent = 'Copy link' }, 2500)
  } })
  return h('div', { class: 'tl-g-drive' },
    h('div', { class: 'tl-hint', text: `${label}: ${shared ? 'anyone with the link can view' : 'private (only your Google account)'}` }),
    h('div', { class: 'tl-row' }, h('a', { class: 'tl-btn', href: url, target: '_blank', rel: 'noopener', text: 'Open in Drive' }), copy),
    field)
}

export function mountGallery (root, { title = 'Photos & videos', session } = {}) {
  root.classList.add('tl-gallery')
  const canDownload = downloadsAllowed()
  let info = { driveEnabled: false }
  const toastEl = h('div', { class: 'tl-toast', hidden: true })
  let toastTimer
  function toast (msg) {
    toastEl.textContent = msg
    toastEl.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { toastEl.hidden = true }, 5000)
  }
  const failMsg = (e) => (e.status === 401 || e.status === 403 ? 'This needs a read/write login' : e.message)
  let cleanup = null

  function setView (node, onLeave) {
    if (cleanup) cleanup()
    cleanup = onLeave || null
    root.innerHTML = ''
    root.append(node, toastEl)
    root.scrollTop = 0
  }

  // ---------- session list ----------
  async function showList () {
    const body = h('div', { class: 'tl-g-body' }, h('p', { class: 'tl-hint', text: 'Loading…' }))
    setView(h('div', {},
      h('header', { class: 'tl-g-head' }, h('h1', { text: title }), h('button', { type: 'button', class: 'tl-icon-btn', 'aria-label': 'Refresh', text: '↻', onclick: showList })),
      body))
    try {
      info = await api('/sessions')
    } catch (e) {
      body.innerHTML = ''
      body.append(h('p', { class: 'tl-banner', text: `Could not load: ${failMsg(e)}` }))
      return
    }
    body.innerHTML = ''
    if (info.afterUpload === 'delete') {
      body.append(h('p', { class: 'tl-hint', text: 'afterUpload is "delete": frames leave the Pi once they reach Google Drive, so only frames still waiting to upload are listed here.' }))
    } else if (info.afterUpload === 'move') {
      body.append(h('p', { class: 'tl-hint', text: `Frames stay on the Pi for ${info.keepUploadedDays} days after upload.` }))
    }
    if (!info.sessions.length) body.append(h('p', { class: 'tl-hint', text: 'No photos on the Pi yet.' }))
    const grid = h('div', { class: 'tl-g-grid' })
    for (const s of info.sessions) {
      const card = h('button', { type: 'button', class: 'tl-g-card', onclick: () => showSession(s.id) },
        h('img', { src: frameUrl(s.id, s.first, 'thumb'), alt: '', loading: 'lazy' }),
        h('div', { class: 'tl-g-card-text' },
          h('div', { class: 'tl-g-card-title', text: s.id === 'test-shots' ? 'Test shots' : fmtDate(s.start) }),
          h('div', { class: 'tl-hint', text: `${s.frames} frames · ${fmtDuration(Date.parse(s.end) - Date.parse(s.start))} · ${fmtBytes(s.bytes)}` }),
          h('div', { class: 'tl-hint', text: s.queued ? `${s.queued} waiting to upload` : (info.driveEnabled ? 'all in Drive' : '') })))
      grid.append(card)
    }
    body.append(grid)

    body.append(h('h2', { text: 'Videos' }))
    if (info.videosDriveUrl) body.append(driveLink(info.videosDriveUrl, info.shareLinks, 'Videos folder in Drive'))
    if (!info.videos.length) body.append(h('p', { class: 'tl-hint', text: 'None yet. Open a session and choose Make video.' }))
    for (const v of info.videos) body.append(videoRow(v))
  }

  function videoRow (v) {
    const url = `${BASE}/videos/${encodeURIComponent(v.name)}`
    const player = h('video', { controls: true, preload: 'none', hidden: true, playsinline: true })
    const row = h('div', { class: 'tl-g-video' },
      h('div', { class: 'tl-g-video-head' },
        h('div', {}, h('div', { class: 'tl-g-card-title', text: v.name }),
          h('div', { class: 'tl-hint', text: `${fmtBytes(v.bytes)} · ${fmtDate(v.created)}${v.drive ? ' · Drive: ' + (v.drive === 'queued' ? 'waiting' : 'uploaded') : ''}` })),
        h('div', { class: 'tl-row' },
          h('button', { type: 'button', text: 'Play', onclick: () => { player.hidden = false; if (!player.src) player.src = url; player.play() } }),
          canDownload ? h('a', { class: 'tl-btn', href: url + '?download=1', download: v.name, text: 'Download' }) : null,
          h('button', { type: 'button', text: 'Delete', onclick: async () => {
            const drive = await askDelete(`Delete ${v.name}?`, info.driveEnabled && !!v.drive)
            if (drive === null) return
            try { await api(`/videos/${encodeURIComponent(v.name)}${drive ? '?drive=1' : ''}`, { method: 'DELETE' }); showList() } catch (e) { toast(failMsg(e)) }
          } }))),
      player)
    return row
  }

  /**
   * Confirm a delete. With Drive copies, offer Pi-only or Pi + Drive.
   * Resolves false (Pi only), true (Pi and Drive) or null (cancelled).
   */
  function askDelete (question, hasDriveCopies) {
    const detail = 'This cannot be undone on the Pi.' + (hasDriveCopies ? ' Drive copies go to the Drive trash, where they can be restored for 30 days.' : '')
    const buttons = [{ label: 'Cancel', value: null }]
    if (hasDriveCopies) buttons.push({ label: 'Pi only', value: false }, { label: 'Pi and Drive', value: true, kind: 'danger' })
    else buttons.push({ label: 'Delete', value: false, kind: 'danger' })
    return ask(question, buttons, { detail })
  }

  // ---------- one session ----------
  async function showSession (id) {
    let data
    try { data = await api(`/sessions/${encodeURIComponent(id)}`) } catch (e) { toast(failMsg(e)); return showList() }
    let frames = data.frames
    let idx = 0
    let sel = { a: 0, b: frames.length - 1 }
    let playing = null
    let hdTimer = null

    const img = h('img', { class: 'tl-g-frame', alt: 'Frame' })
    const caption = h('div', { class: 'tl-g-caption' })
    const scrub = h('input', { type: 'range', min: 0, max: Math.max(0, frames.length - 1), value: 0, class: 'tl-g-scrub', 'aria-label': 'Frame' })
    const selBar = h('div', { class: 'tl-g-selbar' })
    const selLabel = h('p', { class: 'tl-hint' })
    const playBtn = h('button', { type: 'button', class: 'tl-primary', text: '▶ Play' })
    const speed = h('select', { 'aria-label': 'Playback speed' }, ...[5, 10, 24, 30].map(f => h('option', { value: f, text: `${f} fps`, selected: f === 10 })))
    const title = h('h1', { text: id === 'test-shots' ? 'Test shots' : fmtDate(frames[0] && frames[0].time) })

    const fullOf = (f) => frameUrl(id, f.name, f.hd ? 'hd' : 'full')
    function show (i, { sharp = false } = {}) {
      if (!frames.length) return
      idx = Math.max(0, Math.min(frames.length - 1, i))
      const f = frames[idx]
      img.src = frameUrl(id, f.name, sharp ? (f.hd ? 'hd' : 'full') : 'thumb')
      scrub.value = idx
      const nav = []
      if (typeof f.sog === 'number') nav.push(`${(f.sog * 1.943844).toFixed(1)} kn`)
      const dir = typeof f.cog === 'number' ? f.cog : f.heading
      if (typeof dir === 'number') nav.push(`${Math.round(((dir * 180 / Math.PI) % 360 + 360) % 360)}°`)
      caption.textContent = `${idx + 1} / ${frames.length} · ${fmtClock(f.time)}${nav.length ? ' · ' + nav.join(' · ') : ''}${f.state === 'queued' ? ' · not uploaded yet' : ''}`
      // Sharpen when the user stops on a frame.
      clearTimeout(hdTimer)
      if (!sharp && !playing) hdTimer = setTimeout(() => show(idx, { sharp: true }), 350)
      // Warm the cache for smooth playback.
      for (let k = 1; k <= 3; k++) if (frames[idx + k]) new Image().src = frameUrl(id, frames[idx + k].name, 'thumb')
    }
    function renderSel () {
      const n = frames.length
      const a = n ? (sel.a / Math.max(1, n - 1)) * 100 : 0
      const b = n ? (sel.b / Math.max(1, n - 1)) * 100 : 100
      selBar.style.background = `linear-gradient(to right, var(--tl-line) ${a}%, var(--tl-accent) ${a}%, var(--tl-accent) ${b}%, var(--tl-line) ${b}%)`
      const count = n ? sel.b - sel.a + 1 : 0
      const span = n ? Date.parse(frames[sel.b].time) - Date.parse(frames[sel.a].time) : 0
      selLabel.textContent = n
        ? `Selection: frames ${sel.a + 1}–${sel.b + 1} (${count} frames, ${fmtDuration(span)} of real time, ${fmtClock(frames[sel.a].time)} – ${fmtClock(frames[sel.b].time)})`
        : 'No frames left.'
      renderExport()
    }
    function stop () {
      if (playing) clearInterval(playing)
      playing = null
      playBtn.textContent = '▶ Play'
      show(idx, { sharp: true })
    }
    function play () {
      if (playing) return stop()
      if (idx >= sel.b) idx = sel.a
      playBtn.textContent = '❚❚ Pause'
      playing = setInterval(() => {
        if (idx >= sel.b) return stop()
        show(idx + 1)
      }, 1000 / Number(speed.value))
    }
    playBtn.addEventListener('click', play)
    speed.addEventListener('change', () => { if (playing) { stop(); play() } })
    scrub.addEventListener('input', () => { if (playing) stop(); show(Number(scrub.value)) })

    async function deleteNames (names, what) {
      if (!names.length) return
      const drive = await askDelete(`Delete ${what} (${names.length} frame${names.length === 1 ? '' : 's'})?`,
        info.driveEnabled && names.some(n => (frames.find(f => f.name === n) || {}).state === 'uploaded'))
      if (drive === null) return
      try {
        await api(`/sessions/${encodeURIComponent(id)}/delete`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ frames: names, drive })
        })
      } catch (e) { toast(failMsg(e)); return }
      const gone = new Set(names)
      const keepName = frames[idx] && !gone.has(frames[idx].name) ? frames[idx].name : null
      frames = frames.filter(f => !gone.has(f.name))
      if (!frames.length) { toast('Session deleted'); return showList() }
      scrub.max = frames.length - 1
      sel = { a: 0, b: frames.length - 1 }
      idx = keepName ? frames.findIndex(f => f.name === keepName) : Math.min(idx, frames.length - 1)
      toast(`Deleted ${names.length} frame${names.length === 1 ? '' : 's'}${drive ? '; Drive copies will be trashed on the next upload pass' : ''}`)
      show(idx, { sharp: true })
      renderSel()
    }

    const selected = () => frames.slice(sel.a, sel.b + 1)
    const trimRow = h('div', { class: 'tl-row' },
      h('button', { type: 'button', text: 'Start here', onclick: () => { sel.a = Math.min(idx, sel.b); renderSel() } }),
      h('button', { type: 'button', text: 'End here', onclick: () => { sel.b = Math.max(idx, sel.a); renderSel() } }),
      h('button', { type: 'button', text: 'Select all', onclick: () => { sel = { a: 0, b: frames.length - 1 }; renderSel() } }))
    const editRow = h('div', { class: 'tl-row' },
      h('button', { type: 'button', text: 'Keep only selection', onclick: () => deleteNames(frames.filter((f, i) => i < sel.a || i > sel.b).map(f => f.name), 'everything outside the selection') }),
      h('button', { type: 'button', text: 'Delete selection', onclick: () => deleteNames(selected().map(f => f.name), 'the selected frames') }),
      h('button', { type: 'button', text: 'Delete this frame', onclick: () => deleteNames([frames[idx].name], 'this frame') }),
      canDownload ? h('button', { type: 'button', text: 'Download frame', onclick: () => { const a = h('a', { href: frameUrl(id, frames[idx].name, 'full') + '&download=1', download: frames[idx].name + '.jpg' }); document.body.append(a); a.click(); a.remove() } }) : null)
    const deleteSession = h('button', { type: 'button', class: 'tl-danger', text: 'Delete whole session', onclick: async () => {
      const drive = await askDelete(`Delete the whole session (${frames.length} frames)?`, info.driveEnabled && frames.some(f => f.state === 'uploaded'))
      if (drive === null) return
      try {
        await api(`/sessions/${encodeURIComponent(id)}${drive ? '?drive=1' : ''}`, { method: 'DELETE' })
        toast('Session deleted')
        showList()
      } catch (e) { toast(failMsg(e)) }
    } })

    // ---- export ----
    const srcW = (frames.find(f => f.w) || {}).w || 1920
    const srcH = (frames.find(f => f.h) || {}).h || 1080
    const fpsSel = h('select', { 'aria-label': 'Video frame rate' }, ...[12, 24, 30, 60].map(f => h('option', { value: f, text: `${f} fps`, selected: f === 30 })))
    const heights = [720, 1080, 1440, 2160].filter(x => x <= srcH)
    if (!heights.length) heights.push(srcH)
    const sizeSel = h('select', { 'aria-label': 'Video size' }, ...heights.map(x => h('option', { value: x, text: `${x}p`, selected: x === Math.min(1080, heights[heights.length - 1]) })))
    const overlaySel = h('select', { 'aria-label': 'Overlay' },
      h('option', { value: 'none', text: 'No overlay' }),
      h('option', { value: 'time', text: 'Time' }),
      h('option', { value: 'all', text: 'Time, speed, course, wind', selected: true }))
    const nameIn = h('input', { type: 'text', 'aria-label': 'File name', spellcheck: 'false' })
    const estimate = h('p', { class: 'tl-hint' })
    const makeBtn = h('button', { type: 'button', class: 'tl-primary', text: 'Make video' })
    const progress = h('progress', { max: 1, value: 0, hidden: true })
    const progressText = h('span', { class: 'tl-hint' })
    const result = h('div', { class: 'tl-g-result', hidden: true })
    let abort = null
    for (const el of [fpsSel, sizeSel, overlaySel]) el.addEventListener('change', renderExport)

    function exportPlan () {
      const fps = Number(fpsSel.value)
      const { width, height } = outputSize(srcW, srcH, Number(sizeSel.value))
      const list = selected()
      // HD proxies are at most proxyWidth wide; use them when they are big enough.
      const proxyH = Math.round(srcH * (info.proxyWidth || 1920) / srcW)
      const useHd = list.length && list.every(f => f.hd) && height <= proxyH
      return { fps, width, height, list, useHd }
    }
    function renderExport () {
      if (!frames.length) return
      const p = exportPlan()
      const secs = p.list.length / p.fps
      const mb = bitrateFor(p.width, p.height, p.fps) * secs / 8
      const transfer = p.list.reduce((a, f) => a + (p.useHd ? 400 * 1024 : f.bytes), 0)
      estimate.textContent = `${p.list.length} frames → ${secs.toFixed(1)} s at ${p.width}×${p.height}, about ${fmtBytes(mb)}. Reads ${fmtBytes(transfer)} from the Pi (${p.useHd ? 'HD proxies' : 'full-size frames'}).`
      const a = frames[sel.a]
      const b = frames[sel.b]
      const stamp = (f) => f.name.slice(0, 16).replace('T', '_')
      if (!nameIn.dataset.edited) nameIn.value = `timelapse_${stamp(a)}_to_${stamp(b).slice(11)}_${p.height}p${p.fps}.mp4`
    }
    nameIn.addEventListener('input', () => { nameIn.dataset.edited = '1' })

    makeBtn.addEventListener('click', async () => {
      if (abort) { abort.abort(); return }
      if (playing) stop()
      const p = exportPlan()
      let name = nameIn.value.trim().replace(/[^A-Za-z0-9_.-]/g, '_')
      if (!/\.mp4$/i.test(name)) name += '.mp4'
      abort = new AbortController()
      makeBtn.textContent = 'Cancel'
      progress.hidden = false
      progress.value = 0
      result.hidden = true
      result.innerHTML = ''
      const ov = overlaySel.value === 'none' ? null : drawInfoOverlay({ time: true, nav: overlaySel.value === 'all' })
      try {
        const out = await encodeVideo({
          frames: p.list.map(f => ({ url: frameUrl(id, f.name, p.useHd ? 'hd' : 'full'), meta: f })),
          width: p.width,
          height: p.height,
          fps: p.fps,
          overlay: ov,
          signal: abort.signal,
          onProgress: (done, total, ms) => {
            progress.value = done / total
            const eta = done ? (ms / done) * (total - done) : 0
            progressText.textContent = `${done} / ${total} frames · ${fmtDuration(eta)} left`
          }
        })
        progressText.textContent = `Done: ${fmtBytes(out.blob.size)}, ${out.codec}, ${fmtDuration(out.ms)} to encode.`
        showResult(out.blob, name)
      } catch (e) {
        progressText.textContent = e.name === 'AbortError' ? 'Cancelled.' : `Failed: ${e.message}`
      } finally {
        abort = null
        makeBtn.textContent = 'Make video'
        progress.hidden = true
      }
    })

    function showResult (blob, name) {
      const url = URL.createObjectURL(blob)
      const saveBtn = h('button', { type: 'button', class: 'tl-primary', text: info.driveEnabled ? 'Save to Pi and Drive' : 'Save to Pi' })
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true
        saveBtn.textContent = 'Saving…'
        try {
          const res = await fetch(`${BASE}/videos?${new URLSearchParams({ name })}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'video/mp4' }, body: blob })
          const j = await res.json().catch(() => ({}))
          if (!res.ok) throw Object.assign(new Error(j.error || `HTTP ${res.status}`), { status: res.status })
          saveBtn.textContent = 'Saved'
          toast(`Saved ${j.name}${info.driveEnabled ? '; it uploads to Drive in the background' : ''}`)
        } catch (e) {
          saveBtn.disabled = false
          saveBtn.textContent = 'Retry save'
          toast(failMsg(e))
        }
      })
      result.append(
        h('video', { src: url, controls: true, playsinline: true, class: 'tl-g-player' }),
        h('div', { class: 'tl-row' },
          saveBtn,
          canDownload ? h('button', { type: 'button', text: 'Download', onclick: () => saveBlob(blob, name) }) : null,
          navigator.canShare ? h('button', { type: 'button', text: 'Share…', onclick: () => shareBlob(blob, name).catch(e => { if (e.name !== 'AbortError') toast(e.message) }) }) : null),
        canDownload ? null : h('p', { class: 'tl-hint', text: 'Downloads are blocked inside Freeboard. Save it to the Pi, then download it from the gallery page in a browser tab.' }))
      result.hidden = false
    }

    const encodeOk = canEncode()
    setView(h('div', {},
      h('header', { class: 'tl-g-head' },
        h('button', { type: 'button', class: 'tl-icon-btn', 'aria-label': 'Back', text: '←', onclick: () => showList() }),
        title),
      h('div', { class: 'tl-g-body' },
        h('div', { class: 'tl-g-viewer' }, img, caption),
        scrub, selBar,
        h('div', { class: 'tl-row' }, playBtn, speed),
        h('section', {}, h('h2', { text: 'Select and trim' }), selLabel, trimRow, editRow),
        h('section', {}, h('h2', { text: 'Make a video' }),
          encodeOk
            ? h('div', {},
              h('div', { class: 'tl-g-form' },
                h('label', {}, 'Frame rate', fpsSel),
                h('label', {}, 'Size', sizeSel),
                h('label', {}, 'Overlay', overlaySel),
                h('label', { class: 'tl-g-wide' }, 'File name', nameIn)),
              estimate,
              h('div', { class: 'tl-row' }, makeBtn, progress, progressText),
              result)
            : h('p', { class: 'tl-banner', text: 'This browser cannot encode video (no WebCodecs). Use Chrome on Android or a desktop browser.' })),
        data.driveUrl ? h('section', {}, h('h2', { text: 'Google Drive' }), driveLink(data.driveUrl, data.driveShared)) : null,
        h('section', {}, deleteSession))
    ), () => { if (playing) clearInterval(playing); clearTimeout(hdTimer); if (abort) abort.abort() })
    show(0, { sharp: true })
    renderSel()
  }

  if (session) showSession(session)
  else showList()
  return { showList, showSession }
}
