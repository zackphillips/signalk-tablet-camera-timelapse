'use strict'
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { pathToFileURL } = require('url')
const S = require('../src/appsettings')

test('parseUpdate accepts partial updates and nulls', () => {
  assert.deepStrictEqual(S.parseUpdate({ intervalSeconds: 5 }), { value: { intervalSeconds: 5 } })
  assert.deepStrictEqual(S.parseUpdate({ intervalSeconds: 2.55 }), { value: { intervalSeconds: 2.6 } })
  assert.deepStrictEqual(S.parseUpdate({ stamp: 'top-right', intervalSeconds: null }), { value: { stamp: 'top-right', intervalSeconds: null } })
})

test('parseUpdate rejects bad values and empty bodies', () => {
  for (const b of [{ intervalSeconds: 0 }, { intervalSeconds: 7200 }, { intervalSeconds: '5' }, { intervalSeconds: NaN }, { stamp: 'middle' }, {}, null, [], { other: 1 }]) {
    assert.ok(S.parseUpdate(b).error, JSON.stringify(b))
  }
})

test('overrides win over plugin defaults until reset', () => {
  const opts = { intervalSeconds: 10 }
  let stored = {}
  assert.deepStrictEqual(S.effective(stored, opts), { intervalSeconds: 10, stamp: 'off' })
  stored = S.applyUpdate(stored, { intervalSeconds: 3, stamp: 'bottom-left' })
  assert.deepStrictEqual(S.effective(stored, opts), { intervalSeconds: 3, stamp: 'bottom-left' })
  stored = S.applyUpdate(stored, { intervalSeconds: null })
  assert.deepStrictEqual(stored, { stamp: 'bottom-left' })
  assert.deepStrictEqual(S.effective(stored, opts), { intervalSeconds: 10, stamp: 'bottom-left' })
})

test('sanitizeStored drops junk from a hand-edited file', () => {
  assert.deepStrictEqual(S.sanitizeStored({ intervalSeconds: -1, stamp: 'top-left', extra: true }), { stamp: 'top-left' })
  assert.deepStrictEqual(S.sanitizeStored('nope'), {})
})

test('stamp text and layout', async () => {
  const { formatStamp, stampLayout } = await import(pathToFileURL(path.join(__dirname, '..', 'public/js/core/stamp.js')).href)
  assert.match(formatStamp(new Date(2026, 10, 4, 7, 3, 9)), /^2026-11-04 07:03:09( \S+)?$/)
  const br = stampLayout(4000, 3000, 'bottom-right', 500)
  assert.strictEqual(br.size, 105) // 3.5 % of the short side
  assert.ok(br.x + br.bw < 4000 && br.y + br.bh < 3000 && br.x > 3000 && br.y > 2700)
  const tl = stampLayout(480, 270, 'top-left', 100)
  assert.strictEqual(tl.size, 12) // floor for small frames
  assert.ok(tl.x > 0 && tl.y > 0 && tl.x < 20 && tl.y < 20)
})
