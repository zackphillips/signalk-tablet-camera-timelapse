'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { distanceM, thinFrames, photoFeatures, validPosition } = require('../src/photomap')
const { Storage } = require('../src/storage')

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
// 0.001° of latitude is about 111 m.
const at = (i, lat, lon = -122.5) => ({ name: `f${String(i).padStart(3, '0')}`, time: new Date(Date.UTC(2026, 10, 4, 12, 0, i)).toISOString(), position: { latitude: lat, longitude: lon } })

test('distanceM is right to a few metres', () => {
  const d = distanceM({ latitude: 37.8, longitude: -122.5 }, { latitude: 37.801, longitude: -122.5 })
  assert.ok(Math.abs(d - 111.2) < 1, String(d))
})

test('positions without a fix, out of range or at 0,0 are dropped', () => {
  assert.ok(validPosition({ latitude: 37.8, longitude: -122.5 }))
  assert.ok(!validPosition(null))
  assert.ok(!validPosition({ latitude: 0, longitude: 0 }))
  assert.ok(!validPosition({ latitude: 95, longitude: 0 }))
  assert.ok(!validPosition({ latitude: '37', longitude: -122 }))
})

test('thinning keeps first, last and one per spacing', () => {
  // A frame every ~22 m for 50 frames (~1.1 km), then 20 frames at anchor.
  const frames = []
  for (let i = 0; i < 50; i++) frames.push(at(i, 37.8 + i * 0.0002))
  for (let i = 50; i < 70; i++) frames.push(at(i, 37.8 + 49 * 0.0002))
  frames.splice(10, 0, { name: 'nofix', time: frames[10].time, position: null })
  const kept = thinFrames(frames, 100)
  assert.strictEqual(kept[0].name, 'f000')
  assert.strictEqual(kept[kept.length - 1].name, 'f069')
  assert.ok(kept.length >= 10 && kept.length <= 13, `kept ${kept.length}`)
  assert.ok(!kept.some(f => f.name === 'nofix'))
  for (let i = 1; i < kept.length - 1; i++) assert.ok(distanceM(kept[i - 1].position, kept[i].position) >= 100)
  assert.strictEqual(thinFrames(frames, 0).length, 70)
})

test('features carry stable ids and mark only the newest frame', () => {
  const fc = photoFeatures([
    { id: 's1', frames: [at(1, 37.8), at(2, 37.81)] },
    { id: 's2', frames: [at(5, 37.82)] }
  ], { spacingM: 0 })
  assert.strictEqual(fc.type, 'FeatureCollection')
  assert.deepStrictEqual(fc.features.map(f => f.id), ['s1/f001', 's1/f002', 's2/f005'])
  assert.deepStrictEqual(fc.features.map(f => f.properties.latest), [false, false, true])
  assert.deepStrictEqual(fc.features[0].geometry.coordinates, [-122.5, 37.8])
  assert.strictEqual(fc.features[0].properties.session, 's1')
  assert.strictEqual(fc.features[0].properties.name, 'f001')
  assert.match(fc.features[0].properties.title, /^Photo 2026-11-04 12:00 UTC$/)
})

test('photoSessions reads positions, skips test shots, filters by age and changes rev', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sktl-'))
  const s = new Storage({ storagePath: d })
  await s.init()
  const pos = (lat) => ({ navigation: { position: { value: { latitude: lat, longitude: -122.5 } } } })
  const t0 = Date.parse('2026-11-04T12:00:00Z')
  await s.writeFrame({ sessionId: 'old', captureDate: new Date(t0 - 10 * 86400000), jpeg: JPEG, sidecar: pos(37.7) })
  await s.writeFrame({ sessionId: 'new', captureDate: new Date(t0), jpeg: JPEG, sidecar: pos(37.8) })
  await s.writeFrame({ sessionId: 'new', captureDate: new Date(t0 + 30000), jpeg: JPEG, sidecar: { navigation: {} } })
  await s.writeFrame({ sessionId: 'test-shots', captureDate: new Date(t0), jpeg: JPEG, sidecar: pos(37.9) })

  const all = await s.photoSessions(0)
  assert.deepStrictEqual(all.sessions.map(x => x.id), ['new', 'old'])
  assert.strictEqual(all.sessions[0].frames.length, 1, 'frame without a fix is left out')
  assert.deepStrictEqual(all.sessions[0].frames[0].position, { latitude: 37.8, longitude: -122.5 })

  const recent = await s.photoSessions(t0 - 86400000)
  assert.deepStrictEqual(recent.sessions.map(x => x.id), ['new'])

  const again = await s.photoSessions(0)
  assert.strictEqual(again.rev, all.rev, 'rev is stable without changes')
  await s.writeFrame({ sessionId: 'new', captureDate: new Date(t0 + 60000), jpeg: JPEG, sidecar: pos(37.81) })
  const grown = await s.photoSessions(0)
  assert.notStrictEqual(grown.rev, all.rev)
  assert.strictEqual(grown.sessions[0].frames.length, 2)
  const frames = await s.listFrames('new')
  await s.deleteFrames('new', [frames[0].name])
  const shrunk = await s.photoSessions(0)
  assert.notStrictEqual(shrunk.rev, grown.rev)
  assert.strictEqual(shrunk.sessions[0].frames.length, 1)
})
