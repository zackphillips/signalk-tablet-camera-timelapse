'use strict'

/*
 * Background uploader. The filesystem queue is the only source of truth for
 * what still needs uploading. A small "inflight" file records uploads that
 * started but did not finish (crash, network drop mid-request). Those are
 * checked with target.exists() before being uploaded again, so a restart
 * never creates duplicates in Drive, while normal uploads skip the extra call.
 */

const fs = require('fs')
const path = require('path')
const { NetworkError, RateLimitError, AuthError, HttpError, DriveFullError } = require('./errors')
const { atomicWrite } = require('./storage')

const MAX_BACKOFF_MS = 15 * 60 * 1000

const MIME = { '.jpg': 'image/jpeg', '.json': 'application/json', '.mp4': 'video/mp4', '.webm': 'video/webm' }

class InflightLog {
  constructor (file) {
    this.file = file
    this.set = new Set()
    try {
      for (const k of JSON.parse(fs.readFileSync(file, 'utf8'))) this.set.add(k)
    } catch (e) { /* none */ }
  }

  has (k) { return this.set.has(k) }
  async add (k) { this.set.add(k); await this.save() }
  async remove (k) { this.set.delete(k); await this.save() }
  /** Writes are chained so parallel uploads never race on the temp file. */
  save () {
    const write = () => atomicWrite(this.file, JSON.stringify([...this.set]))
    this.saving = (this.saving || Promise.resolve()).then(write, write)
    return this.saving
  }
}

/**
 * Drive deletions requested from the gallery, persisted so they survive being
 * offline or a restart. Entries: { key } for one file (by localKey), or
 * { folder } for a whole session folder.
 */
class DeleteQueue {
  constructor (file) {
    this.file = file
    try { this.items = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { this.items = [] }
  }

  get length () { return this.items.length }
  async add (entries) { this.items.push(...entries); await this.save() }
  async shift () { this.items.shift(); await this.save() }
  save () {
    const write = () => atomicWrite(this.file, JSON.stringify(this.items))
    this.saving = (this.saving || Promise.resolve()).then(write, write)
    return this.saving
  }
}

class Uploader {
  constructor ({ storage, target, dataDir, intervalSeconds = 60, concurrency = 1, log, isReady, onPass, random = Math.random, now = Date.now }) {
    this.storage = storage
    this.target = target
    this.inflight = new InflightLog(path.join(dataDir, 'inflight.json'))
    this.deletes = new DeleteQueue(path.join(dataDir, 'drive-deletes.json'))
    this.deletedTotal = 0
    this.intervalMs = Math.max(5, intervalSeconds) * 1000
    this.concurrency = Math.max(1, Math.floor(concurrency))
    this.log = log || { debug () {}, error () {} }
    this.isReady = isReady || (() => true)
    this.onPass = onPass || (() => {})
    this.random = random
    this.now = now
    this.timer = null
    this.running = false
    this.stopped = true
    this.failures = 0
    this.state = 'idle' // idle | uploading | offline | rate_limited | needs_auth | error
    this.nextRunAt = null
    this.lastUploadAt = null
    this.lastPass = null
    this.lastError = null
    this.uploadedTotal = 0
  }

  start () {
    this.stopped = false
    this.schedule(2000)
  }

  stop () {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Run a pass soon (e.g. right after Drive is authorized). */
  kick () {
    if (this.stopped) return
    this.failures = 0
    this.schedule(500)
  }

  schedule (ms) {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.nextRunAt = this.now() + ms
    this.timer = setTimeout(() => {
      this.timer = null
      this.runPass().catch(e => this.log.error(`upload pass crashed: ${e.stack || e.message}`))
    }, ms)
  }

  backoffMs (jitter) {
    const base = Math.min(MAX_BACKOFF_MS, this.intervalMs * Math.pow(2, Math.max(0, this.failures - 1)))
    return jitter ? Math.round(base * (0.5 + this.random())) : base
  }

  status () {
    return {
      state: this.state,
      lastUploadAt: this.lastUploadAt ? new Date(this.lastUploadAt).toISOString() : null,
      nextRunAt: this.nextRunAt ? new Date(this.nextRunAt).toISOString() : null,
      consecutiveFailures: this.failures,
      uploadedTotal: this.uploadedTotal,
      pendingDeletes: this.deletes.length,
      deletedTotal: this.deletedTotal,
      lastPass: this.lastPass,
      lastError: this.lastError
    }
  }

  /** Queue Drive deletions and forget any half-finished uploads of those files. */
  async queueDeletes (entries) {
    if (!entries.length) return
    for (const e of entries) if (e.key && this.inflight.has(e.key)) await this.inflight.remove(e.key)
    await this.deletes.add(entries)
    this.kick()
  }

  /** Work through queued deletions. Throws on network/auth/rate-limit errors. */
  async processDeletes () {
    while (this.deletes.length && !this.stopped) {
      const e = this.deletes.items[0]
      try {
        const ids = e.folder ? [await this.target.findSessionFolder(e.folder)].filter(Boolean) : await this.target.findByKey(e.key)
        for (const id of ids) await this.target.trash(id)
        if (e.folder) await this.target.invalidate(e.folder)
        this.deletedTotal += ids.length
      } catch (err) {
        // Network, auth and rate limits: keep the entry and retry next pass.
        if (!(err instanceof HttpError)) throw err
        // Anything else (already gone, not ours) will not get better: drop it.
        if (err.status !== 404) this.lastError = `Drive delete ${e.key || e.folder}: ${err.message}`
      }
      await this.deletes.shift()
    }
  }

  async uploadItem (item) {
    const folder = await this.target.ensureFolder(item.session)
    let skip = false
    if (this.inflight.has(item.key)) {
      skip = await this.target.exists(item.key, folder)
    } else {
      await this.inflight.add(item.key)
    }
    if (!skip) {
      try {
        await this.target.upload({
          filePath: item.path,
          name: item.name,
          mimeType: MIME[path.extname(item.name)] || 'application/octet-stream',
          size: item.size,
          localKey: item.key,
          folderRef: folder
        })
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) await this.target.invalidate(item.session)
        throw e
      }
    }
    await this.storage.afterUpload(item)
    await this.inflight.remove(item.key)
    return skip ? 'skipped-existing' : 'uploaded'
  }

  /** One pass over the queue. Returns the delay before the next pass. */
  async runPass () {
    if (this.running || this.stopped) return
    if (!this.isReady()) {
      this.state = 'needs_auth'
      this.schedule(this.intervalMs)
      return
    }
    this.running = true
    this.state = 'uploading'
    const started = this.now()
    const counts = { uploaded: 0, skippedExisting: 0, failed: 0 }
    let fatal = null
    try {
      if (this.deletes.length && this.target.trash) await this.processDeletes()
      if (this.target.syncAllSharing) await this.target.syncAllSharing()
      const items = await this.storage.scanQueue()
      let i = 0
      const worker = async () => {
        while (!fatal && !this.stopped && i < items.length) {
          const item = items[i++]
          try {
            const r = await this.uploadItem(item)
            if (r === 'uploaded') counts.uploaded++
            else counts.skippedExisting++
            this.lastUploadAt = this.now()
            this.uploadedTotal++
          } catch (e) {
            if (e instanceof NetworkError || e instanceof RateLimitError || e instanceof AuthError || e instanceof DriveFullError) {
              fatal = fatal || e
            } else {
              counts.failed++
              this.lastError = `${item.key}: ${e.message}`
            }
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(this.concurrency, Math.max(1, items.length)) }, worker))
    } catch (e) {
      fatal = fatal || e
    } finally {
      this.running = false
    }

    this.lastPass = { at: new Date(started).toISOString(), ms: this.now() - started, ...counts }
    let delay = this.intervalMs
    if (fatal instanceof NetworkError) {
      this.failures++
      this.state = 'offline'
      delay = this.backoffMs(false)
    } else if (fatal instanceof RateLimitError) {
      this.failures++
      this.state = 'rate_limited'
      delay = Math.max(fatal.retryAfterMs || 0, this.backoffMs(true))
    } else if (fatal instanceof AuthError) {
      this.state = 'needs_auth'
    } else if (fatal instanceof DriveFullError) {
      this.failures++
      this.state = 'drive_full'
      delay = MAX_BACKOFF_MS
    } else if (fatal) {
      this.failures++
      this.state = 'error'
      delay = this.backoffMs(false)
    } else {
      this.failures = 0
      this.state = counts.failed ? 'error' : 'idle'
    }
    if (fatal) this.lastError = fatal.message
    else if (!counts.failed) this.lastError = null
    if (counts.uploaded || counts.skippedExisting || counts.failed || fatal) {
      this.log.debug(`upload pass: ${counts.uploaded} uploaded, ${counts.skippedExisting} already in Drive, ${counts.failed} failed${fatal ? `, stopped: ${fatal.message}` : ''}; next in ${Math.round(delay / 1000)}s`)
    }
    this.onPass(this.lastPass, fatal)
    this.schedule(delay)
    return delay
  }
}

module.exports = { Uploader, InflightLog, DeleteQueue, MAX_BACKOFF_MS }
