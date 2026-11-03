'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Storage } = require('../src/storage')
const { Uploader, MAX_BACKOFF_MS } = require('../src/uploader')
const { NetworkError, RateLimitError, AuthError, HttpError, DriveFullError } = require('../src/errors')

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
function tmpdir () { return fs.mkdtempSync(path.join(os.tmpdir(), 'sktl-up-')) }

/** In-memory Drive: tracks files by localKey, can be told to fail. */
function fakeTarget () {
  const t = {
    files: new Map(),
    folders: new Map(),
    calls: { upload: 0, exists: 0 },
    failNext: [],
    async ensureFolder (s) { if (!t.folders.has(s)) t.folders.set(s, 'f-' + s); return t.folders.get(s) },
    async exists (key) { t.calls.exists++; return t.files.has(key) },
    async upload (o) {
      t.calls.upload++
      const f = t.failNext.shift()
      if (f) {
        if (f.afterStore) t.files.set(o.localKey, o) // succeeded server-side, response lost
        throw f.err
      }
      if (t.files.has(o.localKey)) t.dupes = (t.dupes || 0) + 1
      t.files.set(o.localKey, o)
    },
    async invalidate () { t.invalidated = (t.invalidated || 0) + 1 }
  }
  return t
}

async function setup (n = 3, opts = {}) {
  const d = tmpdir()
  const storage = new Storage({ storagePath: path.join(d, 'frames'), afterUpload: 'move', minFreeDiskMB: 0, ...opts })
  await storage.init()
  for (let i = 0; i < n; i++) {
    await storage.writeFrame({ sessionId: 's1', captureDate: new Date(Date.UTC(2026, 0, 1, 0, 0, i)), jpeg: JPEG, sidecar: { i } })
  }
  const target = fakeTarget()
  const up = new Uploader({ storage, target, dataDir: d, intervalSeconds: 60, random: () => 0.5 })
  up.stopped = false
  up.schedule = () => {} // drive passes manually
  return { d, storage, target, up }
}

test('uploads everything oldest first and applies afterUpload', async () => {
  const { storage, target, up } = await setup(3)
  const order = []
  const orig = target.upload
  target.upload = async (o) => { order.push(o.localKey); return orig(o) }
  await up.runPass()
  assert.strictEqual(target.files.size, 6)
  assert.deepStrictEqual(order.slice(0, 2), ['s1/2026-01-01T00-00-00-000Z.jpg', 's1/2026-01-01T00-00-00-000Z.json'])
  assert.strictEqual((await storage.scanQueue()).length, 0)
  assert.strictEqual(up.state, 'idle')
  assert.strictEqual(target.calls.exists, 0, 'no existence checks on the happy path')
})

test('network failure stops the pass and backs off exponentially, capped at 15 min', async () => {
  const { storage, target, up } = await setup(3)
  const delays = []
  for (let i = 0; i < 8; i++) {
    target.failNext.push({ err: new NetworkError('offline') })
    delays.push(await up.runPass())
  }
  assert.strictEqual(target.calls.upload, 8, 'one attempt per pass, then stop')
  assert.deepStrictEqual(delays.slice(0, 4), [60000, 120000, 240000, 480000])
  assert.strictEqual(delays[7], MAX_BACKOFF_MS)
  assert.strictEqual(up.state, 'offline')
  assert.strictEqual((await storage.scanQueue()).length, 6, 'nothing lost')
  await up.runPass()
  assert.strictEqual(up.state, 'idle')
  assert.strictEqual(up.failures, 0)
  assert.strictEqual(target.files.size, 6)
})

test('rate limit backs off with jitter and honors Retry-After', async () => {
  const { target, up } = await setup(1)
  up.random = () => 0 // jitter factor 0.5
  target.failNext.push({ err: new RateLimitError('429') })
  assert.strictEqual(await up.runPass(), 30000)
  up.random = () => 0.999
  target.failNext.push({ err: new RateLimitError('429') })
  assert.ok(Math.abs((await up.runPass()) - 180000) < 1000)
  target.failNext.push({ err: new RateLimitError('429', 900000) })
  assert.ok((await up.runPass()) >= 900000)
  assert.strictEqual(up.state, 'rate_limited')
})

test('auth error stops the pass and reports needs_auth', async () => {
  const { target, up } = await setup(2)
  target.failNext.push({ err: new AuthError('refresh failed') })
  await up.runPass()
  assert.strictEqual(up.state, 'needs_auth')
  assert.strictEqual(target.files.size, 0)
})

test('a lost response does not create a duplicate on retry (idempotency)', async () => {
  const { storage, target, up } = await setup(1)
  target.failNext.push({ err: new NetworkError('reset mid-upload'), afterStore: true })
  await up.runPass()
  assert.strictEqual(target.files.size, 1)
  await up.runPass()
  assert.strictEqual(target.dupes || 0, 0)
  assert.strictEqual(target.calls.exists, 1)
  assert.strictEqual(target.files.size, 2)
  assert.strictEqual((await storage.scanQueue()).length, 0)
})

test('crash mid-upload: new Uploader instance checks Drive before re-uploading', async () => {
  const { d, storage, target, up } = await setup(1)
  // Simulate: upload started (inflight recorded), file reached Drive, process died.
  const [item] = await storage.scanQueue()
  await up.inflight.add(item.key)
  target.files.set(item.key, {})
  const up2 = new Uploader({ storage, target, dataDir: d, intervalSeconds: 60 })
  up2.stopped = false
  up2.schedule = () => {}
  await up2.runPass()
  assert.strictEqual(target.dupes || 0, 0)
  assert.strictEqual(target.calls.exists, 1)
  assert.strictEqual((await storage.scanQueue()).length, 0)
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(d, 'inflight.json'))), [])
})

test('a per-file HTTP error skips that file and continues', async () => {
  const { storage, target, up } = await setup(2)
  target.failNext.push({ err: new HttpError('bad', 400) })
  await up.runPass()
  assert.strictEqual(target.files.size, 3)
  assert.strictEqual((await storage.scanQueue()).length, 1)
  assert.strictEqual(up.state, 'error')
  await up.runPass()
  assert.strictEqual((await storage.scanQueue()).length, 0)
})

test('404 invalidates folder cache', async () => {
  const { target, up } = await setup(1)
  target.failNext.push({ err: new HttpError('gone', 404) })
  await up.runPass()
  assert.strictEqual(target.invalidated, 1)
})

test('concurrency > 1 uploads each file exactly once', async () => {
  const { storage, target, up } = await setup(10)
  up.concurrency = 4
  await up.runPass()
  assert.strictEqual(target.files.size, 20)
  assert.strictEqual(target.dupes || 0, 0)
  assert.strictEqual((await storage.scanQueue()).length, 0)
})

test('not ready (no auth) skips without touching the queue', async () => {
  const { target, up } = await setup(1)
  up.isReady = () => false
  await up.runPass()
  assert.strictEqual(target.calls.upload, 0)
  assert.strictEqual(up.state, 'needs_auth')
})

test('Drive full stops the pass and waits the max backoff', async () => {
  const { storage, target, up } = await setup(2)
  target.failNext.push({ err: new DriveFullError('full') })
  assert.strictEqual(await up.runPass(), MAX_BACKOFF_MS)
  assert.strictEqual(up.state, 'drive_full')
  assert.strictEqual(target.calls.upload, 1)
  assert.strictEqual((await storage.scanQueue()).length, 4)
})
