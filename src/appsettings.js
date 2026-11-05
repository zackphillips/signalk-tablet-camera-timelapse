'use strict'

/*
 * Settings changed from the app (the panel in Freeboard, the KIP page, the
 * standalone page) rather than the server's plugin config. Stored on the Pi
 * so they survive reloads and apply to every tablet. The plugin config holds
 * the defaults; a value set in the app wins until it is reset (null).
 */

const STAMP_POSITIONS = ['off', 'bottom-left', 'bottom-right', 'top-left', 'top-right']
const MIN_INTERVAL = 1
const MAX_INTERVAL = 3600

/**
 * Validate a partial update. Returns { value } with only the keys given
 * (null means "back to the default"), or { error }.
 */
function parseUpdate (body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be a JSON object' }
  const value = {}
  if ('intervalSeconds' in body) {
    const v = body.intervalSeconds
    if (v === null) value.intervalSeconds = null
    else if (typeof v !== 'number' || !Number.isFinite(v) || v < MIN_INTERVAL || v > MAX_INTERVAL) {
      return { error: `intervalSeconds must be a number from ${MIN_INTERVAL} to ${MAX_INTERVAL}` }
    } else value.intervalSeconds = Math.round(v * 10) / 10
  }
  if ('stamp' in body) {
    const v = body.stamp
    if (v === null) value.stamp = null
    else if (!STAMP_POSITIONS.includes(v)) return { error: `stamp must be one of ${STAMP_POSITIONS.join(', ')}` }
    else value.stamp = v
  }
  if (!Object.keys(value).length) return { error: 'nothing to change (intervalSeconds, stamp)' }
  return { value }
}

/** Apply a parsed update to the stored overrides; null removes an override. */
function applyUpdate (stored, update) {
  const out = { ...stored }
  for (const [k, v] of Object.entries(update)) {
    if (v === null) delete out[k]
    else out[k] = v
  }
  return out
}

/** Stored overrides from disk, dropping anything invalid. */
function sanitizeStored (raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const k of ['intervalSeconds', 'stamp']) {
    if (raw[k] === undefined || raw[k] === null) continue
    const r = parseUpdate({ [k]: raw[k] })
    if (r.value) out[k] = r.value[k]
  }
  return out
}

function effective (stored, opts) {
  return {
    intervalSeconds: stored.intervalSeconds !== undefined ? stored.intervalSeconds : opts.intervalSeconds,
    stamp: stored.stamp !== undefined ? stored.stamp : 'off'
  }
}

module.exports = { STAMP_POSITIONS, MIN_INTERVAL, MAX_INTERVAL, parseUpdate, applyUpdate, sanitizeStored, effective }
