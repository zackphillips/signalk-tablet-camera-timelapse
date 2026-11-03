'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { DriveAuth } = require('../src/drive/oauth')
const { DriveTarget, APP_PROP_KEY } = require('../src/drive/target')
const { RateLimitError, AuthError, NetworkError } = require('../src/errors')

function tmpdir () { return fs.mkdtempSync(path.join(os.tmpdir(), 'sktl-drive-')) }

function res (status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  }
}

function mockFetch (handlers) {
  const calls = []
  const f = async (url, opts = {}) => {
    calls.push({ url, opts })
    for (const [match, fn] of handlers) if (match(url, opts)) return fn(url, opts, calls)
    throw new Error('unexpected ' + url)
  }
  f.calls = calls
  return f
}

test('device flow: pending -> authorized, token stored 0600', async (t) => {
  const d = tmpdir()
  let polls = 0
  const fetch = mockFetch([
    [(u) => u.includes('/device/code'), (u, o) => {
      assert.match(o.body, /scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file/)
      return res(200, { device_code: 'dc', user_code: 'ABCD-EFGH', verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 5 })
    }],
    [(u) => u.includes('/token'), () => (++polls < 2 ? res(428, { error: 'authorization_pending' }) : res(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'drive.file' }))]
  ])
  let changed = null
  const a = new DriveAuth({ dataDir: d, clientId: 'cid', clientSecret: 'sec', fetch, onChange: (e) => { changed = e } })
  const s = await a.startDeviceFlow()
  clearTimeout(a.pollTimer)
  assert.strictEqual(s.state, 'pending')
  assert.strictEqual(s.userCode, 'ABCD-EFGH')
  await a.pollOnce(); clearTimeout(a.pollTimer)
  assert.strictEqual(a.state(), 'pending')
  await a.pollOnce()
  assert.strictEqual(a.state(), 'authorized')
  assert.strictEqual(changed, 'authorized')
  const st = fs.statSync(path.join(d, 'drive-token.json'))
  assert.strictEqual(st.mode & 0o777, 0o600)
  assert.strictEqual(await a.getAccessToken(), 'at')
})

test('device flow: slow_down increases interval', async () => {
  const d = tmpdir()
  const fetch = mockFetch([
    [(u) => u.includes('/device/code'), () => res(200, { device_code: 'dc', user_code: 'X', verification_url: 'u', interval: 5 })],
    [(u) => u.includes('/token'), () => res(403, { error: 'slow_down' })]
  ])
  const a = new DriveAuth({ dataDir: d, clientId: 'c', clientSecret: 's', fetch })
  await a.startDeviceFlow(); clearTimeout(a.pollTimer)
  await a.pollOnce(); clearTimeout(a.pollTimer)
  assert.strictEqual(a.pending.intervalMs, 10000)
  a.stop()
})

test('refresh failure marks needs_auth', async () => {
  const d = tmpdir()
  fs.writeFileSync(path.join(d, 'drive-token.json'), JSON.stringify({ clientId: 'c', refresh_token: 'rt', access_token: 'old', expiresAt: 0 }))
  const fetch = mockFetch([[(u) => u.includes('/token'), () => res(400, { error: 'invalid_grant' })]])
  const a = new DriveAuth({ dataDir: d, clientId: 'c', clientSecret: 's', fetch })
  assert.strictEqual(a.state(), 'authorized')
  await assert.rejects(a.getAccessToken(), AuthError)
  assert.strictEqual(a.state(), 'needs_auth')
})

test('changing the client id invalidates the stored token', () => {
  const d = tmpdir()
  fs.writeFileSync(path.join(d, 'drive-token.json'), JSON.stringify({ clientId: 'old', refresh_token: 'rt' }))
  const a = new DriveAuth({ dataDir: d, clientId: 'new', clientSecret: 's' })
  assert.strictEqual(a.state(), 'needs_auth')
})

test('revoke deletes the token file', async () => {
  const d = tmpdir()
  fs.writeFileSync(path.join(d, 'drive-token.json'), JSON.stringify({ clientId: 'c', refresh_token: 'rt' }))
  const fetch = mockFetch([[(u) => u.includes('/revoke'), () => res(200, {})]])
  const a = new DriveAuth({ dataDir: d, clientId: 'c', clientSecret: 's', fetch })
  await a.revoke()
  assert.ok(!fs.existsSync(path.join(d, 'drive-token.json')))
  assert.strictEqual(a.state(), 'unauthorized')
})

function authStub () {
  let n = 0
  return { forced: 0, async getAccessToken (force) { if (force) this.forced++; return 'tok' + (n++) } }
}

test('target: creates root and session folder once, then caches', async () => {
  const d = tmpdir()
  const created = []
  const fetch = mockFetch([
    [(u, o) => u.includes('/drive/v3/files?q='), () => res(200, { files: [] })],
    [(u, o) => u.includes('/drive/v3/files?fields=id') && o.method === 'POST', (u, o) => { const b = JSON.parse(o.body); created.push(b); return res(200, { id: 'id-' + b.name }) }]
  ])
  const t = new DriveTarget({ auth: authStub(), fetch, folderCachePath: path.join(d, 'f.json'), rootName: 'Root' })
  await t.init()
  assert.strictEqual(await t.ensureFolder('s1'), 'id-s1')
  assert.strictEqual(await t.ensureFolder('s1'), 'id-s1')
  await t.ensureFolder('s2')
  assert.deepStrictEqual(created.map(c => c.name), ['Root', 's1', 's2'])
  assert.deepStrictEqual(created[1].parents, ['id-Root'])
  // cache persists across instances
  const t2 = new DriveTarget({ auth: authStub(), fetch, folderCachePath: path.join(d, 'f.json'), rootName: 'Root' })
  await t2.init()
  const before = fetch.calls.length
  assert.strictEqual(await t2.ensureFolder('s1'), 'id-s1')
  assert.strictEqual(fetch.calls.length, before)
})

test('target: multipart upload carries appProperties; 401 refreshes once', async () => {
  const d = tmpdir()
  const f = path.join(d, 'a.jpg')
  fs.writeFileSync(f, Buffer.from([0xff, 0xd8, 1, 2]))
  let first = true
  let body
  const fetch = mockFetch([
    [(u) => u.includes('uploadType=multipart'), (u, o) => {
      if (first) { first = false; return res(401, {}) }
      body = o.body.toString('binary')
      return res(200, { id: 'x' })
    }]
  ])
  const auth = authStub()
  const t = new DriveTarget({ auth, fetch, folderCachePath: path.join(d, 'f.json') })
  await t.upload({ filePath: f, name: 'a.jpg', mimeType: 'image/jpeg', size: 4, localKey: 's1/a.jpg', folderRef: 'fid' })
  assert.strictEqual(auth.forced, 1)
  assert.match(body, new RegExp(`"appProperties":\\{"${APP_PROP_KEY}":"s1/a.jpg"\\}`))
  assert.match(body, /"parents":\["fid"\]/)
})

test('target: resumable upload above 5 MB', async () => {
  const d = tmpdir()
  const f = path.join(d, 'big.jpg')
  fs.writeFileSync(f, Buffer.alloc(6 * 1024 * 1024))
  const fetch = mockFetch([
    [(u) => u.includes('uploadType=resumable'), () => res(200, {}, { location: 'https://upload.example/session1' })],
    [(u) => u === 'https://upload.example/session1', (u, o) => { assert.strictEqual(o.method, 'PUT'); return res(200, { id: 'y' }) }]
  ])
  const t = new DriveTarget({ auth: authStub(), fetch, folderCachePath: path.join(d, 'f.json') })
  await t.upload({ filePath: f, name: 'big.jpg', mimeType: 'image/jpeg', size: 6 * 1024 * 1024, localKey: 's/big.jpg', folderRef: 'fid' })
  assert.strictEqual(fetch.calls.length, 2)
})

test('target: error classification', async () => {
  const d = tmpdir()
  const mk = (r) => new DriveTarget({ auth: authStub(), fetch: async () => r, folderCachePath: path.join(d, 'f.json') })
  await assert.rejects(mk(res(429, {}, { 'retry-after': '7' })).exists('k', 'p'), (e) => e instanceof RateLimitError && e.retryAfterMs === 7000)
  await assert.rejects(mk(res(403, '{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}')).exists('k', 'p'), RateLimitError)
  await assert.rejects(mk(res(503, {})).exists('k', 'p'), NetworkError)
  const t = new DriveTarget({ auth: authStub(), fetch: async () => { throw new TypeError('fetch failed') }, folderCachePath: path.join(d, 'f.json') })
  await assert.rejects(t.exists('k', 'p'), NetworkError)
})

test('target: exists queries by appProperties', async () => {
  const d = tmpdir()
  let q
  const t = new DriveTarget({ auth: authStub(), fetch: async (u) => { q = decodeURIComponent(u); return res(200, { files: [{ id: '1' }] }) }, folderCachePath: path.join(d, 'f.json') })
  assert.strictEqual(await t.exists("s1/it's.jpg", 'fid'), true)
  assert.match(q, /appProperties has \{ key='skTimelapseLocal' and value='s1\/it\\'s.jpg' \}/)
})

test('target: parallel ensureFolder calls create each folder once', async () => {
  const d = tmpdir()
  const created = []
  const fetch = mockFetch([
    [(u) => u.includes('/drive/v3/files?q='), async () => { await new Promise(r => setTimeout(r, 5)); return res(200, { files: [] }) }],
    [(u, o) => o.method === 'POST', (u, o) => { const b = JSON.parse(o.body); created.push(b.name); return res(200, { id: 'id-' + b.name }) }]
  ])
  const t = new DriveTarget({ auth: authStub(), fetch, folderCachePath: path.join(d, 'f.json'), rootName: 'Root' })
  const ids = await Promise.all([t.ensureFolder('s1'), t.ensureFolder('s1'), t.ensureFolder('s1'), t.ensureFolder('s2')])
  assert.deepStrictEqual(ids, ['id-s1', 'id-s1', 'id-s1', 'id-s2'])
  assert.deepStrictEqual(created.sort(), ['Root', 's1', 's2'])
})
