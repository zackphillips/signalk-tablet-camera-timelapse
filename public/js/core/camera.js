// Camera access for the capture engine: one stream, full-resolution stills via
// ImageCapture.takePhoto() with a video-frame canvas fallback, and gallery
// copies of each still.

import { prefs } from './prefs.js'

const log = (...a) => console.log('[timelapse]', ...a)

// Lowest and Highest are tablet-wide and follow whichever camera is in use;
// an exact size is remembered per camera. Lowest is the default: smallest
// frames on the Pi, over Wi-Fi and in Drive.
const CHOICES = ['lowest', 'highest', 'exact']
const resChoice = () => { const c = prefs.get('resChoice', 'lowest'); return CHOICES.includes(c) ? c : 'lowest' }

/** The resolution a choice selects from a list: by pixel count, or the saved exact size. */
export function pickResolution (list, choice, saved) {
  if (!list.length) return null
  const area = (r) => r.w * r.h
  if (choice === 'exact' && saved) {
    const hit = list.find(r => r.w === saved.w && r.h === saved.h)
    if (hit) return hit
  }
  const sorted = [...list].sort((a, b) => area(a) - area(b))
  return choice === 'highest' ? sorted[sorted.length - 1] : sorted[0]
}

export function createCamera ({ onChange, jpegQuality = () => 0.85 }) {
  const C = {
    stream: null,
    track: null,
    imageCapture: null,
    photoCaps: null,
    error: null, // 'insecure' | 'denied' | message
    cameras: [],
    resolutions: [],
    resolution: null,
    resChoice: resChoice() // 'lowest' | 'highest' | 'exact'
  }
  let opening = null
  let frameVideo = null

  const changed = () => onChange && onChange()

  // Exact sizes are remembered by camera label ("camera2 0, facing back"),
  // which stays put when a browser rotates device ids.
  function deviceKey () {
    return C.track ? (C.track.label || C.track.getSettings().deviceId || 'default') : 'default'
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
    const hasImageCapture = typeof window.ImageCapture === 'function'
    const video = {}
    if (deviceId) video.deviceId = { exact: deviceId }
    else video.facingMode = { ideal: 'environment' }
    if (hasImageCapture) {
      // Stills come from takePhoto at full resolution; keep the stream modest.
      video.width = { ideal: 1920 }
      video.height = { ideal: 1080 }
    } else {
      // Open at the largest size to learn the range; fitStream() then sets the chosen one.
      video.width = { ideal: 4096 }
      video.height = { ideal: 3072 }
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
    await fitStream()
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
    C.resChoice = resChoice()
    C.resolution = pickResolution(out, C.resChoice, prefs.get('res:' + deviceKey(), null))
  }

  /** Video-frame mode: stills are the stream's size, so size the stream to the choice. */
  async function fitStream () {
    if (C.imageCapture || !C.track || !C.resolution) return
    const s = C.track.getSettings()
    if (s.width === C.resolution.w && s.height === C.resolution.h) return
    try {
      await C.track.applyConstraints({ width: { ideal: C.resolution.w }, height: { ideal: C.resolution.h } })
    } catch (e) { log('could not resize the stream:', e.message) }
  }

  async function setCamera (id) {
    prefs.set('cameraId', id || null)
    close()
    await open()
  }

  /** setResolution('lowest' | 'highest') or setResolution(w, h) for an exact size on this camera. */
  async function setResolution (wOrChoice, h) {
    if (wOrChoice === 'lowest' || wOrChoice === 'highest') {
      prefs.set('resChoice', wOrChoice)
    } else {
      const r = C.resolutions.find(x => x.w === wOrChoice && x.h === h)
      if (!r) return
      prefs.set('resChoice', 'exact')
      prefs.set('res:' + deviceKey(), { w: r.w, h: r.h })
    }
    computeResolutions()
    await fitStream()
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
        // Some cameras ignore imageWidth/imageHeight and return full size.
        // Below the maximum, check and scale down so Lowest means lowest.
        const belowMax = C.resolution && C.resolutions.some(r => r.w * r.h > C.resolution.w * C.resolution.h)
        if (blob.type !== 'image/jpeg' || belowMax) {
          const bmp = await createImageBitmap(blob)
          const over = belowMax && bmp.width > C.resolution.w * 1.05
          if (over || blob.type !== 'image/jpeg') {
            if (over) { w = C.resolution.w; h = Math.round(bmp.height * w / bmp.width) } else { w = bmp.width; h = bmp.height }
            blob = await toJpeg(bmp, w, h, jpegQuality())
          } else { w = bmp.width; h = bmp.height }
          bmp.close()
        }
        return { blob, w, h, method: 'takePhoto' }
      } catch (e) {
        log('takePhoto failed, using a video frame:', e.message)
      }
    }
    const v = await videoEl()
    // Never larger than the chosen size, also when takePhoto failed over to here.
    const s = C.resolution && v.videoWidth > C.resolution.w ? C.resolution.w / v.videoWidth : 1
    const w = Math.round(v.videoWidth * s)
    const h = Math.round(v.videoHeight * s)
    return { blob: await toJpeg(v, w, h, jpegQuality()), w, h, method: 'canvas' }
  }

  /**
   * Gallery copies of a captured still: a 320 px thumbnail and, if hdWidth,
   * an HD proxy for video export. One decode at the larger size.
   */
  async function galleryCopies (blob, hdWidth) {
    try {
      const bmp = await createImageBitmap(blob, hdWidth ? { resizeWidth: hdWidth, resizeQuality: 'high' } : { resizeWidth: 320, resizeQuality: 'medium' })
      const hd = hdWidth ? await toJpeg(bmp, bmp.width, bmp.height, 0.85) : null
      const tw = 320
      const thumb = await toJpeg(bmp, tw, Math.round(bmp.height * tw / bmp.width), 0.7)
      bmp.close()
      return { thumb, hd }
    } catch (e) { return null }
  }

  return {
    state: C,
    open,
    close,
    setCamera,
    setResolution,
    takeFrame,
    galleryCopies,
    get label () { return C.track ? C.track.label : '' },
    get usesImageCapture () { return !!C.imageCapture }
  }
}
