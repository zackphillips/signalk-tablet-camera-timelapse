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

test('same-millisecond frames do not overwrite each other', async () => {
  const d = tmpdir()
  const s = new Storage({ storagePath: d })
  await s.init()
  const t = new Date('2026-01-01T00:00:00Z')
  const a = await s.writeFrame({ sessionId: 's', captureDate: t, jpeg: JPEG })
  const b = await s.writeFrame({ sessionId: 's', captureDate: t, jpeg: JPEG })
  assert.notStrictEqual(a.base, b.base)
  assert.strictEqual((await s.scanQueue()).length, 2)
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

test('cache cap: blocks ingest when full, evicts uploaded files first', async () => {
  const d = tmpdir()
  const s = new Storage({ storagePath: d, afterUpload: 'move', maxCacheMB: 1, minFreeDiskMB: 0 })
  await s.init()
  const big = Buffer.alloc(400 * 1024, 1)
  big[0] = 0xff; big[1] = 0xd8
  for (let i = 0; i < 3; i++) await s.writeFrame({ sessionId: 's', captureDate: new Date(Date.UTC(2026, 0, 1, 0, 0, i)), jpeg: big })
  assert.strictEqual(s.ingestBlocker(), 'cache_full')
  // Upload two; still full because uploaded files count toward the cap.
  const items = await s.scanQueue()
  await s.afterUpload(items[0])
  await s.afterUpload(items[1])
  assert.strictEqual(s.ingestBlocker(), 'cache_full')
  const evicted = await s.evictForCap()
  assert.ok(evicted >= 1)
  assert.strictEqual(s.ingestBlocker(), null)
  assert.strictEqual((await s.scanQueue()).length, 1, 'queued frames are never evicted')
})

test('disk low blocks ingest', async () => {
  const d = tmpdir()
  const s = new Storage({ storagePath: d, minFreeDiskMB: 1e12 })
  await s.init()
  assert.strictEqual(s.ingestBlocker(), 'disk_low')
})
