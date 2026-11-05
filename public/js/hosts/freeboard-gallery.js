// Freeboard-SK: the gallery in a floating window (or the drawer).
import { connectExtension } from '../../vendor/plotterext-bus/extension.js'
import { mountGallery } from '../core/gallery.js'
import { followFreeboardNight } from './freeboard-theme.js'

document.documentElement.dataset.host = 'freeboard'
const client = await connectExtension()
await followFreeboardNight(client)
// Opened from the photo viewer with the session to show.
const session = client.context.params && client.context.params.session
mountGallery(document.getElementById('root'), { session })
