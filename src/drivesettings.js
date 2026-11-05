'use strict'

/*
 * Google Drive settings changed from the app. Stored on the Pi in
 * drive-settings.json (0600: it can hold a client secret). The plugin config
 * supplies the defaults, so older installs keep working unchanged.
 */

const AFTER_UPLOAD = ['move', 'delete', 'keep']
const FIELDS = ['enabled', 'folderName', 'afterUpload', 'keepUploadedDays', 'shareLinks', 'useOwnClient', 'clientId', 'clientSecret']

function parseUpdate (body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be a JSON object' }
  const value = {}
  for (const k of Object.keys(body)) {
    if (!FIELDS.includes(k)) return { error: `unknown field ${k}` }
    const v = body[k]
    if (v === null) { value[k] = null; continue }
    switch (k) {
      case 'enabled': case 'shareLinks': case 'useOwnClient':
        if (typeof v !== 'boolean') return { error: `${k} must be true or false` }
        break
      case 'folderName':
        if (typeof v !== 'string' || !v.trim() || v.length > 100 || /[/\\]/.test(v)) return { error: 'folderName must be 1-100 characters without slashes' }
        value[k] = v.trim()
        continue
      case 'afterUpload':
        if (!AFTER_UPLOAD.includes(v)) return { error: `afterUpload must be one of ${AFTER_UPLOAD.join(', ')}` }
        break
      case 'keepUploadedDays':
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 3650) return { error: 'keepUploadedDays must be 0 to 3650' }
        value[k] = Math.round(v)
        continue
      case 'clientId':
        if (typeof v !== 'string' || v.length > 300) return { error: 'clientId must be a string' }
        value[k] = v.trim()
        continue
      case 'clientSecret':
        if (typeof v !== 'string' || v.length > 300) return { error: 'clientSecret must be a string' }
        value[k] = v.trim()
        continue
    }
    value[k] = v
  }
  if (!Object.keys(value).length) return { error: 'nothing to change' }
  return { value }
}

function applyUpdate (stored, update) {
  const out = { ...stored }
  for (const [k, v] of Object.entries(update)) {
    if (v === null) delete out[k]
    else out[k] = v
  }
  return out
}

function sanitizeStored (raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const k of FIELDS) {
    if (raw[k] === undefined || raw[k] === null) continue
    const r = parseUpdate({ [k]: raw[k] })
    if (r.value) out[k] = r.value[k]
  }
  return out
}

const pick = (stored, k, dflt) => (stored[k] !== undefined ? stored[k] : dflt)

/** Effective settings, with credentials resolved. Never send this object to a client as is. */
function resolve (stored, opts, builtin) {
  const pd = opts.drive || {}
  const ownId = pick(stored, 'clientId', pd.clientId || '')
  const ownSecret = pick(stored, 'clientSecret', pd.clientSecret || '')
  // Installs that already use their own client keep it until changed here.
  const useOwnClient = pick(stored, 'useOwnClient', !!(pd.clientId && pd.clientSecret))
  const builtinAvailable = !!(builtin && builtin.clientId && builtin.clientSecret)
  let clientId = ''
  let clientSecret = ''
  let clientSource = 'none'
  if (useOwnClient) {
    if (ownId && ownSecret) { clientId = ownId; clientSecret = ownSecret; clientSource = 'own' }
  } else if (builtinAvailable) {
    clientId = builtin.clientId; clientSecret = builtin.clientSecret; clientSource = 'builtin'
  }
  return {
    enabled: pick(stored, 'enabled', !!pd.enabled),
    folderName: pick(stored, 'folderName', pd.folderName || 'Signal K Timelapse'),
    afterUpload: pick(stored, 'afterUpload', opts.afterUpload || 'move'),
    keepUploadedDays: pick(stored, 'keepUploadedDays', opts.keepUploadedDays !== undefined ? opts.keepUploadedDays : 7),
    shareLinks: pick(stored, 'shareLinks', true),
    useOwnClient,
    ownClientId: ownId,
    hasOwnSecret: !!ownSecret,
    builtinAvailable,
    clientSource,
    clientId,
    clientSecret
  }
}

/** What the app may see: no secrets. */
function publicView (r) {
  const { clientSecret, clientId, ...rest } = r
  return rest
}

module.exports = { AFTER_UPLOAD, FIELDS, parseUpdate, applyUpdate, sanitizeStored, resolve, publicView }
