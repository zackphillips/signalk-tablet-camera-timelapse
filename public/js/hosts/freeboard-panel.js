// Freeboard-SK panel: the settings view inside Freeboard's own drawer.
import { connectExtension } from '../../vendor/plotterext-bus/extension.js'
import { createEngineClient, mountSettings } from '../core/ui.js'
import { followFreeboardNight } from './freeboard-theme.js'

document.documentElement.dataset.host = 'freeboard'
const client = await connectExtension()
await followFreeboardNight(client)

// Only stream preview frames while Freeboard is showing this panel.
let visible = true
if (client.hasCapability('panels.state')) {
  const self = client.context.id
  await client.subscribe(['panel.state'], (_n, st) => { if (st.panel === self) visible = st.visible && !st.collapsed })
  try {
    const { panels } = await client.call('ui.listPanels')
    const me = panels.find(p => p.panel === self)
    if (me) visible = me.visible && !me.collapsed
  } catch (e) { /* assume visible */ }
}

mountSettings(document.getElementById('root'), createEngineClient(), { previewActive: () => visible })
