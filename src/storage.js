'use strict'

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const crypto = require('crypto')

const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const FRAME_EXT = ['.jpg', '.json', '.mp4', '.webm']
// Exported videos are queued for Drive under this pseudo-session. Frames may
// not use it.
const VIDEO_SESSION = 'videos'
const VIDEO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}\.(mp4|webm)$/

function isValidSessionId (s) {
  return typeof s === 'string' && SESSION_RE.test(s)
}

function isValidVideoName (n) {
  return typeof n === 'string' && VIDEO_NAME_RE.test(n) && !n.includes('..')
}

/** 2026-11-03T17-31-00-123Z -> 2026-11-03T17:31:00.123Z (null if not a frame name) */
function frameTime (base) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(base)
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null
}

/** 2026-11-03T17:31:00.123Z -> 2026-11-03T17-31-00-123Z (sortable, filename-safe) */
function frameBaseName (date) {
  return date.toISOString().replace(/[:.]/g, '-')
}

/** Write a file atomically: temp file in the same dir, fsync, rename. */
async function atomicWrite (file, data, { mode } = {}) {
  const dir = path.dirname(file)
  const tmp = path.join(dir, `.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`)
  const fh = await fsp.open(tmp, 'w', mode)
  try {
    await fh.writeFile(data)
    await fh.sync()
  } finally {
    await fh.close()
  }
  try {
    await fsp.rename(tmp, file)
  } catch (e) {
    await fsp.rm(tmp, { force: true })
    throw e
  }
}

async function listDir (dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true })
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
}

function extOrder (name) {
  const i = FRAME_EXT.indexOf(path.extname(name))
  return i < 0 ? 99 : i
}

function compareItems (a, b) {
  const ab = a.name.slice(0, -path.extname(a.name).length)
  const bb = b.name.slice(0, -path.extname(b.name).length)
  if (ab !== bb) return ab < bb ? -1 : 1
  if (a.session !== b.session) return a.session < b.session ? -1 : 1
  return extOrder(a.name) - extOrder(b.name)
}

class Storage {
  constructor ({ storagePath, afterUpload = 'move', keepUploadedDays = 7, minFreeDiskMB = 500, maxCacheMB = 1024, log }) {
    this.root = storagePath
    this.queueDir = path.join(storagePath, 'queue')
    this.uploadedDir = path.join(storagePath, 'uploaded')
    this.thumbsDir = path.join(storagePath, 'thumbs')
    this.videosDir = path.join(storagePath, 'videos')
    this.afterUploadMode = afterUpload
    this.keepUploadedDays = keepUploadedDays
    this.minFreeBytes = minFreeDiskMB * 1024 * 1024
    this.maxCacheBytes = maxCacheMB * 1024 * 1024
    this.log = log || { debug () {}, error () {} }
    this.stats = { queueCount: 0, queueBytes: 0, videoQueueBytes: 0, uploadedCount: 0, uploadedBytes: 0, oldestQueued: null, scannedAt: null }
  }

  async init () {
    await fsp.mkdir(this.queueDir, { recursive: true })
    await fsp.mkdir(this.uploadedDir, { recursive: true })
    await fsp.mkdir(this.thumbsDir, { recursive: true })
    await fsp.mkdir(this.videosDir, { recursive: true })
    await this.cleanupTemp()
    await this.refreshStats()
  }

  /** Remove temp files left by a crash mid-write. */
  async cleanupTemp () {
    let n = 0
    for (const f of await listDir(this.videosDir)) {
      if (f.name.startsWith('.tmp-')) { await fsp.rm(path.join(this.videosDir, f.name), { force: true }); n++ }
    }
    for (const base of [this.queueDir, this.uploadedDir, this.thumbsDir]) {
      for (const s of await listDir(base)) {
        if (!s.isDirectory()) continue
        for (const f of await listDir(path.join(base, s.name))) {
          if (f.name.startsWith('.tmp-')) {
            await fsp.rm(path.join(base, s.name, f.name), { force: true })
            n++
          }
        }
      }
    }
    if (n) this.log.debug(`removed ${n} stale temp files`)
  }

  freeBytes () {
    try {
      const s = fs.statfsSync(this.root)
      return s.bavail * s.bsize
    } catch (e) {
      return null
    }
  }

  cacheBytes () {
    return this.stats.queueBytes + this.stats.uploadedBytes
  }

  /**
   * Why new frames would be rejected right now, or null. In move mode,
   * uploaded files are evictable, so only queued bytes count against the cap.
   */
  ingestBlocker () {
    const free = this.freeBytes()
    if (free !== null && free < this.minFreeBytes) return 'disk_low'
    if (this.maxCacheBytes > 0) {
      // Exported videos waiting for Drive never stop capture.
      const frames = this.stats.queueBytes - this.stats.videoQueueBytes
      const used = this.afterUploadMode === 'move' ? frames : this.cacheBytes() - this.stats.videoQueueBytes
      if (used >= this.maxCacheBytes) return 'cache_full'
    }
    return null
  }

  /** Start an eviction pass if the cache is near the cap. Never runs twice at once. */
  maybeEvict () {
    if (this.evicting || this.afterUploadMode !== 'move' || this.maxCacheBytes <= 0) return
    if (this.cacheBytes() < this.maxCacheBytes * 0.95) return
    this.evicting = this.evictForCap()
      .catch(e => this.log.error(`eviction failed: ${e.message}`))
      .finally(() => { this.evicting = null })
  }

  /**
   * Write one frame (jpg plus optional sidecar) into queue/<session>/.
   * Session + capture timestamp identifies a frame, so a client retry of a
   * frame the server already stored is a no-op (duplicate: true).
   * Returns { base, jpgPath, duplicate }.
   */
  async writeFrame ({ sessionId, captureDate, jpeg, sidecar }) {
    if (!isValidSessionId(sessionId) || sessionId === VIDEO_SESSION) throw new Error('invalid session id')
    const dir = path.join(this.queueDir, sessionId)
    await fsp.mkdir(dir, { recursive: true })
    const base = frameBaseName(captureDate)
    const jpgPath = path.join(dir, base + '.jpg')
    const uploadedPath = path.join(this.uploadedDir, sessionId, base + '.jpg')
    if (fs.existsSync(jpgPath) || fs.existsSync(uploadedPath)) return { base, jpgPath, duplicate: true }
    await atomicWrite(jpgPath, jpeg)
    let bytes = jpeg.length
    let count = 1
    if (sidecar) {
      const buf = Buffer.from(JSON.stringify(sidecar, null, 2))
      await atomicWrite(path.join(dir, base + '.json'), buf)
      bytes += buf.length
      count++
    }
    this.stats.queueBytes += bytes
    this.stats.queueCount += count
    this.maybeEvict()
    return { base, jpgPath, duplicate: false }
  }

  async scanDir (base) {
    const items = []
    for (const s of await listDir(base)) {
      if (!s.isDirectory()) continue
      const sdir = path.join(base, s.name)
      for (const f of await listDir(sdir)) {
        if (!f.isFile() || f.name.startsWith('.')) continue
        if (!FRAME_EXT.includes(path.extname(f.name))) continue
        const p = path.join(sdir, f.name)
        let st
        try { st = await fsp.stat(p) } catch (e) { continue }
        items.push({ session: s.name, name: f.name, path: p, size: st.size, mtimeMs: st.mtimeMs, key: `${s.name}/${f.name}` })
      }
    }
    items.sort(compareItems)
    return items
  }

  /** Queued files, oldest first; a frame's .jpg sorts before its .json. */
  async scanQueue () {
    return this.scanDir(this.queueDir)
  }

  async refreshStats () {
    const q = await this.scanQueue()
    const u = await this.scanDir(this.uploadedDir)
    this.stats = {
      queueCount: q.length,
      queueBytes: q.reduce((a, b) => a + b.size, 0),
      videoQueueBytes: q.filter(i => i.session === VIDEO_SESSION).reduce((a, b) => a + b.size, 0),
      uploadedCount: u.length,
      uploadedBytes: u.reduce((a, b) => a + b.size, 0),
      oldestQueued: q.length ? q[0].key : null,
      scannedAt: Date.now()
    }
    return this.stats
  }

  /**
   * Apply afterUpload to an uploaded queue item.
   *  delete: remove it
   *  move:   move to uploaded/<session>/, pruned after keepUploadedDays
   *  keep:   move to uploaded/<session>/, never pruned
   */
  async afterUpload (item) {
    if (item.session === VIDEO_SESSION) this.stats.videoQueueBytes -= item.size
    if (this.afterUploadMode === 'delete') {
      await fsp.rm(item.path, { force: true })
      this.stats.queueBytes -= item.size
      this.stats.queueCount--
      return 'deleted'
    }
    const dir = path.join(this.uploadedDir, item.session)
    await fsp.mkdir(dir, { recursive: true })
    await fsp.rename(item.path, path.join(dir, item.name))
    this.stats.queueBytes -= item.size
    this.stats.queueCount--
    this.stats.uploadedBytes += item.size
    this.stats.uploadedCount++
    return 'moved'
  }

  async removeEmptyDirs (base, minAgeMs = 0) {
    const now = Date.now()
    for (const s of await listDir(base)) {
      if (!s.isDirectory()) continue
      const p = path.join(base, s.name)
      try {
        const st = await fsp.stat(p)
        if (now - st.mtimeMs < minAgeMs) continue
        if ((await fsp.readdir(p)).length === 0) await fsp.rmdir(p)
      } catch (e) { /* raced with a writer; leave it */ }
    }
  }

  /** Delete uploaded files older than keepUploadedDays (move mode only). */
  async pruneUploaded (now = Date.now()) {
    if (this.afterUploadMode !== 'move') return 0
    const cutoff = now - this.keepUploadedDays * 86400 * 1000
    let n = 0
    for (const it of await this.scanDir(this.uploadedDir)) {
      if (it.mtimeMs < cutoff) {
        await fsp.rm(it.path, { force: true })
        n++
      }
    }
    await this.removeEmptyDirs(this.uploadedDir)
    await this.removeEmptyDirs(this.queueDir, 3600 * 1000)
    await this.sweepThumbs()
    await this.refreshStats()
    return n
  }

  /**
   * When the cache is over its cap, evict the oldest already-uploaded files
   * (they are safe in Drive) before letting capture stop. Never in keep mode.
   */
  async evictForCap () {
    if (this.afterUploadMode !== 'move' || this.maxCacheBytes <= 0) return 0
    let over = this.cacheBytes() - this.maxCacheBytes * 0.95
    if (over <= 0) return 0
    let n = 0
    for (const it of await this.scanDir(this.uploadedDir)) {
      if (over <= 0) break
      await fsp.rm(it.path, { force: true })
      over -= it.size
      n++
    }
    await this.removeEmptyDirs(this.uploadedDir)
    await this.sweepThumbs()
    await this.refreshStats()
    return n
  }

  // ---------- gallery ----------

  /** Where a frame's files live now: queue first, then uploaded. */
  frameFile (session, base, ext = '.jpg') {
    for (const dir of [this.queueDir, this.uploadedDir]) {
      const p = path.join(dir, session, base + ext)
      if (fs.existsSync(p)) return p
    }
    return null
  }

  /** kind 'thumb' (320 px) or 'hd' (1920 px proxy for video export). */
  thumbFile (session, base, kind = 'thumb') {
    const p = path.join(this.thumbsDir, session, base + (kind === 'hd' ? '.hd.jpg' : '.jpg'))
    return fs.existsSync(p) ? p : null
  }

  async writeThumb ({ sessionId, captureDate, jpeg, kind = 'thumb' }) {
    if (!isValidSessionId(sessionId) || sessionId === VIDEO_SESSION) throw new Error('invalid session id')
    const dir = path.join(this.thumbsDir, sessionId)
    await fsp.mkdir(dir, { recursive: true })
    const base = frameBaseName(captureDate)
    await atomicWrite(path.join(dir, base + (kind === 'hd' ? '.hd.jpg' : '.jpg')), jpeg)
    return base
  }

  /** Frames of every session on the Pi (queued or uploaded), newest session first. */
  async listSessions () {
    const by = new Map()
    for (const [dir, state] of [[this.queueDir, 'queued'], [this.uploadedDir, 'uploaded']]) {
      for (const it of await this.scanDir(dir)) {
        if (it.session === VIDEO_SESSION) continue
        let s = by.get(it.session)
        if (!s) { s = { id: it.session, frames: 0, queued: 0, uploaded: 0, bytes: 0, first: null, last: null }; by.set(it.session, s) }
        s.bytes += it.size
        if (!it.name.endsWith('.jpg')) continue
        const base = it.name.slice(0, -4)
        s.frames++
        s[state]++
        if (!s.first || base < s.first) s.first = base
        if (!s.last || base > s.last) s.last = base
      }
    }
    return [...by.values()]
      .filter(s => s.frames > 0)
      .map(s => ({ ...s, start: frameTime(s.first), end: frameTime(s.last) }))
      .sort((a, b) => (a.first < b.first ? 1 : -1))
  }

  /** One session's frames in time order, with a navigation summary from each sidecar. */
  async listFrames (session) {
    if (!isValidSessionId(session) || session === VIDEO_SESSION) return null
    const frames = new Map()
    for (const [dir, state] of [[this.queueDir, 'queued'], [this.uploadedDir, 'uploaded']]) {
      for (const f of await listDir(path.join(dir, session))) {
        if (!f.isFile() || !f.name.endsWith('.jpg')) continue
        const base = f.name.slice(0, -4)
        if (frames.has(base)) continue
        let size = 0
        try { size = (await fsp.stat(path.join(dir, session, f.name))).size } catch (e) { continue }
        frames.set(base, {
          name: base,
          time: frameTime(base),
          state,
          bytes: size,
          thumb: fs.existsSync(path.join(this.thumbsDir, session, base + '.jpg')),
          hd: fs.existsSync(path.join(this.thumbsDir, session, base + '.hd.jpg'))
        })
      }
    }
    const out = [...frames.values()].sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const fr of out) {
      const side = this.frameFile(session, fr.name, '.json')
      if (!side) continue
      try {
        const j = JSON.parse(await fsp.readFile(side, 'utf8'))
        const n = j.navigation || {}
        const v = (k) => (n[k] && typeof n[k].value === 'number' ? n[k].value : null)
        fr.w = j.image && j.image.width
        fr.h = j.image && j.image.height
        fr.sog = v('speedOverGround')
        fr.cog = v('courseOverGroundTrue')
        fr.heading = v('headingTrue')
        fr.aws = v('windSpeedApparent')
        fr.tws = v('windSpeedTrue')
        if (n.position && n.position.value) fr.position = n.position.value
      } catch (e) { /* sidecar unreadable: skip the extras */ }
    }
    return out
  }

  /**
   * Frames with a position for the chart overlay, per session, for sessions
   * whose last frame is at or after sinceMs (0: all). Sidecars are read once
   * per session and cached until its file list changes, which covers every
   * way frames come and go (capture, upload moves, pruning, deletes). The
   * returned rev changes whenever any listed session does.
   */
  async photoSessions (sinceMs = 0) {
    if (!this._photoCache) this._photoCache = new Map()
    const names = new Map()
    for (const dir of [this.queueDir, this.uploadedDir]) {
      for (const s of await listDir(dir)) {
        if (!s.isDirectory() || s.name === VIDEO_SESSION || s.name === 'test-shots' || !isValidSessionId(s.name)) continue
        let set = names.get(s.name)
        if (!set) { set = new Set(); names.set(s.name, set) }
        for (const f of await listDir(path.join(dir, s.name))) {
          if (f.isFile() && f.name.endsWith('.jpg')) set.add(f.name.slice(0, -4))
        }
      }
    }
    const out = []
    const sigs = []
    for (const [id, set] of names) {
      if (!set.size) continue
      const sorted = [...set].sort()
      const last = sorted[sorted.length - 1]
      if (sinceMs && Date.parse(frameTime(last)) < sinceMs) continue
      const sig = `${id}:${sorted.length}:${sorted[0]}:${last}`
      let hit = this._photoCache.get(id)
      if (!hit || hit.sig !== sig) {
        const frames = (await this.listFrames(id)) || []
        hit = { sig, frames: frames.filter(f => f.position).map(f => ({ name: f.name, time: f.time, position: f.position })) }
        this._photoCache.set(id, hit)
      }
      sigs.push(sig)
      out.push({ id, frames: hit.frames })
    }
    for (const id of this._photoCache.keys()) if (!names.has(id)) this._photoCache.delete(id)
    sigs.sort()
    out.sort((a, b) => (a.id < b.id ? -1 : 1))
    const rev = crypto.createHash('sha1').update(sigs.join('|')).digest('hex').slice(0, 16)
    return { rev, sessions: out }
  }

  /**
   * Delete frames (jpg, sidecar, thumbnail) from queue and uploaded.
   * Returns the localKeys of the removed files, for Drive deletion.
   */
  async deleteFrames (session, bases) {
    if (!isValidSessionId(session) || session === VIDEO_SESSION) throw new Error('invalid session id')
    const keys = []
    for (const base of bases) {
      if (typeof base !== 'string' || !frameTime(base)) continue
      for (const ext of ['.jpg', '.json']) {
        for (const dir of [this.queueDir, this.uploadedDir]) {
          const p = path.join(dir, session, base + ext)
          try { await fsp.rm(p); keys.push(`${session}/${base}${ext}`) } catch (e) { /* not there */ }
        }
      }
      await fsp.rm(path.join(this.thumbsDir, session, base + '.jpg'), { force: true })
      await fsp.rm(path.join(this.thumbsDir, session, base + '.hd.jpg'), { force: true })
    }
    await this.removeEmptyDirs(this.queueDir)
    await this.removeEmptyDirs(this.uploadedDir)
    await this.removeEmptyDirs(this.thumbsDir)
    await this.refreshStats()
    return [...new Set(keys)]
  }

  async deleteSession (session) {
    const frames = await this.listFrames(session)
    if (!frames) throw new Error('invalid session id')
    const keys = await this.deleteFrames(session, frames.map(f => f.name))
    for (const dir of [this.queueDir, this.uploadedDir, this.thumbsDir]) {
      await fsp.rm(path.join(dir, session), { recursive: true, force: true })
    }
    await this.refreshStats()
    return keys
  }

  /** Remove thumbnails whose frame is gone (pruned, evicted or deleted after upload). */
  async sweepThumbs () {
    let n = 0
    for (const s of await listDir(this.thumbsDir)) {
      if (!s.isDirectory()) continue
      for (const f of await listDir(path.join(this.thumbsDir, s.name))) {
        if (!f.name.endsWith('.jpg')) continue
        const base = f.name.replace(/(\.hd)?\.jpg$/, '')
        if (!this.frameFile(s.name, base)) {
          await fsp.rm(path.join(this.thumbsDir, s.name, f.name), { force: true })
          n++
        }
      }
    }
    await this.removeEmptyDirs(this.thumbsDir, 3600 * 1000)
    return n
  }

  // ---------- exported videos ----------

  /**
   * Store an exported video from a request stream (never buffered whole).
   * With forUpload, hard-link it into queue/videos/ so the uploader sends it
   * to Drive; the link costs no extra disk and its afterUpload handling never
   * touches the copy in videos/.
   */
  async saveVideo (name, stream, { limit, forUpload }) {
    if (!isValidVideoName(name)) throw Object.assign(new Error('invalid video name'), { status: 400 })
    const dest = path.join(this.videosDir, name)
    if (fs.existsSync(dest)) throw Object.assign(new Error('a video with that name exists'), { status: 409 })
    const tmp = path.join(this.videosDir, `.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`)
    let size = 0
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp)
      let failed = false
      // Reject only once the stream has closed: destroyed before its open()
      // finished, it would still create the file after we deleted it.
      const fail = (e) => {
        if (failed) return
        failed = true
        if (out.closed) return reject(e)
        out.once('close', () => reject(e))
        out.destroy()
      }
      stream.on('data', (c) => {
        size += c.length
        if (size > limit) { stream.unpipe(out); stream.resume(); fail(Object.assign(new Error('video too large'), { status: 413 })) }
      })
      stream.on('error', fail)
      out.on('error', fail)
      out.on('finish', () => { if (!failed) resolve() })
      stream.pipe(out)
    }).catch(async (e) => { await fsp.rm(tmp, { force: true }); throw e })
    const fh = await fsp.open(tmp, 'r+')
    try { await fh.sync() } finally { await fh.close() }
    await fsp.rename(tmp, dest)
    if (forUpload) {
      const qdir = path.join(this.queueDir, VIDEO_SESSION)
      await fsp.mkdir(qdir, { recursive: true })
      try { await fsp.link(dest, path.join(qdir, name)) } catch (e) { await fsp.copyFile(dest, path.join(qdir, name)) }
      this.stats.queueBytes += size
      this.stats.videoQueueBytes += size
      this.stats.queueCount++
    }
    return { name, bytes: size }
  }

  async listVideos () {
    const out = []
    for (const f of await listDir(this.videosDir)) {
      if (!f.isFile() || !isValidVideoName(f.name)) continue
      try {
        const st = await fsp.stat(path.join(this.videosDir, f.name))
        const queued = fs.existsSync(path.join(this.queueDir, VIDEO_SESSION, f.name))
        const uploaded = fs.existsSync(path.join(this.uploadedDir, VIDEO_SESSION, f.name))
        out.push({ name: f.name, bytes: st.size, created: new Date(st.mtimeMs).toISOString(), drive: queued ? 'queued' : (uploaded ? 'uploaded' : null) })
      } catch (e) { /* raced */ }
    }
    return out.sort((a, b) => (a.created < b.created ? 1 : -1))
  }

  videoFile (name) {
    if (!isValidVideoName(name)) return null
    const p = path.join(this.videosDir, name)
    return fs.existsSync(p) ? p : null
  }

  /** Delete a video and its upload link. Returns the localKey for Drive deletion. */
  async deleteVideo (name) {
    if (!isValidVideoName(name)) throw Object.assign(new Error('invalid video name'), { status: 400 })
    for (const p of [path.join(this.videosDir, name), path.join(this.queueDir, VIDEO_SESSION, name), path.join(this.uploadedDir, VIDEO_SESSION, name)]) {
      await fsp.rm(p, { force: true })
    }
    await this.refreshStats()
    return `${VIDEO_SESSION}/${name}`
  }
}

module.exports = { Storage, atomicWrite, frameBaseName, frameTime, isValidSessionId, isValidVideoName, compareItems, VIDEO_SESSION }
