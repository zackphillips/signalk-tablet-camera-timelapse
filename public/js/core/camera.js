// Camera access for the capture engine: one stream, full-resolution stills via
// ImageCapture.takePhoto() with a video-frame canvas fallback, and small
// preview JPEGs for the settings UIs.

import { prefs } from './prefs.js'

const log = (...a) => console.log('[timelapse]', ...a)

export function createCamera ({ onChange, jpegQuality = () => 0.85 }) {
  const C = {
    stream: null,
    track: null,
    imageCapture: null,
    photoCaps: null,
    error: null, // 'insecure' | 'denied' | message
    cameras: [],
    resolutions: [],
    resolution: null
  }
  let opening = null
  let frameVideo = null

  const changed = () => onChange && onChange()

  function deviceKey () {
    return C.track ? (C.track.getSettings().deviceId || C.track.label) : 'default'
  }

  function open () {
    if (C.stream) return Promise.resolve(true)
    if (!opening) opening = doOpen().finally(() => { opening = null })
    return opening
  }

  async function doOpen () {
    if (C.stream) return true
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      C.error = 'insecure'
      changed()
      return false
    }
    const deviceId = prefs.get('cameraId', null)
    const saved = deviceId ? prefs.get('res:' + deviceId, null) : null
    const hasImageCapture = typeof window.ImageCapture === 'function'
    const video = {}
    if (deviceId) video.deviceId = { exact: deviceId }
    else video.facingMode = { ideal: 'environment' }
    if (hasImageCapture) {
      // Stills come from takePhoto at full resolution; keep the stream modest.
      video.width = { ideal: 1920 }
      video.height = { ideal: 1080 }
    } else {
      video.width = { ideal: saved ? saved.w : 4096 }
      video.height = { ideal: saved ? saved.h : 3072 }
    }
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false })
    } catch (e) {
      if (deviceId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
        prefs.set('cameraId', null) // that camera is gone; fall back to the rear one
        return doOpen()
      }
      C.error = e.name === 'NotAllowedError' ? 'denied' : (e.message || e.name)
      changed()
      return false
    }
    C.error = null
    C.stream = stream
    C.track = stream.getVideoTracks()[0]
    C.imageCapture = null
    C.photoCaps = null
    if (hasImageCapture) {
      try {
        C.imageCapture = new ImageCapture(C.track)
        C.photoCaps = await C.imageCapture.getPhotoCapabilities()
      } catch (e) {
        log('ImageCapture unavailable, using video frames:', e.message)
        C.imageCapture = null
      }
    }
    C.track.addEventListener('ended', () => {
      log('camera track ended')
      close()
      changed()
    })
    await listCameras()
    computeResolutions()
    changed()
    return true
  }

  function close () {
    if (C.stream) C.stream.getTracks().forEach(t => t.stop())
    C.stream = null
    C.track = null
    C.imageCapture = null
    C.photoCaps = null
    if (frameVideo) frameVideo.srcObject = null
  }

  async function listCameras () {
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput')
      C.cameras = devs.map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }))
    } catch (e) { C.cameras = [] }
  }

  /** Still sizes: the max and scaled steps at the same aspect. */
  function computeResolutions () {
    const out = []
    const add = (w, h, src) => {
      w = Math.round(w); h = Math.round(h)
      if (w > 0 && h > 0 && !out.find(r => r.w === w && r.h === h)) out.push({ w, h, src })
    }
    if (C.photoCaps && C.photoCaps.imageWidth && C.photoCaps.imageWidth.max) {
      const W = C.photoCaps.imageWidth
      const H = C.photoCaps.imageHeight
      const step = (v, s) => (s && s.step ? Math.round(v / s.step) * s.step : v)
      for (const f of [1, 0.75, 0.5, 0.25]) {
        const w = step(W.max * f, W)
        const h = step(H.max * f, H)
        if (w >= (W.min || 1) && h >= (H.min || 1)) add(w, h, 'photo')
      }
    }
    if (!out.length && C.track && C.track.getCapabilities) {
      const c = C.track.getCapabilities()
      if (c.width && c.height) for (const f of [1, 0.75, 0.5]) add(c.width.max * f, c.height.max * f, 'video')
    }
    if (!out.length && C.track) {
      const s = C.track.getSettings()
      add(s.width, s.height, 'video')
    }
    C.resolutions = out
    const saved = prefs.get('res:' + deviceKey(), null)
    C.resolution = (saved && out.find(r => r.w === saved.w && r.h === saved.h)) || out[0] || null
  }

  async function setCamera (id) {
    prefs.set('cameraId', id || null)
    close()
    await open()
  }

  async function setResolution (w, h) {
    const r = C.resolutions.find(x => x.w === w && x.h === h)
    if (!r) return
    C.resolution = r
    prefs.set('res:' + deviceKey(), { w, h })
    if (!C.imageCapture) { close(); await open() } // video-frame mode: size is the stream's
    changed()
  }

  async function toJpeg (source, w, h, quality) {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    canvas.getContext('2d').drawImage(source, 0, 0, w, h)
    return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', quality))
  }

  async function videoEl () {
    if (!frameVideo) {
      frameVideo = document.createElement('video')
      frameVideo.muted = true
      frameVideo.playsInline = true
    }
    if (frameVideo.srcObject !== C.stream) {
      frameVideo.srcObject = C.stream
      await frameVideo.play().catch(() => {})
    }
    if (!frameVideo.videoWidth) await new Promise(r => frameVideo.addEventListener('loadedmetadata', r, { once: true }))
    return frameVideo
  }

  async function takeFrame () {
    if (!C.stream && !(await open())) throw new Error('camera unavailable')
    if (C.imageCapture) {
      try {
        const settings = {}
        if (C.resolution && C.resolution.src === 'photo') {
          settings.imageWidth = C.resolution.w
          settings.imageHeight = C.resolution.h
        }
        let blob = await C.imageCapture.takePhoto(settings)
        let w = C.resolution ? C.resolution.w : null
        let h = C.resolution ? C.resolution.h : null
        if (blob.type !== 'image/jpeg') {
          const bmp = await createImageBitmap(blob)
          w = bmp.width; h = bmp.height
          blob = await toJpeg(bmp, w, h, jpegQuality())
        }
        return { blob, w, h, method: 'takePhoto' }
      } catch (e) {
        log('takePhoto failed, using a video frame:', e.message)
      }
    }
    const v = await videoEl()
    const w = v.videoWidth
    const h = v.videoHeight
    return { blob: await toJpeg(v, w, h, jpegQuality()), w, h, method: 'canvas' }
  }

  /** Small JPEG of the live stream for settings previews. */
  async function previewFrame (maxW = 480) {
    if (!C.stream) return null
    const v = await videoEl()
    const s = Math.min(1, maxW / v.videoWidth)
    return toJpeg(v, Math.round(v.videoWidth * s), Math.round(v.videoHeight * s), 0.6)
  }

  return {
    state: C,
    open,
    close,
    setCamera,
    setResolution,
    takeFrame,
    previewFrame,
    get label () { return C.track ? C.track.label : '' },
    get usesImageCapture () { return !!C.imageCapture }
  }
}
