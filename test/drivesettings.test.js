'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const D = require('../src/drivesettings')
const { DriveTarget } = require('../src/drive/target')
const { HttpError } = require('../src/errors')

const BUILTIN = { clientId: 'builtin.apps.googleusercontent.com', clientSecret: 'bsecret' }
const OPTS = { afterUpload: 'move', keepUploadedDays: 7, drive: { enabled: false, folderName: 'Signal K Timelapse', clientId: '', clientSecret: '' } }

test('parseUpdate validates every field', () => {
  assert.deepStrictEqual(D.parseUpdate({ enabled: true, folderName: '  Mermug  ', keepUploadedDays: 3.4 }).value, { enabled: true, folderName: 'Mermug', keepUploadedDays: 3 })
  for (const b of [{ enabled: 'yes' }, { folderName: 'a/b' }, { folderName: '' }, { afterUpload: 'archive' }, { keepUploadedDays: -1 }, { clientId: 5 }, { other: 1 }, {}, null]) {
    assert.ok(D.parseUpdate(b).error, JSON.stringify(b))
  }
})

test('built-in client by default; own client only when chosen and complete', () => {
  let r = D.resolve({}, OPTS, BUILTIN)
  assert.strictEqual(r.clientSource, 'builtin')
  assert.strictEqual(r.clientId, BUILTIN.clientId)
  assert.strictEqual(r.shareLinks, true)
  assert.strictEqual(r.enabled, false)
  r = D.resolve({ useOwnClient: true }, OPTS, BUILTIN)
  assert.strictEqual(r.clientSource, 'none', 'own chosen but not entered')
  r = D.resolve({ useOwnClient: true, clientId: 'mine', clientSecret: 's' }, OPTS, BUILTIN)
  assert.strictEqual(r.clientSource, 'own')
  assert.strictEqual(r.clientId, 'mine')
  assert.strictEqual(D.resolve({}, OPTS, { clientId: '', clientSecret: '' }).clientSource, 'none')
})

test('installs with credentials in the plugin config keep using them', () => {
  const opts = { ...OPTS, drive: { ...OPTS.drive, enabled: true, clientId: 'old', clientSecret: 'oldsec' } }
  const r = D.resolve({}, opts, BUILTIN)
  assert.strictEqual(r.clientSource, 'own')
  assert.strictEqual(r.clientId, 'old')
  assert.strictEqual(r.enabled, true)
})

test('the public view never carries a secret or the resolved client', () => {
  const v = D.publicView(D.resolve({ useOwnClient: true, clientId: 'mine', clientSecret: 'topsecret' }, OPTS, BUILTIN))
  assert.ok(!JSON.stringify(v).includes('topsecret'))
  assert.ok(!JSON.stringify(v).includes('bsecret'))
  assert.strictEqual(v.hasOwnSecret, true)
  assert.strictEqual(v.ownClientId, 'mine')
})

test('null resets a field to the plugin default', () => {
  const s = D.applyUpdate({ folderName: 'X', enabled: true }, { folderName: null })
  assert.deepStrictEqual(s, { enabled: true })
  assert.deepStrictEqual(D.sanitizeStored({ enabled: 'x', folderName: 'ok', junk: 1 }), { folderName: 'ok' })
})

// ---------- link sharing on the Drive target ----------
function res (status, body) {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) }
}
function fakeDrive () {
  const calls = []
  let n = 0
  const fetch = async (url, opts = {}) => {
    const m = opts.method || 'GET'
    calls.push(`${m} ${url.replace('https://www.googleapis.com/drive/v3', '')}`)
    if (m === 'GET' && url.includes('/files?q=')) return res(200, { files: [] })
    if (m === 'POST' && /\/files\?fields=id$/.test(url)) return res(200, { id: 'f' + (++n) })
    if (m === 'POST' && url.includes('/permissions')) {
      assert.deepStrictEqual(JSON.parse(opts.body), { type: 'anyone', role: 'reader', allowFileDiscovery: false })
      return fakeDrive.refuse ? res(403, { error: { reason: 'sharingRestricted' } }) : res(200, { id: 'anyoneWithLink' })
    }
    if (m === 'DELETE' && url.includes('/permissions/anyoneWithLink')) return res(204, {})
    throw new Error('unexpected ' + m + ' ' + url)
  }
  fetch.calls = calls
  return fetch
}
const auth = { getAccessToken: async () => 'tok' }

test('session folders get a view link when sharing is on, and lose it when turned off', async () => {
  fakeDrive.refuse = false
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sktl-share-'))
  let share = true
  const fetch = fakeDrive()
  const t = new DriveTarget({ auth, fetch, folderCachePath: path.join(dir, 'c.json'), rootName: 'Root', share: () => share })
  await t.init()
  const id = await t.ensureFolder('2026-11-05_120000')
  assert.ok(fetch.calls.some(c => c === `POST /files/${id}/permissions?fields=id`))
  assert.strictEqual(t.isShared('2026-11-05_120000'), true)
  assert.strictEqual(t.folderUrl('2026-11-05_120000'), `https://drive.google.com/drive/folders/${id}`)
  const before = fetch.calls.length
  await t.ensureFolder('2026-11-05_120000') // cached and already shared: no API calls
  await t.syncAllSharing()
  assert.strictEqual(fetch.calls.length, before)
  share = false
  await t.syncAllSharing()
  assert.ok(fetch.calls.includes(`DELETE /files/${id}/permissions/anyoneWithLink`))
  assert.strictEqual(t.isShared('2026-11-05_120000'), false)
  assert.ok(!JSON.parse(fs.readFileSync(path.join(dir, 'c.json'), 'utf8')).shared[id])
})

test('a refused share is logged once and does not block uploads', async () => {
  fakeDrive.refuse = true
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sktl-share-'))
  const fetch = fakeDrive()
  const errors = []
  const t = new DriveTarget({ auth, fetch, folderCachePath: path.join(dir, 'c.json'), rootName: 'Root', share: () => true, log: { debug () {}, error: (m) => errors.push(m) } })
  await t.init()
  const id = await t.ensureFolder('s1')
  assert.ok(id)
  assert.strictEqual(errors.length, 1)
  await t.ensureFolder('s1')
  await t.syncAllSharing()
  assert.strictEqual(fetch.calls.filter(c => c.includes('/permissions')).length, 1, 'not retried')
  t.resetShareRefusals()
  fakeDrive.refuse = false
  await t.syncAllSharing()
  assert.strictEqual(t.isShared('s1'), true)
  assert.ok(HttpError)
})
