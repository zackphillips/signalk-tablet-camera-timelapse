'use strict'

/** Could not reach the network or the service (DNS, reset, timeout, 5xx). */
class NetworkError extends Error {
  constructor (msg, cause) { super(msg); this.name = 'NetworkError'; this.cause = cause }
}
/** 429 or a 403 rate-limit reason. */
class RateLimitError extends Error {
  constructor (msg, retryAfterMs) { super(msg); this.name = 'RateLimitError'; this.retryAfterMs = retryAfterMs }
}
/** Credentials missing, revoked or refresh failed. User must re-authorize. */
class AuthError extends Error {
  constructor (msg) { super(msg); this.name = 'AuthError' }
}
/** Any other non-success HTTP response. */
class HttpError extends Error {
  constructor (msg, status, body) { super(msg); this.name = 'HttpError'; this.status = status; this.body = body }
}

module.exports = { NetworkError, RateLimitError, AuthError, HttpError }
