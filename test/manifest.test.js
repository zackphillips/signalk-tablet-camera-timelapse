'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { buildManifest } = require('../src/manifest')

const BASE = '/signalk-tablet-camera-timelapse/'
const PUBLIC = path.join(__dirname, '..', 'public')
const m = buildManifest({ version: '9.9.9', base: BASE })

function localFile (url) {
  assert.ok(url.startsWith(BASE), url)
  return path.join(PUBLIC, url.slice(BASE.length))
}

test('manifest declares API v1 and needs only a background runtime', () => {
  assert.strictEqual(m.apiVersion, '1')
  assert.deepStrictEqual(m.requires, ['background.iframe'])
  assert.strictEqual(m.version, '9.9.9')
})

test('every contribution URL points at a file in public/', () => {
  for (const c of [...m.background, ...m.panels, ...m.widgets]) {
    assert.ok(fs.existsSync(localFile(c.url)), `${c.id}: ${c.url} missing`)
  }
})

test('references inside the manifest resolve', () => {
  const panels = new Set(m.panels.map(p => p.id))
  for (const b of m.buttons) if (b.action.panel) assert.ok(panels.has(b.action.panel), b.id)
  for (const w of m.widgets) if (w.configPanel) assert.ok(panels.has(w.configPanel), w.id)
  for (const a of m.actions) assert.ok(panels.has(a.action.panel), a.id)
  assert.ok(['1x1', '2x1', '1x2', '2x2'].includes(m.widgets[0].size))
})

test('runtime and panel pages load their module scripts, and every import resolves', () => {
  const seen = new Set()
  const check = (file) => {
    if (seen.has(file)) return
    seen.add(file)
    assert.ok(fs.existsSync(file), `missing ${path.relative(PUBLIC, file)}`)
    const src = fs.readFileSync(file, 'utf8')
    for (const [, spec] of src.matchAll(/(?:import|from)\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      check(path.resolve(path.dirname(file), spec))
    }
  }
  for (const page of ['fsk/runtime.html', 'fsk/panel.html', 'fsk/widget.html', 'fsk/gallery.html', 'fsk/photo.html', 'index.html', 'gallery.html']) {
    const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8')
    const scripts = [...html.matchAll(/<script type="module" src="([^"]+)"/g)].map(x => x[1])
    assert.strictEqual(scripts.length, 1, page)
    check(path.resolve(path.dirname(path.join(PUBLIC, page)), scripts[0]))
  }
  assert.ok([...seen].some(f => f.includes('vendor/plotterext-bus')), 'bus library is vendored')
  assert.ok([...seen].some(f => f.includes('vendor/mp4-muxer')), 'mp4 muxer is vendored')
})

test('photo overlay is an interactive data layer the default action opens', () => {
  const o = m.overlays.find(x => x.id === 'photos')
  assert.strictEqual(o.type, 'data')
  assert.strictEqual(o.interactive, true)
  assert.strictEqual(o.style.version, 8)
  assert.strictEqual(o.style.sources.photos.type, 'geojson')
  assert.strictEqual(o.style.sources.photos.data, '/plugins/signalk-tablet-camera-timelapse/photos.geojson')
  const layerIds = o.style.layers.map(l => l.id)
  for (const id of o.interactiveLayers) assert.ok(layerIds.includes(id), id)
  for (const l of o.style.layers) assert.strictEqual(l.source, 'photos')
  const a = m.actions.find(x => x.id === 'view-photo')
  assert.strictEqual(a.default, true)
  assert.deepStrictEqual(a.targets, [{ kind: 'overlayFeature', overlays: ['photos'] }])
  assert.strictEqual(a.action.type, 'openWindow')
  // Everything new stays optional: older hosts still get the capture engine.
  for (const cap of ['overlays.data', 'actions', 'actions.overlay', 'map']) assert.ok(m.optional.includes(cap), cap)
})
