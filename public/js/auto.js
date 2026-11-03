/*
 * Auto-condition evaluator. Shared by the browser wrapper and the server plugin
 * (UMD), so both sides apply identical rules.
 *
 * Rules:
 *  - The raw condition compares the latest value as a trimmed string.
 *  - Missing path, null/undefined value, or no update within staleSeconds
 *    makes the condition invalid, which is treated as false immediately
 *    (never capture on missing data).
 *  - Transitions between two valid states must hold for debounceSeconds
 *    before the debounced output flips.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.TimelapseAuto = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  function normalize (v, caseSensitive) {
    if (v === null || v === undefined) return null
    let s
    if (typeof v === 'object') {
      try { s = JSON.stringify(v) } catch (e) { return null }
    } else {
      s = String(v)
    }
    s = s.trim()
    return caseSensitive ? s : s.toLowerCase()
  }

  /** Pure comparison. Returns null when the value is missing/null. */
  function compare (value, cfg) {
    const a = normalize(value, !!cfg.autoCaseSensitive)
    if (a === null) return null
    const b = normalize(cfg.autoValue === undefined ? '' : cfg.autoValue, !!cfg.autoCaseSensitive)
    const eq = a === b
    return cfg.autoOperator === 'notEquals' ? !eq : eq
  }

  function isConfigured (cfg) {
    return !!(cfg && typeof cfg.autoPath === 'string' && cfg.autoPath.trim() &&
      (cfg.autoOperator === 'equals' || cfg.autoOperator === 'notEquals'))
  }

  /**
   * Stateful evaluator. Feed it updates with update(value, nowMs) and read
   * the debounced state with evaluate(nowMs).
   */
  function createEvaluator (cfg) {
    const staleMs = Math.max(0, Number(cfg.autoStaleSeconds ?? 120)) * 1000
    const debounceMs = Math.max(0, Number(cfg.autoDebounceSeconds ?? 30)) * 1000
    let lastValue
    let hasValue = false
    let lastUpdateAt = null
    let active = false
    let activeSince = null
    let pending = null // { target: bool, since: ms }

    function raw (now) {
      if (!hasValue || lastUpdateAt === null) return { valid: false, value: null, reason: 'missing' }
      if (staleMs > 0 && now - lastUpdateAt > staleMs) return { valid: false, value: null, reason: 'stale' }
      const r = compare(lastValue, cfg)
      if (r === null) return { valid: false, value: null, reason: 'null' }
      return { valid: true, value: r, reason: r ? 'match' : 'noMatch' }
    }

    function evaluate (now) {
      if (now === undefined) now = Date.now()
      const r = raw(now)
      if (!r.valid) {
        if (active) { active = false; activeSince = now }
        pending = null
      } else if (r.value !== active) {
        if (!pending || pending.target !== r.value) pending = { target: r.value, since: now }
        if (now - pending.since >= debounceMs) {
          active = r.value
          activeSince = now
          pending = null
        }
      } else {
        pending = null
      }
      return {
        active,
        activeSince,
        raw: r.valid ? r.value : false,
        reason: r.reason,
        pendingTarget: pending ? pending.target : null,
        pendingRemainingMs: pending ? Math.max(0, debounceMs - (now - pending.since)) : 0,
        lastValue: hasValue ? lastValue : null,
        lastUpdateAt
      }
    }

    function update (value, now) {
      if (now === undefined) now = Date.now()
      lastValue = value
      hasValue = value !== undefined
      lastUpdateAt = now
      return evaluate(now)
    }

    /** Seed the debounced state, e.g. from the server's evaluation on page load. */
    function seed (isActive, since) {
      active = !!isActive
      activeSince = since ?? null
      pending = null
    }

    return { update, evaluate, seed }
  }

  return { compare, normalize, isConfigured, createEvaluator }
})
