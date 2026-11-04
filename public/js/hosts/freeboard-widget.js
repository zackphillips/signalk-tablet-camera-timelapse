// Freeboard-SK chart widget (1x1): tap cycles the mode, long-press opens the
// settings panel as the widget's configuration panel.
import { connectExtension } from '../../vendor/plotterext-bus/extension.js'
import { createEngineClient, mountCompact } from '../core/ui.js'
import { followFreeboardNight } from './freeboard-theme.js'

document.documentElement.dataset.host = 'freeboard'
const client = await connectExtension()
await followFreeboardNight(client)
mountCompact(document.getElementById('root'), createEngineClient(), {
  showLine: false,
  onLongPress: () => client.call('ui.openConfigPanel').catch(() => {})
})
