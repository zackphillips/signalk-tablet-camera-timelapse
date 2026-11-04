// Freeboard-SK: the photo viewer a chart marker opens. The tapped marker
// arrives in the handshake (first open) or as action.invoked (a later tap
// while this window is open).
import { connectExtension } from '../../vendor/plotterext-bus/extension.js'
import { mountViewer } from '../core/viewer.js'
import { followFreeboardNight } from './freeboard-theme.js'

document.documentElement.dataset.host = 'freeboard'
const client = await connectExtension()
await followFreeboardNight(client)

const openGallery = (session) => client.hasCapability('windows')
  ? client.call('ui.openWindow', { panel: 'gallery', title: 'Timelapse photos', params: { session }, geometry: { anchor: 'center', width: '92%', height: '92%' }, single: true })
  : client.call('ui.openPanel', { panel: 'gallery' })
const center = client.hasCapability('map') ? (position) => client.call('map.center', { position }) : null

const viewer = mountViewer(document.getElementById('root'), { openGallery, center })
const show = (inv) => {
  const p = inv && inv.target && inv.target.properties
  if (p && p.session && p.name) viewer.show(p.session, p.name)
}
show(client.context.invocation)
if (client.hasCapability('actions')) await client.subscribe(['action.invoked'], (_n, inv) => show(inv))
