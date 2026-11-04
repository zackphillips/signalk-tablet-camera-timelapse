// Standalone gallery at /signalk-tablet-camera-timelapse/gallery.html (KIP
// opens it in a new tab). Also a capture-engine candidate: opening it in front
// of KIP hides KIP's tile, and capture should not stop while you browse.
import { startEngine } from '../core/engine.js'
import { runAsEngineWhenLeader } from '../core/protocol.js'
import { mountGallery } from '../core/gallery.js'

runAsEngineWhenLeader(() => startEngine({ host: 'gallery page' }))
mountGallery(document.getElementById('root'))
