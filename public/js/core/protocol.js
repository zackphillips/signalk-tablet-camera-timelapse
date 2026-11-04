// Messages between the capture engine and the UIs (Freeboard panel and
// widget, KIP page, standalone page). All of them are same-origin, so a
// BroadcastChannel reaches every one, whichever host iframe it lives in.
//
// engine -> UIs   { t: 'state', s }            full state, on change + every 2 s
//                 { t: 'frame', blob }          preview JPEG while a UI asks
//                 { t: 'testResult', id, ... }  answer to testShot
// UIs -> engine   { t: 'hello' }                ask for state now
//                 { t: 'refresh' }              re-read server status/mode now
//                 { t: 'preview' }              keep preview frames coming (~1 s)
//                 { t: 'testShot', id }
//                 { t: 'setCamera', id }
//                 { t: 'setResolution', w, h }

export const CHANNEL = 'signalk-tablet-camera-timelapse'
export const LOCK = 'signalk-tablet-camera-timelapse-engine'
export const HEARTBEAT_MS = 2000
export const ENGINE_STALE_MS = 6000

export function openChannel (onMessage) {
  const ch = new BroadcastChannel(CHANNEL)
  if (onMessage) ch.onmessage = (e) => onMessage(e.data || {})
  return ch
}

/**
 * Run the engine only while this context holds the tablet-wide lock AND its
 * page is visible. Visible candidates queue; when the holder goes away (a KIP
 * dashboard is switched, a tab closes) or its page is hidden (another tab in
 * front), it steps down and the next visible candidate takes over.
 * `start` resolves to an engine with stop(). Returns immediately.
 */
export function runAsEngineWhenLeader (start) {
  if (!navigator.locks) {
    // No Web Locks (very old browser): run anyway; two engines would only
    // duplicate frames, which the server de-duplicates by timestamp.
    start()
    return
  }
  let abort = null
  let release = null
  const visible = () => document.visibilityState === 'visible'

  function compete () {
    if (abort || release || !visible()) return
    abort = new AbortController()
    navigator.locks.request(LOCK, { signal: abort.signal }, async () => {
      abort = null
      const engine = await start()
      // Hidden while starting up: step down straight away.
      if (visible()) await new Promise(resolve => { release = resolve })
      release = null
      if (engine && engine.stop) engine.stop()
    }).catch((e) => {
      abort = null
      if (e.name !== 'AbortError') console.warn('[timelapse] engine lock failed', e)
    })
  }

  document.addEventListener('visibilitychange', () => {
    if (visible()) compete()
    else {
      if (abort) { abort.abort(); abort = null } // don't win the lock while hidden
      if (release) release() // step down; a visible context takes over
    }
  })
  compete()
}
