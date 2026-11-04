'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Storage, atomicWrite, frameBaseName, isValidSessionId } = require('../src/storage')

function tmpdir () { return fs.mkdtempSync(path.join(os.tmpdir(), 'sktl-')) }
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9])

test('frameBaseName is filename-safe and sortable', () => {
  assert.strictEqual(frameBaseName(new Date('2026-11-03T17:31:00.123Z')), '2026-11-03T17-31-00-123Z')
  const a = frameBaseName(new Date('2026-11-03T09:00:00.000Z'))
  const b = frameBaseName(new Date('2026-11-03T10:00:00.000Z'))
  assert.ok(a < b)
})

test('session id validation rejects traversal', () => {
  assert.ok(isValidSessionId('2026-11-03_173100'))
  assert.ok(!isValidSessionId('../etc'))
  assert.ok(!isValidSessionId('a/b'))
  assert.ok(!isValidSessionId(''))
})

test('atomicWrite leaves no temp file and replaces content', async () => {
  const d = tmpdir()
  const f = path.join(d, 'x.bin')
  await atomicWrite(f, Buffer.from('one'))
  await atomicWrite(f, Buffer.from('two'))
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'two')
  assert.deepStrictEqual(fs.readdirSync(d), ['x.bin'])
})

test('init removes stale temp files from a crash', async () => {
  const d = tmpdir()
  fs.mkdirSync(path.join(d, 'queue', 's1'), { recursive: true })
  fs.writeFileSync(path.join(d, 'queue', 's1', '.tmp-123-abc'), 'partial')
  const s = new Storage({ storagePath: d })
  await s.init()
  assert.deepStrictEqual(fs.readdirSync(path.join(d, 'queue', 's1')), [])
})

test('scanQueue orders oldest first across sessions, jpg before json', async () => {
  const d = tmpdir()
  const s = new Storage({ storagePath: d })
  await s.init()
  await s.writeFrame({ sessionId: 'b-session', captureDate: new Date('2026-01-01T00:00:02Z'), jpeg: JPEG, sidecar: { a: 1 } })
  await s.writeFrame({ sessionId: 'a-session', captureDate: new Date('2026-01-01T00:00:03Z'), jpeg: JPEG })
  await s.writeFrame({ sessionId: 'c-session', captureDate: new Date('2026-01-01T00:00:01Z'), jpeg: JPEG, sidecar: { a: 1 } })
  const items = await s.scanQueue()
  assert.deepStrictEqual(items.map(i => i.key), [
    'c-session/2026-01-01T00-00-01-000Z.jpg',
    'c-session/2026-01-01T00-00-01-000Z.json',
    'b-session/2026-01-01T00-00-02-000Z.jpg',
    'b-session/2026-01-01T00-00-02-000Z.json',
    'a-session/2026-01-01T00-00-03-000Z.jpg'
  ])
  assert.strictEqual(s.stats.queueCount, 5)
})

test('a retried frame (same session + timestamp) is stored once', async () => {
  const d = tmpdir()
  const s = new Storage({ storagePath: d, minFreeDiskMB: 0 })
  await s.init()
  const t = new Date('2026-01-01T00:00:00Z')
  const a = await s.writeFrame({ sessionId: 's', captureDate: t, jpeg: JPEG })
  const b = await s.writeFrame({ sessionId: 's', captureDate: t, jpeg: JPEG })
  assert.strictEqual(a.duplicate, false)
  assert.strictEqual(b.duplicate, true)
  assert.strictEqual((await s.scanQueue()).length, 1)
  // still a duplicate after it was uploaded and moved
  await s.afterUpload((await s.scanQueue())[0])
  assert.strictEqual((await s.writeFrame({ sessionId: 's', captureDate: t, jpeg: JPEG })).duplicate, true)
  assert.strictEqual((await s.scanQueue()).length, 0)
})

for (const mode of ['delete', 'move', 'keep']) {
  test(`afterUpload: ${mode}`, async () => {
    const d = tmpdir()
    const s = new Storage({ storagePath: d, afterUpload: mode })
    await s.init()
    await s.writeFrame({ sessionId: 's', captureDate: new Date(), jpeg: JPEG })
    const [item] = await s.scanQueue()
    await s.afterUpload(item)
    assert.strictEqual((await s.scanQueue()).length, 0)
    const up = fs.readdirSync(path.join(d, 'uploaded'))
    if (mode === 'delete') assert.deepStrictEqual(up, [])
    else assert.deepStrictEqual(fs.readdirSync(path.join(d, 'uploaded', 's')), [item.name])
  })
}

test('pruneUploaded deletes only files older than keepUploadedDays, move mode only', async () => {
  const d = tmpdir()
  for (const mode of ['move', 'keep']) {
    const root = path.join(d, mode)
    const s = new Storage({ storagePath: root, afterUpload: mode, keepUploadedDays: 7 })
    await s.init()
    const dir = path.join(root, 'uploaded', 's')
    fs.mkdirSync(dir, { recursive: true })
    const old = path.join(dir, 'old.jpg')
    const fresh = path.join(dir, 'new.jpg')
    fs.writeFileSync(old, 'x')
    fs.writeFileSync(fresh, 'x')
    const eightDays = (Date.now() - 8 * 86400000) / 1000
    fs.utimesSync(old, eightDays, eightDays)
    const n = await s.pruneUploaded()
    if (mode === 'move') {
      assert.strictEqual(n, 1)
      assert.deepStrictEqual(fs.readdirSync(dir), ['new.jpg'])
    } else {
      assert.strictEqual(n, 0)
      assert.strictEqual(fs.readdirSync(dir).length, 2)
    }
  }
})

function bigJpeg () {
  const b = Buffer.alloc(400 * 1024, 1)
  b[0] = 0xff; b[1] = 0xd8
  return b
}

test('cache cap, move mode: only queued bytes block; uploaded files are evicted', async () => {
  const d = tmpdir()
  const s = new Storage({ storagePath: d, afterUpload: 'move', maxCacheMB: 1, minFreeDiskMB: 0 })
  await s.init()
  for (let i = 0; i < 3; i++) await s.writeFrame({ sessionId: 's', captureDate: new Date(Date.UTC(2026, 0, 1, 0, 0, i)), jpeg: bigJpeg() })
  assert.strictEqual(s.ingestBlocker(), 'cache_full', 'queued frames alone fill the cap')
  const items = await s.scanQueue()
  await s.afterUpload(items[0])
  await s.afterUpload(items[1])
  assert.strictEqual(s.ingestBlocker(), null, 'uploaded files never block ingest in move mode')
  // the next write triggers eviction in the background
  await s.writeFrame({ sessionId: 's', captureDate: new Date(Date.UTC(2026, 0, 1, 0, 0, 9)), jpeg: bigJpeg() })
  await s.evicting
  assert.ok(s.cacheBytes() < 1024 * 1024 * 0.95)
  assert.strictEqual((await s.scanQueue()).length, 2, 'queued frames are never evicted')
})

test('cache cap, keep mode: uploaded files count and are never evicted', async () => {
  const d = tmpdir()
  const s = new Storage({ storagePath: d, afterUpload: 'keep', maxCacheMB: 1, minFreeDiskMB: 0 })
  await s.init()
  for (let i = 0; i < 3; i++) await s.writeFrame({ sessionId: 's', captureDate: new Date(Date.UTC(2026, 0, 1, 0, 0, i)), jpeg: bigJpeg() })
  for (const it of await s.scanQueue()) await s.afterUpload(it)
  assert.strictEqual(s.ingestBlocker(), 'cache_full')
  assert.strictEqual(await s.evictForCap(), 0)
})

test('disk low blocks ingest', async () => {
  const d = tmpdir()
  const s = new Storage({ storagePath: d, minFreeDiskMB: 1e12 })
  await s.init()
  assert.strictEqual(s.ingestBlocker(), 'disk_low')
})

// ---------- gallery ----------
const { Readable } = require('stream')
const { frameTime, VIDEO_SESSION } = require('../src/storage')

async function galleryStore (mode = 'move') {
  const d = tmpdir()
  const s = new Storage({ storagePath: d, afterUpload: mode, minFreeDiskMB: 0 })
  await s.init()
  for (let i = 0; i < 4; i++) {
    const captureDate = new Date(Date.UTC(2026, 0, 1, 0, 0, i * 10))
    await s.writeFrame({ sessionId: 's1', captureDate, jpeg: JPEG, sidecar: { image: { width: 4000, height: 3000 }, navigation: { speedOverGround: { value: 3 } } } })
    await s.writeThumb({ sessionId: 's1', captureDate, jpeg: JPEG })
    if (i < 2) await s.writeThumb({ sessionId: 's1', captureDate, jpeg: JPEG, kind: 'hd' })
  }
  await s.writeFrame({ sessionId: 's2', captureDate: new Date(Date.UTC(2026, 0, 2)), jpeg: JPEG })
  return { d, s }
}

test('frameTime parses frame names', () => {
  assert.strictEqual(frameTime('2026-11-03T17-31-00-123Z'), '2026-11-03T17:31:00.123Z')
  assert.strictEqual(frameTime('../etc'), null)
})

test('listSessions spans queue and uploaded, newest first', async () => {
  const { s } = await galleryStore()
  const [first] = await s.scanQueue()
  await s.afterUpload(first) // one jpg moves to uploaded/
  const list = await s.listSessions()
  assert.deepStrictEqual(list.map(x => x.id), ['s2', 's1'])
  const s1 = list[1]
  assert.strictEqual(s1.frames, 4)
  assert.strictEqual(s1.uploaded, 1)
  assert.strictEqual(s1.queued, 3)
  assert.strictEqual(s1.start, '2026-01-01T00:00:00.000Z')
  assert.strictEqual(s1.end, '2026-01-01T00:00:30.000Z')
})

test('listFrames returns time order, sidecar summary and proxy flags', async () => {
  const { s } = await galleryStore()
  const frames = await s.listFrames('s1')
  assert.strictEqual(frames.length, 4)
  assert.ok(frames[0].name < frames[1].name)
  assert.strictEqual(frames[0].w, 4000)
  assert.strictEqual(frames[0].sog, 3)
  assert.deepStrictEqual(frames.map(f => f.hd), [true, true, false, false])
  assert.ok(frames.every(f => f.thumb))
  assert.strictEqual(await s.listFrames('../x'), null)
  assert.strictEqual(await s.listFrames(VIDEO_SESSION), null)
})

test('deleteFrames removes jpg, sidecar and both thumbnails, and reports keys', async () => {
  const { d, s } = await galleryStore()
  const frames = await s.listFrames('s1')
  const keys = await s.deleteFrames('s1', [frames[0].name, 'not-a-frame'])
  assert.deepStrictEqual(keys.sort(), [`s1/${frames[0].name}.jpg`, `s1/${frames[0].name}.json`])
  assert.strictEqual((await s.listFrames('s1')).length, 3)
  assert.ok(!fs.existsSync(path.join(d, 'thumbs', 's1', frames[0].name + '.jpg')))
  assert.ok(!fs.existsSync(path.join(d, 'thumbs', 's1', frames[0].name + '.hd.jpg')))
  assert.strictEqual(s.stats.queueCount, 3 * 2 + 1)
})

test('deleteSession removes everything for that session only', async () => {
  const { d, s } = await galleryStore()
  await s.deleteSession('s1')
  assert.deepStrictEqual((await s.listSessions()).map(x => x.id), ['s2'])
  assert.ok(!fs.existsSync(path.join(d, 'thumbs', 's1')))
})

test('frames may not use the videos pseudo-session', async () => {
  const { s } = await galleryStore()
  await assert.rejects(s.writeFrame({ sessionId: VIDEO_SESSION, captureDate: new Date(), jpeg: JPEG }))
})

test('sweepThumbs drops thumbnails whose frame is gone', async () => {
  const { d, s } = await galleryStore('delete')
  for (const it of await s.scanQueue()) if (it.session === 's1') await s.afterUpload(it)
  // the throttle in removeEmptyDirs keeps fresh dirs; the files are what matter
  const n = await s.sweepThumbs()
  assert.strictEqual(n, 6)
  assert.deepStrictEqual(fs.readdirSync(path.join(d, 'thumbs', 's1')), [])
})

test('saveVideo streams to disk, links into the queue, and does not count toward the frame cap', async () => {
  const d = tmpdir()
  const s = new Storage({ storagePath: d, afterUpload: 'move', minFreeDiskMB: 0, maxCacheMB: 1 })
  await s.init()
  const big = Buffer.alloc(2 * 1024 * 1024, 7)
  const v = await s.saveVideo('trip.mp4', Readable.from([big.subarray(0, 1e6), big.subarray(1e6)]), { limit: 10e6, forUpload: true })
  assert.strictEqual(v.bytes, big.length)
  assert.ok(fs.existsSync(path.join(d, 'videos', 'trip.mp4')))
  assert.strictEqual(fs.statSync(path.join(d, 'queue', 'videos', 'trip.mp4')).ino, fs.statSync(path.join(d, 'videos', 'trip.mp4')).ino, 'hard link, no copy')
  assert.strictEqual(s.ingestBlocker(), null, 'a 2 MB video does not fill a 1 MB frame cache')
  await s.refreshStats()
  assert.strictEqual(s.ingestBlocker(), null)
  const [item] = await s.scanQueue()
  await s.afterUpload(item)
  assert.ok(fs.existsSync(path.join(d, 'videos', 'trip.mp4')), 'uploading never touches the saved copy')
  assert.deepStrictEqual((await s.listVideos()).map(x => [x.name, x.drive]), [['trip.mp4', 'uploaded']])
  await assert.rejects(s.saveVideo('trip.mp4', Readable.from([big]), { limit: 10e6 }), /exists/)
  await assert.rejects(s.saveVideo('../x.mp4', Readable.from([big]), { limit: 10e6 }), /invalid/)
  await assert.rejects(s.saveVideo('huge.mp4', Readable.from([big]), { limit: 1000 }), /too large/)
  assert.ok(!fs.existsSync(path.join(d, 'videos', 'huge.mp4')))
  assert.deepStrictEqual(fs.readdirSync(path.join(d, 'videos')).filter(f => f.startsWith('.tmp')), [])
  assert.strictEqual(await s.deleteVideo('trip.mp4'), 'videos/trip.mp4')
  assert.deepStrictEqual(await s.listVideos(), [])
})
