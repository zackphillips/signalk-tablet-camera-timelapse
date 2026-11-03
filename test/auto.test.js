'use strict'
const test = require('node:test')
const assert = require('node:assert')
const Auto = require('../public/js/auto')

const base = { autoPath: 'navigation.state', autoOperator: 'equals', autoValue: 'sailing', autoCaseSensitive: false, autoStaleSeconds: 120, autoDebounceSeconds: 30 }

test('compare: equals / notEquals, trimmed', () => {
  assert.strictEqual(Auto.compare(' sailing ', base), true)
  assert.strictEqual(Auto.compare('motoring', base), false)
  assert.strictEqual(Auto.compare('sailing', { ...base, autoOperator: 'notEquals' }), false)
  assert.strictEqual(Auto.compare('anchored', { ...base, autoOperator: 'notEquals' }), true)
  assert.strictEqual(Auto.compare(5, { ...base, autoValue: ' 5 ' }), true)
})

test('compare: case handling', () => {
  assert.strictEqual(Auto.compare('Sailing', base), true)
  assert.strictEqual(Auto.compare('Sailing', { ...base, autoCaseSensitive: true }), false)
  assert.strictEqual(Auto.compare('sailing', { ...base, autoCaseSensitive: true }), true)
})

test('compare: null and undefined are never a match, even for notEquals', () => {
  assert.strictEqual(Auto.compare(null, base), null)
  assert.strictEqual(Auto.compare(undefined, { ...base, autoOperator: 'notEquals' }), null)
})

test('isConfigured', () => {
  assert.ok(Auto.isConfigured(base))
  assert.ok(!Auto.isConfigured({ ...base, autoPath: ' ' }))
  assert.ok(!Auto.isConfigured({ ...base, autoOperator: 'gt' }))
})

test('evaluator: missing path is false', () => {
  const e = Auto.createEvaluator(base)
  const r = e.evaluate(0)
  assert.strictEqual(r.active, false)
  assert.strictEqual(r.reason, 'missing')
})

test('evaluator: debounce on start and stop', () => {
  const e = Auto.createEvaluator(base)
  assert.strictEqual(e.update('sailing', 0).active, false)
  assert.strictEqual(e.evaluate(29000).active, false)
  assert.strictEqual(e.evaluate(29000).pendingTarget, true)
  assert.strictEqual(e.evaluate(30000).active, true)
  // flap shorter than debounce does not stop
  e.update('motoring', 40000)
  assert.strictEqual(e.evaluate(50000).active, true)
  e.update('sailing', 55000)
  assert.strictEqual(e.evaluate(90000).active, true)
  // sustained change stops after debounce
  e.update('motoring', 100000)
  assert.strictEqual(e.evaluate(129999).active, true)
  assert.strictEqual(e.evaluate(130000).active, false)
})

test('evaluator: flapping restarts the debounce window', () => {
  const e = Auto.createEvaluator(base)
  e.update('sailing', 0)
  e.update('motoring', 20000)
  e.update('sailing', 25000)
  assert.strictEqual(e.evaluate(50000).active, false) // only 25 s since last flip
  assert.strictEqual(e.evaluate(55000).active, true)
})

test('evaluator: stale data stops immediately, no debounce', () => {
  const e = Auto.createEvaluator({ ...base, autoDebounceSeconds: 0 })
  e.update('sailing', 0)
  assert.strictEqual(e.evaluate(0).active, true)
  assert.strictEqual(e.evaluate(120000).active, true)
  const r = e.evaluate(120001)
  assert.strictEqual(r.active, false)
  assert.strictEqual(r.reason, 'stale')
})

test('evaluator: staleSeconds 0 disables staleness', () => {
  const e = Auto.createEvaluator({ ...base, autoStaleSeconds: 0, autoDebounceSeconds: 0 })
  e.update('sailing', 0)
  assert.strictEqual(e.evaluate(10 * 3600 * 1000).active, true)
})

test('evaluator: null value stops immediately', () => {
  const e = Auto.createEvaluator({ ...base, autoDebounceSeconds: 10 })
  e.update('sailing', 0)
  assert.strictEqual(e.evaluate(10000).active, true)
  const r = e.update(null, 11000)
  assert.strictEqual(r.active, false)
  assert.strictEqual(r.reason, 'null')
})

test('evaluator: seed keeps an active session across reload', () => {
  const e = Auto.createEvaluator(base)
  e.seed(true, 0)
  assert.strictEqual(e.update('sailing', 1000).active, true)
})

test('evaluator: a seeded old timestamp goes stale on schedule, not a full window later', () => {
  const e = Auto.createEvaluator({ ...base, autoDebounceSeconds: 0 })
  e.update('sailing', 0) // value last seen at t=0
  assert.strictEqual(e.evaluate(119000).active, true)
  assert.strictEqual(e.evaluate(121000).reason, 'stale')
})
