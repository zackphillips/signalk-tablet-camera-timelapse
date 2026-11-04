// Timelapse video export in the browser: WebCodecs H.264 (VP9 fallback) into
// an MP4 with mp4-muxer. Nothing is encoded on the Pi.
import { Muxer, ArrayBufferTarget } from '../../vendor/mp4-muxer/mp4-muxer.js'

export function canEncode () {
  return typeof window.VideoEncoder === 'function' && typeof window.VideoFrame === 'function'
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2)

/** Output size for a target height, keeping the source aspect, even dimensions. */
export function outputSize (srcW, srcH, targetH) {
  const h = Math.min(targetH, srcH)
  return { width: even(srcW * h / srcH), height: even(h) }
}

export function bitrateFor (width, height, fps) {
  // ~0.12 bits per pixel per frame: clean for slow-changing timelapse content.
  return Math.round(Math.min(60e6, Math.max(2e6, width * height * fps * 0.12)))
}

/** First codec this device can encode at this size, as { codec, mux }. */
export async function pickCodec (width, height, fps, bitrate) {
  const candidates = [
    { codec: 'avc1.640033', mux: 'avc' }, // High 5.1 (up to 4K)
    { codec: 'avc1.640028', mux: 'avc' }, // High 4.0 (1080p)
    { codec: 'avc1.4d0028', mux: 'avc' }, // Main 4.0
    { codec: 'avc1.42e01f', mux: 'avc' }, // Baseline 3.1 (720p)
    { codec: 'vp09.00.40.08', mux: 'vp9' }
  ]
  for (const c of candidates) {
    const config = { codec: c.codec, width, height, framerate: fps, bitrate, latencyMode: 'quality' }
    if (c.mux === 'avc') config.avc = { format: 'avc' }
    try {
      const r = await VideoEncoder.isConfigSupported(config)
      if (r.supported) return { ...c, config: r.config }
    } catch (e) { /* try the next one */ }
  }
  return null
}

/**
 * Encode frames into an MP4 Blob.
 *  frames:  [{ url, meta }] in order
 *  overlay: (ctx, meta, width, height) => void, draws on top of each frame
 * Resolves { blob, codec, width, height, frames, ms }.
 */
export async function encodeVideo ({ frames, width, height, fps, overlay, onProgress, signal }) {
  if (!canEncode()) throw new Error('This browser cannot encode video (no WebCodecs)')
  const bitrate = bitrateFor(width, height, fps)
  const picked = await pickCodec(width, height, fps, bitrate)
  if (!picked) throw new Error(`No video encoder for ${width}×${height} on this device. Try a smaller size.`)

  const target = new ArrayBufferTarget()
  const muxer = new Muxer({
    target,
    video: { codec: picked.mux, width, height, frameRate: fps },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset'
  })
  let encodeError = null
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encodeError = e }
  })
  encoder.configure(picked.config)

  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  const started = performance.now()
  const frameUs = 1e6 / fps

  // Fetch and decode a few frames ahead; decode straight to the output size.
  const AHEAD = 4
  const pending = new Map()
  const load = (i) => {
    if (i >= frames.length || pending.has(i)) return
    pending.set(i, (async () => {
      const res = await fetch(frames[i].url, { credentials: 'same-origin', signal })
      if (!res.ok) throw new Error(`frame ${i + 1}: HTTP ${res.status}`)
      const blob = await res.blob()
      return createImageBitmap(blob, { resizeHeight: height, resizeQuality: 'high' })
    })())
  }

  try {
    for (let i = 0; i < Math.min(AHEAD, frames.length); i++) load(i)
    for (let i = 0; i < frames.length; i++) {
      if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError')
      if (encodeError) throw encodeError
      const bmp = await pending.get(i)
      pending.delete(i)
      load(i + AHEAD)

      // Fit inside the output, centred, black bars if the aspect differs.
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      const s = Math.min(width / bmp.width, height / bmp.height)
      const dw = bmp.width * s
      const dh = bmp.height * s
      ctx.drawImage(bmp, (width - dw) / 2, (height - dh) / 2, dw, dh)
      bmp.close()
      if (overlay) overlay(ctx, frames[i].meta, width, height)

      const vf = new VideoFrame(canvas, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) })
      while (encoder.encodeQueueSize > 4) await new Promise(r => setTimeout(r, 5))
      encoder.encode(vf, { keyFrame: i % Math.max(1, Math.round(fps * 2)) === 0 })
      vf.close()
      if (onProgress) onProgress(i + 1, frames.length, performance.now() - started)
    }
    await encoder.flush()
    if (encodeError) throw encodeError
    muxer.finalize()
  } finally {
    if (encoder.state !== 'closed') encoder.close()
    for (const p of pending.values()) p.then(b => b.close(), () => {})
  }
  return {
    blob: new Blob([target.buffer], { type: 'video/mp4' }),
    codec: picked.codec,
    width,
    height,
    frames: frames.length,
    ms: Math.round(performance.now() - started)
  }
}

/** Default overlay: local time and, when known, speed and course. */
export function drawInfoOverlay ({ time = true, nav = true, units = 'kn' } = {}) {
  return (ctx, meta, w, h) => {
    if (!meta) return
    const lines = []
    if (time && meta.time) {
      const d = new Date(meta.time)
      lines.push(d.toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }))
    }
    if (nav) {
      const parts = []
      if (typeof meta.sog === 'number') parts.push(`${(meta.sog * (units === 'kn' ? 1.943844 : 3.6)).toFixed(1)} ${units === 'kn' ? 'kn' : 'km/h'}`)
      const dir = typeof meta.cog === 'number' ? meta.cog : meta.heading
      if (typeof dir === 'number') parts.push(`${Math.round(((dir * 180 / Math.PI) % 360 + 360) % 360)}°`)
      if (typeof meta.aws === 'number') parts.push(`AWS ${(meta.aws * 1.943844).toFixed(0)} kn`)
      if (parts.length) lines.push(parts.join('  ·  '))
    }
    if (!lines.length) return
    const size = Math.max(14, Math.round(h / 28))
    ctx.font = `600 ${size}px system-ui, sans-serif`
    const pad = Math.round(size * 0.6)
    const lh = Math.round(size * 1.3)
    const boxW = Math.max(...lines.map(l => ctx.measureText(l).width)) + pad * 2
    const boxH = lh * lines.length + pad
    const x = pad
    const y = h - boxH - pad
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)'
    ctx.fillRect(x, y, boxW, boxH)
    ctx.fillStyle = '#fff'
    ctx.textBaseline = 'top'
    lines.forEach((l, i) => ctx.fillText(l, x + pad, y + pad / 2 + i * lh + (lh - size) / 2))
  }
}
