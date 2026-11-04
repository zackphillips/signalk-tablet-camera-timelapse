// Per-tablet preferences in localStorage. Same-origin iframes (Freeboard
// runtime and panel, KIP page) share them. Every access is guarded because
// storage can be blocked.
const PREFIX = 'sktl:'
export const prefs = {
  get (k, d) {
    try { const v = localStorage.getItem(PREFIX + k); return v === null ? d : JSON.parse(v) } catch (e) { return d }
  },
  set (k, v) {
    try {
      if (v === null || v === undefined) localStorage.removeItem(PREFIX + k)
      else localStorage.setItem(PREFIX + k, JSON.stringify(v))
    } catch (e) { /* storage blocked */ }
  }
}
