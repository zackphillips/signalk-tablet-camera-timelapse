// Freeboard-SK background runtime: a hidden iframe Freeboard keeps loaded
// while the plugin is enabled. It runs the capture engine (when it wins the
// tablet-wide lock) and shows the state on Freeboard's own toolbar button.
import { connectExtension } from '../../vendor/plotterext-bus/extension.js'
import { startEngine } from '../core/engine.js'
import { runAsEngineWhenLeader } from '../core/protocol.js'
import { createEngineClient, describe } from '../core/ui.js'
import { api } from '../core/api.js'

const BUTTON = 'timelapse'

runAsEngineWhenLeader(() => startEngine({ host: 'Freeboard' }))

const ec = createEngineClient()
let last = null
const client = await connectExtension()
const canDecorate = client.hasCapability('buttons.decorations')
let night = false
if (client.hasCapability('nightMode')) {
  try { night = !!(await client.call('nightMode.get')).enabled } catch (e) { /* ignore */ }
  await client.subscribe(['nightMode.changed'], (_n, p) => { night = !!p.enabled; last = null; apply(ec.state) })
}

// Off: normal. Waiting: normal, amber icon. Capturing: active. Problem:
// warning, or alarm when the Pi can't take frames at all.
function decorationFor (s) {
  const d = describe(s, ec.alive())
  if (d.problem) {
    const alarm = s && s.status && s.status.ingestBlocked === 'disk_low'
    return { style: alarm ? 'alarm' : 'warning', colors: null }
  }
  if (d.dot === 'capturing') return { style: 'active', colors: null }
  if (d.dot === 'waiting') return { style: 'normal', colors: { fg: night ? '#c77d1a' : '#e08a00' } }
  return { style: 'normal', colors: null }
}

async function apply (s) {
  if (!canDecorate) return
  const dec = decorationFor(s)
  const sig = JSON.stringify(dec)
  if (sig === last) return
  last = sig
  try { await client.call('buttons.decorate', { ids: [BUTTON], ...dec }) } catch (e) { last = null }
}

ec.onState(apply)

// ---------- photo markers ----------
// Freeboard loads the marker GeoJSON itself. We poll a cheap revision and ask
// for a reload only when frames have changed (new capture, upload pruning,
// gallery deletes), and only while the layer is shown.
if (client.hasCapability('overlays.data')) {
  const OVERLAY = 'photos'
  let rev = null
  let shown = true
  let checking = false
  let lastCheck = 0
  const check = async () => {
    if (!shown || checking) return
    checking = true
    lastCheck = Date.now()
    try {
      const r = await api('/photos/rev')
      if (rev !== null && r.rev !== rev) await client.call('overlay.refresh', { overlayId: OVERLAY, source: 'photos' })
      rev = r.rev
    } catch (e) { /* offline or logged out: try again later */ } finally { checking = false }
  }
  await client.subscribe(['overlay.state'], (_n, st) => {
    if (st.overlayId !== OVERLAY) return
    const was = shown
    shown = st.visible && !st.suspended
    // Hidden layers are not fetched, so anything missed loads when shown again.
    if (shown && !was) { rev = null; check() }
  })
  try {
    const { overlays } = await client.call('overlay.list')
    const me = overlays.find(o => o.id === OVERLAY)
    if (me) shown = me.visible && !me.suspended
  } catch (e) { /* assume shown */ }
  check()
  setInterval(check, 30000)
  // A capture on this tablet: check soon rather than at the next tick.
  let lastFrame = null
  ec.onState((s) => {
    const t = s && s.lastCaptureAt
    if (t && t !== lastFrame) {
      lastFrame = t
      if (Date.now() - lastCheck > 3000) setTimeout(check, 1500)
    }
  })
}
