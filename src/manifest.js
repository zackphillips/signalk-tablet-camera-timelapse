'use strict'

/*
 * Plotter extension manifest (Signal K plotter extensions API v1, Freeboard-SK
 * 3.4+ is the reference host). Assets are the plugin's public/ folder, which
 * the server mounts publicly at /<package-name>/ because of the
 * signalk-webapp keyword; the same folder serves the KIP/standalone page.
 */
const PHOTO_COLOR = '#d81b60'

/**
 * The chart layer of photo markers. The GeoJSON comes from the plugin's REST
 * route (fetched by Freeboard with the user's login); the runtime asks for a
 * reload when frames change. The newest frame is drawn larger.
 */
function photoOverlay (api) {
  const radius = (lo, hi) => ['interpolate', ['linear'], ['zoom'], 8, lo, 16, hi]
  return {
    id: 'photos',
    title: 'Timelapse photos',
    type: 'data',
    band: 'aboveResources',
    visible: true,
    opacity: 1,
    interactive: true,
    interactiveLayers: ['photo-dots', 'photo-latest'],
    titleProperty: 'title',
    style: {
      version: 8,
      sources: {
        photos: { type: 'geojson', data: `${api}photos.geojson` }
      },
      layers: [
        {
          id: 'photo-dots',
          type: 'circle',
          source: 'photos',
          filter: ['!=', ['get', 'latest'], true],
          paint: { 'circle-radius': radius(3, 6), 'circle-color': PHOTO_COLOR, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 }
        },
        {
          id: 'photo-latest',
          type: 'circle',
          source: 'photos',
          filter: ['==', ['get', 'latest'], true],
          paint: { 'circle-radius': radius(5, 9), 'circle-color': PHOTO_COLOR, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 }
        }
      ]
    }
  }
}

function buildManifest ({ version, base, api = '/plugins/signalk-tablet-camera-timelapse/' }) {
  return {
    name: 'Tablet Camera Timelapse',
    description: 'Timelapse photos from the tablet camera, saved on the Pi and uploaded to Google Drive.',
    version,
    apiVersion: '1',
    // The capture engine needs a background runtime. Everything else is a
    // nicety the extension does without on a host that lacks it.
    requires: ['background.iframe'],
    optional: ['buttons', 'buttons.decorations', 'panels.iframe', 'panels.state', 'widgets', 'nightMode', 'ui', 'windows',
      'overlays.data', 'actions', 'actions.overlay', 'map'],
    background: [
      { id: 'engine', title: 'Timelapse capture', type: 'iframe', url: `${base}fsk/runtime.html` }
    ],
    panels: [
      { id: 'settings', title: 'Timelapse', type: 'iframe', url: `${base}fsk/panel.html`, lifecycle: 'onOpen' },
      { id: 'gallery', title: 'Timelapse photos', type: 'iframe', url: `${base}fsk/gallery.html`, lifecycle: 'onOpen' },
      { id: 'photo', title: 'Photo', type: 'iframe', url: `${base}fsk/photo.html`, lifecycle: 'onOpen' }
    ],
    overlays: [photoOverlay(api)],
    // Tapping a marker runs this directly (default) and opens the viewer; a
    // second tap while it is open retargets the same window.
    actions: [
      {
        id: 'view-photo',
        title: 'View photo',
        icon: 'photo',
        targets: [{ kind: 'overlayFeature', overlays: ['photos'] }],
        default: true,
        action: {
          type: 'openWindow',
          panel: 'photo',
          title: 'Photo',
          geometry: { anchor: 'center', width: '60%', height: '70%', minWidth: 300, minHeight: 280 },
          restoreKey: 'photo'
        }
      }
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
