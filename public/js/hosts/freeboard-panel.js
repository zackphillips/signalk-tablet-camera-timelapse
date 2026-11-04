// Freeboard-SK panel: the settings view inside Freeboard's own drawer.
import { connectExtension } from '../../vendor/plotterext-bus/extension.js'
import { createEngineClient, mountSettings } from '../core/ui.js'
import { followFreeboardNight } from './freeboard-theme.js'

document.documentElement.dataset.host = 'freeboard'
const client = await connectExtension()
await followFreeboardNight(client)

// The gallery opens in a floating window where Freeboard supports them,
// otherwise in the drawer in place of this panel.
const openGallery = () => client.hasCapability('windows')
  ? client.call('ui.openWindow', { panel: 'gallery', title: 'Timelapse photos', geometry: { anchor: 'center', width: '92%', height: '92%' }, single: true })
  : client.call('ui.openPanel', { panel: 'gallery' })

mountSettings(document.getElementById('root'), createEngineClient(), { openGallery })
