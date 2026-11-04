'use strict'
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { pathToFileURL } = require('url')

let describe
test.before(async () => {
  // auto.js is UMD and expects a browser-style global.
  globalThis.self = globalThis
  ;({ describe } = await import(pathToFileURL(path.join(__dirname, '..', 'public/js/core/ui.js')).href))
})

const base = () => ({
  secure: true,
  mode: 'on',
  capturing: true,
  cfg: { intervalSeconds: 10, auto: { configured: true } },
  status: { ingestBlocked: null, queue: { count: 0 }, drive: { enabled: false, auth: { state: 'unconfigured' }, uploader: null } },
  camera: { error: null },
  auto: { active: false, reason: 'missing' }
})

test('capturing, waiting and off', () => {
  assert.strictEqual(describe(base()).dot, 'capturing')
  assert.strictEqual(describe({ ...base(), capturing: false }).dot, 'waiting')
  assert.strictEqual(describe({ ...base(), mode: 'off', capturing: false }).dot, 'off')
  assert.match(describe(base()).detail, /every 10 s/)
})

test('problems turn the dot yellow, most important first', () => {
  assert.strictEqual(describe(base(), false).problem, 'Capture engine not running on this tablet')
  assert.match(describe({ ...base(), secure: false }).problem, /secure context/)
  assert.match(describe({ ...base(), camera: { error: 'denied' } }).problem, /denied/)
  const s = base(); s.status.ingestBlocked = 'cache_full'
  assert.match(describe(s).problem, /cache full/)
  assert.strictEqual(describe(s).dot, 'error')
  assert.match(describe({ ...base(), configError: 'auth' }).problem, /read\/write/)
})

test('an insecure context does not matter while off', () => {
  const d = describe({ ...base(), mode: 'off', capturing: false, secure: false })
  assert.strictEqual(d.problem, null)
  assert.strictEqual(d.dot, 'off')
})

test('Drive backlog only when frames are queued and Drive is not connected', () => {
  const s = base()
  s.status.drive = { enabled: true, auth: { state: 'unauthorized' }, uploader: null }
  assert.strictEqual(describe(s).problem, null)
  s.status.queue.count = 5
  assert.match(describe(s).problem, /Drive not connected/)
})
