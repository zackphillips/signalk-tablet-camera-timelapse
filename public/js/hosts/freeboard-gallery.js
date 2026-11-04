// Freeboard-SK: the gallery in a floating window (or the drawer).
import { connectExtension } from '../../vendor/plotterext-bus/extension.js'
import { mountGallery } from '../core/gallery.js'
import { followFreeboardNight } from './freeboard-theme.js'

document.documentElement.dataset.host = 'freeboard'
const client = await connectExtension()
await followFreeboardNight(client)
mountGallery(document.getElementById('root'))
