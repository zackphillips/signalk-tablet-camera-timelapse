// Single-photo viewer for a chart marker: the frame, when and where it was
// taken, and stepping through the rest of its session (markers are thinned,
// so the frames between two markers are one swipe or arrow key away).

import { api, PLUGIN_ID } from './api.js'

const BASE = `/plugins/${PLUGIN_ID}`
const frameUrl = (session, name, size) => `${BASE}/sessions/${encodeURIComponent(session)}/frames/${encodeURIComponent(name)}?size=${size}`
const KN = 1.943844
const DEG = 180 / Math.PI

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

export function fmtLatLon (p) {
  if (!p || typeof p.latitude !== 'number') return ''
  const one = (v, pos, neg) => {
    const a = Math.abs(v)
    const d = Math.floor(a)
    return `${d}°${((a - d) * 60).toFixed(3).padStart(6, '0')}′${v >= 0 ? pos : neg}`
  }
  return `${one(p.latitude, 'N', 'S')} ${one(p.longitude, 'E', 'W')}`
}

export function navLine (f) {
  const parts = []
  if (typeof f.sog === 'number') parts.push(`${(f.sog * KN).toFixed(1)} kn`)
  if (typeof f.cog === 'number') parts.push(`COG ${Math.round(((f.cog * DEG) % 360 + 360) % 360)}°`)
  else if (typeof f.heading === 'number') parts.push(`HDG ${Math.round(((f.heading * DEG) % 360 + 360) % 360)}°`)
  if (typeof f.tws === 'number') parts.push(`TWS ${(f.tws * KN).toFixed(0)} kn`)
  else if (typeof f.aws === 'number') parts.push(`AWS ${(f.aws * KN).toFixed(0)} kn`)
  return parts.join(' · ')
}

/**
 * mountViewer(root, { openGallery(session), center([lon, lat]) }) → { show(session, name) }
 * Both callbacks are optional; their buttons only appear when given.
 */
export function mountViewer (root, { openGallery, center } = {}) {
  root.classList.add('tl-viewer')
  const img = h('img', { class: 'tl-v-img', alt: '' })
  const empty = h('p', { class: 'tl-hint tl-v-empty', text: 'Tap a photo marker on the chart.' })
  const stage = h('div', { class: 'tl-v-stage' }, img, empty)
  const when = h('div', { class: 'tl-v-when' })
  const nav = h('div', { class: 'tl-hint' })
  const pos = h('div', { class: 'tl-hint' })
  const count = h('span', { class: 'tl-hint tl-v-count' })
  const prev = h('button', { type: 'button', class: 'tl-icon-btn', 'aria-label': 'Previous frame', text: '‹', onclick: () => step(-1) })
  const next = h('button', { type: 'button', class: 'tl-icon-btn', 'aria-label': 'Next frame', text: '›', onclick: () => step(1) })
  const centerBtn = center ? h('button', { type: 'button', text: 'Center chart', onclick: () => { const f = cur(); if (f && f.position) center([f.position.longitude, f.position.latitude]) } }) : null
  const galleryBtn = openGallery ? h('button', { type: 'button', text: 'Session', title: 'Open this session in the gallery', onclick: () => session && openGallery(session) }) : null
  root.append(stage,
    h('div', { class: 'tl-v-bar' },
      h('div', { class: 'tl-v-text' }, when, nav, pos),
      h('div', { class: 'tl-row tl-v-ctrl' }, prev, count, next, centerBtn, galleryBtn)))

  const sessions = new Map() // id -> Promise<frames>
  let session = null
  let frames = []
  let idx = -1
  let token = 0

  const cur = () => frames[idx]
  const load = (id, fresh) => {
    if (fresh || !sessions.has(id)) {
      const p = api(`/sessions/${encodeURIComponent(id)}`).then(r => r.frames)
      p.catch(() => sessions.delete(id))
      sessions.set(id, p)
    }
    return sessions.get(id)
  }

  function render () {
    const f = cur()
    empty.hidden = !!f
    img.hidden = !f
    prev.disabled = idx <= 0
    next.disabled = idx < 0 || idx >= frames.length - 1
    count.textContent = f ? `${idx + 1} / ${frames.length}` : ''
    if (centerBtn) centerBtn.disabled = !(f && f.position)
    if (galleryBtn) galleryBtn.disabled = !session
    if (!f) { when.textContent = ''; nav.textContent = ''; pos.textContent = ''; return }
    img.src = frameUrl(session, f.name, 'hd')
    when.textContent = f.time ? new Date(f.time).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : f.name
    nav.textContent = navLine(f)
    pos.textContent = fmtLatLon(f.position)
    // Warm the neighbours so stepping is instant.
    for (const j of [idx - 1, idx + 1]) if (frames[j]) new Image().src = frameUrl(session, frames[j].name, 'hd')
  }

  function step (d) {
    const j = idx + d
    if (j < 0 || j >= frames.length) return
    idx = j
    render()
  }

  async function show (id, name) {
    const my = ++token
    empty.textContent = 'Loading…'
    try {
      let list = await load(id)
      // A marker newer than our cached list: the session has grown since.
      if (!list.some(f => f.name === name)) list = await load(id, true)
      if (my !== token) return
      session = id
      frames = list
      idx = list.findIndex(f => f.name === name)
      if (idx < 0) {
        empty.textContent = 'That photo is no longer on the Pi.'
        frames = []
      }
    } catch (e) {
      if (my !== token) return
      session = null
      frames = []
      idx = -1
      empty.textContent = e.status === 401 || e.status === 403 ? 'Log in to Signal K to see photos.' : `Could not load: ${e.message}`
    }
    render()
  }

  img.addEventListener('error', () => { if (cur()) { empty.hidden = false; empty.textContent = 'That photo is no longer on the Pi.' } })
  img.addEventListener('load', () => { if (cur()) empty.hidden = true })

  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') step(-1)
    else if (e.key === 'ArrowRight') step(1)
  })
  let x0 = null
  stage.addEventListener('pointerdown', (e) => { x0 = e.clientX })
  stage.addEventListener('pointerup', (e) => {
    if (x0 === null) return
    const dx = e.clientX - x0
    x0 = null
    if (Math.abs(dx) > 40) step(dx < 0 ? 1 : -1)
  })

  render()
  return { show }
}
