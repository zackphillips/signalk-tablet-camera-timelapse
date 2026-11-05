'use strict'
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { pathToFileURL } = require('url')

let pickResolution, resolutionOptions, resolutionValue
test.before(async () => {
  globalThis.self = globalThis
  ;({ pickResolution } = await import(pathToFileURL(path.join(__dirname, '..', 'public/js/core/camera.js')).href))
  ;({ resolutionOptions, resolutionValue } = await import(pathToFileURL(path.join(__dirname, '..', 'public/js/core/ui.js')).href))
})

// As computeResolutions lists them for a 12 MP sensor: max first.
const list = [
  { w: 4032, h: 3024, src: 'photo' },
  { w: 3024, h: 2268, src: 'photo' },
  { w: 2016, h: 1512, src: 'photo' },
  { w: 1008, h: 756, src: 'photo' }
]

test('lowest and highest pick by pixel count, whatever the list order', () => {
  assert.deepStrictEqual(pickResolution(list, 'lowest'), list[3])
  assert.deepStrictEqual(pickResolution(list, 'highest'), list[0])
  assert.deepStrictEqual(pickResolution([...list].reverse(), 'highest'), list[0])
  assert.strictEqual(pickResolution([], 'lowest'), null)
})

test('an exact size applies when this camera offers it, else falls back to lowest', () => {
  assert.deepStrictEqual(pickResolution(list, 'exact', { w: 2016, h: 1512 }), list[2])
  assert.deepStrictEqual(pickResolution(list, 'exact', { w: 640, h: 480 }), list[3])
  assert.deepStrictEqual(pickResolution(list, 'exact', null), list[3])
})

test('picker lists Lowest and Highest with their sizes, then every size', () => {
  const opts = resolutionOptions(list)
  assert.deepStrictEqual(opts.slice(0, 2), [
    { value: 'lowest', text: 'Lowest (1008 × 756)' },
    { value: 'highest', text: 'Highest (4032 × 3024)' }
  ])
  assert.deepStrictEqual(opts.slice(2).map(o => o.value), ['4032x3024', '3024x2268', '2016x1512', '1008x756'])
  assert.deepStrictEqual(resolutionOptions([]), [])
  assert.strictEqual(resolutionValue({ resChoice: 'highest', resolution: list[0] }), 'highest')
  assert.strictEqual(resolutionValue({ resChoice: 'exact', resolution: list[2] }), '2016x1512')
  assert.strictEqual(resolutionValue({ resChoice: undefined, resolution: null }), 'lowest')
})
