'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const piexif = require('piexifjs')
const { addExif, snapshot, buildSidecar, dms } = require('../src/metadata')

const jpeg = fs.readFileSync(path.join(__dirname, 'fixtures', 'frame.jpg'))

test('dms conversion', () => {
  const [[d], [m], [sn, sd]] = dms(37.7749)
  assert.strictEqual(d, 37)
  assert.strictEqual(m, 46)
  assert.ok(Math.abs(sn / sd - 29.64) < 0.01)
})

test('addExif writes GPS, time, SOG and COG; image still decodes as JPEG', () => {
  const captureDate = new Date('2026-11-03T17:31:05Z')
  const nav = {
    position: { value: { latitude: 37.7749, longitude: -122.5107 } },
    speedOverGround: { value: 3.0866 }, // 6 kn
    courseOverGroundTrue: { value: Math.PI / 2 }
  }
  const { buf, error } = addExif(jpeg, { captureDate, nav })
  assert.strictEqual(error, undefined)
  assert.strictEqual(buf[0], 0xff)
  assert.strictEqual(buf[1], 0xd8)
  const ex = piexif.load(buf.toString('binary'))
  assert.strictEqual(ex.GPS[piexif.GPSIFD.GPSLatitudeRef], 'N')
  assert.strictEqual(ex.GPS[piexif.GPSIFD.GPSLongitudeRef], 'W')
  assert.strictEqual(ex.Exif[piexif.ExifIFD.DateTimeOriginal], '2026:11:03 17:31:05')
  const [sn, sd] = ex.GPS[piexif.GPSIFD.GPSSpeed]
  assert.ok(Math.abs(sn / sd - 6) < 0.01)
  const [tn, td] = ex.GPS[piexif.GPSIFD.GPSTrack]
  assert.ok(Math.abs(tn / td - 90) < 0.01)
})

test('addExif without position still writes time and never throws on junk', () => {
  const { buf } = addExif(jpeg, { captureDate: new Date(), nav: {} })
  assert.ok(buf.length > 0)
  const junk = Buffer.from([0xff, 0xd8, 0, 1, 2])
  const r = addExif(junk, { captureDate: new Date(), nav: {} })
  assert.ok(Buffer.isBuffer(r.buf))
})

test('snapshot reads SK values and skips missing/null', () => {
  const data = {
    'navigation.position': { value: { latitude: 1, longitude: 2 }, timestamp: 't' },
    'navigation.speedOverGround': { value: null },
    'environment.wind.speedApparent': { value: 5 }
  }
  const nav = snapshot({ getSelfPath: (p) => data[p] })
  assert.deepStrictEqual(Object.keys(nav).sort(), ['position', 'windSpeedApparent'])
  const sc = buildSidecar({ captureDate: new Date(0), receivedDate: new Date(1), sessionId: 's', mode: 'on', bytes: 3, nav })
  assert.strictEqual(sc.captureTime, '1970-01-01T00:00:00.000Z')
  assert.strictEqual(sc.navigation.windSpeedApparent.value, 5)
})
