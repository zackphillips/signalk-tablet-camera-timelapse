'use strict'

/*
 * Google OAuth for limited-input devices (device flow) with the drive.file
 * scope. drive.file is on Google's allowed-scope list for this flow:
 * https://developers.google.com/identity/protocols/oauth2/limited-input-device
 *
 * The plugin polls Google itself, so authorization completes even if the
 * settings drawer is closed. GET /drive/auth/poll only reports state.
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const { NetworkError, AuthError } = require('../errors')
const { atomicWrite } = require('../storage')

const SCOPE = 'https://www.googleapis.com/auth/drive.file'
const DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

async function postForm (fetchFn, url, params) {
  let res
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(30000)
    })
  } catch (e) {
    throw new NetworkError(`request to ${url} failed: ${e.message}`, e)
  }
  if (res.status >= 500) throw new NetworkError(`${url} returned ${res.status}`)
  let body = {}
  try { body = await res.json() } catch (e) { /* empty body */ }
  return { status: res.status, body }
}

class DriveAuth {
  constructor ({ dataDir, clientId, clientSecret, fetch: fetchFn, log, onChange }) {
    this.tokenPath = path.join(dataDir, 'drive-token.json')
    this.clientId = clientId || ''
    this.clientSecret = clientSecret || ''
    this.fetch = fetchFn || globalThis.fetch
    this.log = log || { debug () {}, error () {} }
    this.onChange = onChange || (() => {})
    this.token = null
    this.pending = null // device flow in progress
    this.pollTimer = null
    this.lastError = null
    this.needsAuth = false
    this.refreshing = null
    this.load()
  }

  configured () {
    return !!(this.clientId && this.clientSecret)
  }

  load () {
    try {
      const t = JSON.parse(fs.readFileSync(this.tokenPath, 'utf8'))
      if (t.clientId && t.clientId !== this.clientId) {
        // Credentials changed; the stored refresh token belongs to another client.
        this.token = null
        this.needsAuth = true
        return
      }
      this.token = t
    } catch (e) {
      this.token = null
    }
  }

  /** Serialized, fsynced, created 0600 before any token bytes are written. */
  save () {
    const write = () => atomicWrite(this.tokenPath, JSON.stringify(this.token), { mode: 0o600 })
    this.saving = (this.saving || Promise.resolve()).then(write, write)
    return this.saving
  }

  /** unconfigured | unauthorized | pending | authorized | needs_auth */
  state () {
    if (!this.configured()) return 'unconfigured'
    if (this.pending) return 'pending'
    if (this.token && this.token.refresh_token && !this.needsAuth) return 'authorized'
    if (this.needsAuth) return 'needs_auth'
    return 'unauthorized'
  }

  status () {
    const s = { state: this.state(), error: this.lastError }
    if (this.pending) {
      s.userCode = this.pending.userCode
      s.verificationUrl = this.pending.verificationUrl
      s.expiresAt = new Date(this.pending.expiresAt).toISOString()
    }
    if (this.token && this.token.authorizedAt) s.authorizedAt = this.token.authorizedAt
    return s
  }

  async startDeviceFlow () {
    if (!this.configured()) throw new Error('Set drive.clientId and drive.clientSecret in the plugin config first')
    this.cancelPolling()
    const { status, body } = await postForm(this.fetch, DEVICE_CODE_URL, { client_id: this.clientId, scope: SCOPE })
    if (status !== 200) {
      this.lastError = body.error_description || body.error || `device code request failed (${status})`
      this.onChange()
      throw new Error(this.lastError)
    }
    this.lastError = null
    this.pending = {
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUrl: body.verification_url || body.verification_uri,
      expiresAt: Date.now() + (body.expires_in || 1800) * 1000,
      intervalMs: (body.interval || 5) * 1000
    }
    this.schedulePoll()
    this.onChange()
    return this.status()
  }

  schedulePoll () {
    if (!this.pending) return
    this.pollTimer = setTimeout(() => {
      this.pollOnce().catch(e => this.log.error(`device flow poll: ${e.message}`))
    }, this.pending.intervalMs)
  }

  async pollOnce () {
    const p = this.pending
    if (!p) return
    if (Date.now() > p.expiresAt) {
      this.pending = null
      this.lastError = 'Code expired before it was approved. Start again.'
      this.onChange()
      return
    }
    let r
    try {
      r = await postForm(this.fetch, TOKEN_URL, {
        client_id: this.clientId,
        client_secret: this.clientSecret,
        device_code: p.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      })
    } catch (e) {
      // Offline while waiting; keep polling.
      this.schedulePoll()
      return
    }
    if (this.pending !== p) return // cancelled meanwhile
    const { status, body } = r
    if (status === 200 && body.refresh_token) {
      this.pending = null
      this.needsAuth = false
      this.lastError = null
      this.token = {
        clientId: this.clientId,
        refresh_token: body.refresh_token,
        access_token: body.access_token,
        expiresAt: Date.now() + (body.expires_in || 3600) * 1000,
        scope: body.scope,
        authorizedAt: new Date().toISOString()
      }
      await this.save()
      this.log.debug('Google Drive authorized')
      this.onChange('authorized')
      return
    }
    switch (body.error) {
      case 'authorization_pending':
        break
      case 'slow_down':
        p.intervalMs += 5000
        break
      default:
        this.pending = null
        this.lastError = body.error_description || body.error || `token request failed (${status})`
        this.onChange()
        return
    }
    this.schedulePoll()
  }

  cancelPolling () {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
    this.pending = null
  }

  /** Returns a valid access token, refreshing if needed. */
  async getAccessToken (forceRefresh = false) {
    if (!this.token || !this.token.refresh_token || this.needsAuth) throw new AuthError('Google Drive is not authorized')
    if (!forceRefresh && this.token.access_token && Date.now() < this.token.expiresAt - 60000) {
      return this.token.access_token
    }
    if (!this.refreshing) {
      this.refreshing = this.refresh().finally(() => { this.refreshing = null })
    }
    return this.refreshing
  }

  async refresh () {
    const { status, body } = await postForm(this.fetch, TOKEN_URL, {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.token.refresh_token,
      grant_type: 'refresh_token'
    })
    if (status === 200 && body.access_token) {
      this.token.access_token = body.access_token
      this.token.expiresAt = Date.now() + (body.expires_in || 3600) * 1000
      if (body.refresh_token) this.token.refresh_token = body.refresh_token
      await this.save()
      return this.token.access_token
    }
    if (status === 429) throw new NetworkError('token refresh rate limited')
    // invalid_grant (revoked/expired), invalid_client, etc.
    this.needsAuth = true
    this.lastError = `Token refresh failed: ${body.error_description || body.error || status}`
    this.onChange()
    throw new AuthError(this.lastError)
  }

  async revoke () {
    this.cancelPolling()
    const t = this.token
    this.token = null
    this.needsAuth = false
    this.lastError = null
    await fsp.rm(this.tokenPath, { force: true })
    if (t && t.refresh_token) {
      try {
        await postForm(this.fetch, REVOKE_URL, { token: t.refresh_token })
      } catch (e) {
        this.log.error(`revoke request failed (token deleted locally anyway): ${e.message}`)
      }
    }
    this.onChange()
  }

  stop () {
    this.cancelPolling()
  }
}

module.exports = { DriveAuth, SCOPE }
