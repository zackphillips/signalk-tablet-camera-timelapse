'use strict'

/*
 * Plotter extension manifest (Signal K plotter extensions API v1, Freeboard-SK
 * 3.4+ is the reference host). Assets are the plugin's public/ folder, which
 * the server mounts publicly at /<package-name>/ because of the
 * signalk-webapp keyword; the same folder serves the KIP/standalone page.
 */
function buildManifest ({ version, base }) {
  return {
    name: 'Tablet Camera Timelapse',
    description: 'Timelapse photos from the tablet camera, saved on the Pi and uploaded to Google Drive.',
    version,
    apiVersion: '1',
    // The capture engine needs a background runtime. Everything else is a
    // nicety the extension does without on a host that lacks it.
    requires: ['background.iframe'],
    optional: ['buttons', 'buttons.decorations', 'panels.iframe', 'panels.state', 'widgets', 'nightMode'],
    background: [
      { id: 'engine', title: 'Timelapse capture', type: 'iframe', url: `${base}fsk/runtime.html` }
    ],
    panels: [
      { id: 'settings', title: 'Timelapse', type: 'iframe', url: `${base}fsk/panel.html`, lifecycle: 'onOpen' }
    ],
    buttons: [
      {
        id: 'timelapse',
        title: 'Timelapse',
        slot: 'mapToolbar',
        icon: 'photo_camera',
        action: { type: 'togglePanel', panel: 'settings' }
      }
    ],
    widgets: [
      {
        id: 'toggle',
        title: 'Timelapse',
        type: 'iframe',
        url: `${base}fsk/widget.html`,
        size: '1x1',
        configPanel: 'settings'
      }
    ]
  }
}

module.exports = { buildManifest }
