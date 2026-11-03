'use strict'

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const crypto = require('crypto')

const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const FRAME_EXT = ['.jpg', '.json']

function isValidSessionId (s) {
  return typeof s === 'string' && SESSION_RE.test(s)
}

/** 2026-11-03T17:31:00.123Z -> 2026-11-03T17-31-00-123Z (sortable, filename-safe) */
function frameBaseName (date) {
  return date.toISOString().replace(/[:.]/g, '-')
}

/** Write a file atomically: temp file in the same dir, fsync, rename. */
async function atomicWrite (file, data) {
  const dir = path.dirname(file)
  const tmp = path.join(dir, `.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`)
  const fh = await fsp.open(tmp, 'w')
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
    this.afterUploadMode = afterUpload
    this.keepUploadedDays = keepUploadedDays
    this.minFreeBytes = minFreeDiskMB * 1024 * 1024
    this.maxCacheBytes = maxCacheMB * 1024 * 1024
    this.log = log || { debug () {}, error () {} }
    this.stats = { queueCount: 0, queueBytes: 0, uploadedCount: 0, uploadedBytes: 0, oldestQueued: null, scannedAt: null }
  }

  async init () {
    await fsp.mkdir(this.queueDir, { recursive: true })
    await fsp.mkdir(this.uploadedDir, { recursive: true })
    await this.cleanupTemp()
    await this.refreshStats()
  }

  /** Remove temp files left by a crash mid-write. */
  async cleanupTemp () {
    let n = 0
    for (const base of [this.queueDir, this.uploadedDir]) {
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

  /** Why new frames would be rejected right now, or null. */
  ingestBlocker () {
    const free = this.freeBytes()
    if (free !== null && free < this.minFreeBytes) return 'disk_low'
    if (this.maxCacheBytes > 0 && this.cacheBytes() >= this.maxCacheBytes) return 'cache_full'
    return null
  }

  /**
   * Write one frame (jpg plus optional sidecar) into queue/<session>/.
   * Returns { base, jpgPath }.
   */
  async writeFrame ({ sessionId, captureDate, jpeg, sidecar }) {
    if (!isValidSessionId(sessionId)) throw new Error('invalid session id')
    const dir = path.join(this.queueDir, sessionId)
    await fsp.mkdir(dir, { recursive: true })
    let base = frameBaseName(captureDate)
    // Guard against two frames with the same millisecond (e.g. two tablets).
    for (let i = 1; fs.existsSync(path.join(dir, base + '.jpg')); i++) {
      base = `${frameBaseName(captureDate)}_${i}`
    }
    const jpgPath = path.join(dir, base + '.jpg')
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
    return { base, jpgPath }
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
    await this.refreshStats()
    return n
  }
}

module.exports = { Storage, atomicWrite, frameBaseName, isValidSessionId, compareItems }
