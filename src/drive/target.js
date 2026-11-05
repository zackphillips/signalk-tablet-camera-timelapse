'use strict'

/*
 * Google Drive v3 upload target, called through plain REST with fetch.
 *
 * Every target implements the same small interface so S3/WebDAV can be added:
 *   init()                          -> Promise<void>
 *   ensureFolder(sessionId)         -> Promise<folderRef>
 *   exists(localKey, folderRef)     -> Promise<boolean>
 *   upload({ filePath, name, mimeType, size, localKey, folderRef }) -> Promise<void>
 *   invalidate(sessionId)           -> drop cached folder refs after a 404
 *
 * Drive-only extras: link sharing of session folders (share()), and
 * folderUrl() for the gallery.
 */

const fs = require('fs')
const fsp = fs.promises
const { Readable } = require('stream')
const { NetworkError, RateLimitError, AuthError, HttpError, DriveFullError } = require('../errors')
const { atomicWrite } = require('../storage')

const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const RESUMABLE_THRESHOLD = 5 * 1024 * 1024
const APP_PROP_KEY = 'skTimelapseLocal'

function q (s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function parseRetryAfter (res) {
  const h = res.headers && res.headers.get && res.headers.get('retry-after')
  if (!h) return null
  const n = Number(h)
  return Number.isFinite(n) ? n * 1000 : null
}

class DriveTarget {
  constructor ({ auth, fetch: fetchFn, folderCachePath, rootName, log, share }) {
    this.auth = auth
    this.share = share || (() => false) // anyone with the link can view session folders
    this.fetch = fetchFn || globalThis.fetch
    this.folderCachePath = folderCachePath
    this.rootName = rootName || 'Signal K Timelapse'
    this.log = log || { debug () {}, error () {} }
    this.cache = { roots: {}, sessions: {}, shared: {} }
    this.inflight = new Map() // key -> Promise<id>, so parallel workers share one lookup/create
  }

  async init () {
    try {
      const c = JSON.parse(await fsp.readFile(this.folderCachePath, 'utf8'))
      this.cache = { roots: c.roots || {}, sessions: c.sessions || {}, shared: c.shared || {} }
    } catch (e) { /* first run */ }
  }

  saveCache () {
    const write = () => atomicWrite(this.folderCachePath, JSON.stringify(this.cache, null, 2))
    this.saving = (this.saving || Promise.resolve()).then(write, write)
    return this.saving
  }

  once (key, fn) {
    if (!this.inflight.has(key)) {
      this.inflight.set(key, fn().finally(() => this.inflight.delete(key)))
    }
    return this.inflight.get(key)
  }

  /** fetch with auth, 401 refresh-and-retry, and error classification. */
  async request (url, opts = {}, { timeoutMs = 60000, retried = false } = {}) {
    const token = await this.auth.getAccessToken(retried)
    let res
    try {
      res = await this.fetch(url, {
        ...opts,
        headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (e) {
      throw new NetworkError(`Drive request failed: ${e.message}`, e)
    }
    if (res.status === 401) {
      if (!retried) return this.request(url, opts, { timeoutMs, retried: true })
      throw new AuthError('Drive rejected the refreshed token')
    }
    if (res.status === 429) throw new RateLimitError('Drive rate limit (429)', parseRetryAfter(res))
    if (res.status >= 500) throw new NetworkError(`Drive returned ${res.status}`)
    if (res.status === 403) {
      const body = await res.text().catch(() => '')
      if (/storageQuotaExceeded/.test(body)) {
        throw new DriveFullError('Google Drive storage is full')
      }
      if (/"(rateLimitExceeded|userRateLimitExceeded)"/.test(body)) {
        throw new RateLimitError('Drive rate limit (403)', parseRetryAfter(res))
      }
      throw new HttpError(`Drive returned 403: ${body.slice(0, 300)}`, 403, body)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new HttpError(`Drive returned ${res.status}: ${body.slice(0, 300)}`, res.status, body)
    }
    return res
  }

  async json (url, opts, extra) {
    const res = await this.request(url, opts, extra)
    return res.json()
  }

  async findFolder (name, parentId) {
    const query = `mimeType='${FOLDER_MIME}' and name='${q(name)}' and '${q(parentId)}' in parents and trashed=false`
    const url = `${API}/files?q=${encodeURIComponent(query)}&fields=files(id,name)&spaces=drive&pageSize=10`
    const r = await this.json(url)
    return r.files && r.files.length ? r.files[0].id : null
  }

  async createFolder (name, parentId) {
    const r = await this.json(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] })
    })
    return r.id
  }

  async ensureRoot () {
    const cached = this.cache.roots[this.rootName]
    if (cached) return cached
    return this.once('root:' + this.rootName, async () => {
      const id = (await this.findFolder(this.rootName, 'root')) || (await this.createFolder(this.rootName, 'root'))
      this.cache.roots[this.rootName] = id
      await this.saveCache()
      return id
    })
  }

  async ensureFolder (sessionId) {
    const rootId = await this.ensureRoot()
    const key = `${rootId}/${sessionId}`
    const cached = this.cache.sessions[key]
    if (cached) { await this.syncShare(cached); return cached }
    const id = await this.once('session:' + key, async () => {
      const id = (await this.findFolder(sessionId, rootId)) || (await this.createFolder(sessionId, rootId))
      this.cache.sessions[key] = id
      await this.saveCache()
      return id
    })
    await this.syncShare(id)
    return id
  }

  // ---------- link sharing ----------

  /**
   * Make one session folder's link sharing match share(). Files inside
   * inherit it. A refusal (say, a Workspace domain that forbids link
   * sharing) is logged and not retried until the setting changes; it never
   * stops uploads.
   */
  async syncShare (folderId) {
    const want = !!this.share()
    const have = this.cache.shared[folderId]
    if (want === !!have || (have === 'refused' && want)) return
    return this.once('share:' + folderId, async () => {
      try {
        if (want) {
          await this.request(`${API}/files/${encodeURIComponent(folderId)}/permissions?fields=id`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'anyone', role: 'reader', allowFileDiscovery: false })
          })
          this.cache.shared[folderId] = true
        } else {
          try {
            await this.request(`${API}/files/${encodeURIComponent(folderId)}/permissions/anyoneWithLink`, { method: 'DELETE' })
          } catch (e) {
            if (!(e instanceof HttpError && e.status === 404)) throw e // already private
          }
          delete this.cache.shared[folderId]
        }
      } catch (e) {
        if (!(e instanceof HttpError)) throw e
        this.log.error(`link sharing for folder ${folderId}: ${e.message}`)
        if (want) this.cache.shared[folderId] = 'refused'
        else delete this.cache.shared[folderId]
      }
      await this.saveCache()
    })
  }

  /** Apply the sharing setting to every session folder we know of. Cheap when nothing changed. */
  async syncAllSharing () {
    const rootId = this.cache.roots[this.rootName]
    if (!rootId) return
    const prefix = rootId + '/'
    const want = !!this.share()
    for (const [key, id] of Object.entries(this.cache.sessions)) {
      if (!key.startsWith(prefix)) continue
      const have = this.cache.shared[id]
      if (want ? !have : have) await this.syncShare(id)
    }
  }

  /** Forget 'refused' marks so a changed setting is tried again. */
  resetShareRefusals () {
    for (const [id, v] of Object.entries(this.cache.shared)) if (v === 'refused') delete this.cache.shared[id]
  }

  /** Drive web link to a session's folder, if we have created it. */
  folderUrl (sessionId) {
    const rootId = this.cache.roots[this.rootName]
    const id = rootId && this.cache.sessions[`${rootId}/${sessionId}`]
    return id ? `https://drive.google.com/drive/folders/${id}` : null
  }

  isShared (sessionId) {
    const rootId = this.cache.roots[this.rootName]
    const id = rootId && this.cache.sessions[`${rootId}/${sessionId}`]
    return !!(id && this.cache.shared[id] === true)
  }

  /** Forget cached folder ids (e.g. the user deleted the folder in Drive). */
  async invalidate (sessionId) {
    const rootId = this.cache.roots[this.rootName]
    delete this.cache.roots[this.rootName]
    if (rootId) delete this.cache.sessions[`${rootId}/${sessionId}`]
    await this.saveCache()
  }

  /** Drive id of the file we uploaded for this local key, anywhere in our folders, or null. */
  async findByKey (localKey) {
    const query = `appProperties has { key='${APP_PROP_KEY}' and value='${q(localKey)}' } and trashed=false`
    const url = `${API}/files?q=${encodeURIComponent(query)}&fields=files(id)&spaces=drive&pageSize=10`
    const r = await this.json(url)
    return (r.files || []).map(f => f.id)
  }

  /** Session folder id if it exists (never creates one). */
  async findSessionFolder (sessionId) {
    const rootId = this.cache.roots[this.rootName] || (await this.findFolder(this.rootName, 'root'))
    if (!rootId) return null
    return this.cache.sessions[`${rootId}/${sessionId}`] || (await this.findFolder(sessionId, rootId))
  }

  /** Move a file or folder to Drive's trash (recoverable for 30 days). */
  async trash (id) {
    await this.request(`${API}/files/${encodeURIComponent(id)}?fields=id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true })
    })
  }

  async exists (localKey, folderId) {
    const query = `appProperties has { key='${APP_PROP_KEY}' and value='${q(localKey)}' } and '${q(folderId)}' in parents and trashed=false`
    const url = `${API}/files?q=${encodeURIComponent(query)}&fields=files(id)&spaces=drive&pageSize=1`
    const r = await this.json(url)
    return !!(r.files && r.files.length)
  }

  async upload ({ filePath, name, mimeType, size, localKey, folderRef }) {
    const meta = { name, parents: [folderRef], appProperties: { [APP_PROP_KEY]: localKey } }
    if (size === undefined || size === null) size = (await fsp.stat(filePath)).size
    if (size <= RESUMABLE_THRESHOLD) {
      const data = await fsp.readFile(filePath)
      const boundary = 'sktl' + Math.random().toString(16).slice(2)
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
        data,
        Buffer.from(`\r\n--${boundary}--\r\n`)
      ])
      await this.request(`${UPLOAD_API}/files?uploadType=multipart&fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body
      }, { timeoutMs: 300000 })
      return
    }
    const init = await this.request(`${UPLOAD_API}/files?uploadType=resumable&fields=id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(size)
      },
      body: JSON.stringify(meta)
    })
    const location = init.headers.get('location')
    if (!location) throw new HttpError('resumable upload: no session URI', 0)
    // Stream from disk: exported videos can be hundreds of MB.
    await this.request(location, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType, 'Content-Length': String(size) },
      body: Readable.toWeb(fs.createReadStream(filePath)),
      duplex: 'half'
    }, { timeoutMs: Math.max(600000, size / 50) }) // allow ~50 kB/s
  }
}

module.exports = { DriveTarget, APP_PROP_KEY, RESUMABLE_THRESHOLD }
