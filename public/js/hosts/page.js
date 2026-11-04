// The KIP-embeddable page, also usable standalone at
// /signalk-tablet-camera-timelapse/. Inside KIP's Embed Webpage widget it
// copies KIP's live theme from the parent document (same origin) and picks a
// compact or full layout from the tile size. It is a capture engine candidate
// too, because KIP has no background runtime.
import { startEngine } from '../core/engine.js'
import { runAsEngineWhenLeader } from '../core/protocol.js'
import { createEngineClient, mountCompact, mountSettings } from '../core/ui.js'
import { kipParent, applyKipTheme } from './kip-theme.js'

const kip = kipParent()
if (kip) {
  document.body.classList.add('tl-transparent')
  applyKipTheme(kip)
}

const params = new URLSearchParams(location.search)
const forced = params.get('view') // compact | full
const COMPACT_MAX_W = 260
const COMPACT_MAX_H = 300

runAsEngineWhenLeader(() => startEngine({ host: kip ? 'KIP' : 'this page' }))

const client = createEngineClient()
const el = {
  compact: document.getElementById('compact'),
  full: document.getElementById('full'),
  settings: document.getElementById('settings'),
  back: document.getElementById('back')
}
let showFull = false
let settingsMounted = false

function small () {
  if (forced === 'compact') return true
  if (forced === 'full') return false
  return innerWidth < COMPACT_MAX_W || innerHeight < COMPACT_MAX_H
}

function layout () {
  const compact = small() && !showFull
  el.compact.hidden = !compact
  el.full.hidden = compact
  el.back.hidden = !(small() && showFull)
  if (!compact && !settingsMounted) {
    mountSettings(el.settings, client, { previewActive: () => !el.full.hidden })
    settingsMounted = true
  }
}

mountCompact(el.compact, client, { onLongPress: () => { showFull = true; layout() } })
el.back.addEventListener('click', () => { showFull = false; layout() })
addEventListener('resize', layout)
layout()
