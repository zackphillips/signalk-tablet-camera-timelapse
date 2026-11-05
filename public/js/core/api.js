// Plugin REST API, same-origin with the session cookie.
export const PLUGIN_ID = 'signalk-tablet-camera-timelapse'
const BASE = `/plugins/${PLUGIN_ID}`

export async function api (path, opts = {}) {
  const res = await fetch(BASE + path, { credentials: 'same-origin', ...opts })
  let body = null
  try { body = await res.json() } catch (e) { /* none */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || `HTTP ${res.status}`)
    err.status = res.status
    err.body = body
    throw err
  }
  return body
}

export const getClientConfig = () => api('/config/client')
export const getStatus = () => api('/status')
export const setMode = (mode) => api('/mode', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mode })
})
/** App settings stored on the Pi: { intervalSeconds, stamp }. null resets one to the plugin default. */
export const getSettings = () => api('/settings')
export const putSettings = (patch) => api('/settings', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(patch)
})
/** Drive settings on the Pi. The client secret is write-only. */
export const getDriveSettings = () => api('/drive/settings')
export const putDriveSettings = (patch) => api('/drive/settings', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(patch)
})
export const driveStart = () => api('/drive/auth/start', { method: 'POST' })
export const drivePoll = () => api('/drive/auth/poll')
export const driveRevoke = () => api('/drive/auth/revoke', { method: 'POST' })
export const uploadNow = () => api('/drive/upload-now', { method: 'POST' })

/** Gallery thumbnail for a frame. Best effort: one try, failures ignored. */
export async function uploadThumb ({ session, ts, blob, kind = 'thumb' }) {
  try {
    await fetch(`${BASE}/thumbs?${new URLSearchParams({ session, ts, kind })}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'image/jpeg' }, body: blob
    })
  } catch (e) { /* the gallery falls back to the full frame */ }
}

const UPLOAD_RETRIES = 3
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** POST one frame. Retries transient failures; 4xx (except 408/429) are permanent. */
export async function uploadFrame (frame, retries = UPLOAD_RETRIES) {
  const q = new URLSearchParams({
    ts: frame.ts,
    session: frame.session,
    mode: frame.mode,
    device: frame.device || '',
    w: frame.w || '',
    h: frame.h || ''
  })
  let lastErr
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${BASE}/frames?${q}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'image/jpeg' },
        body: frame.blob
      })
      let body = null
      try { body = await res.json() } catch (e) { /* none */ }
      if (res.ok) return body
      const err = new Error(
        res.status === 507 ? (body && body.error === 'disk_low' ? 'Pi disk space low' : 'Pi cache full')
          : res.status === 401 || res.status === 403 ? 'Not authorized to upload (needs a read/write login)'
            : (body && body.error) || `HTTP ${res.status}`)
      err.status = res.status
      err.code = body && body.error
      err.permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429
      throw err
    } catch (e) {
      lastErr = e
      if (e.permanent || e.status === 507) throw e
      if (i < retries - 1) await sleep(1000 * Math.pow(2, i))
    }
  }
  throw lastErr
}
