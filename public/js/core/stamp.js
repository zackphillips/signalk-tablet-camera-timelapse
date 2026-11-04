// Burn the capture time into a frame. Runs on the tablet before upload, so
// the stamp is in the file on the Pi, in Drive and in the gallery copies.

/** "2026-11-04 14:23:05 PST" in the tablet's time zone. */
export function formatStamp (date) {
  const p = (n) => String(n).padStart(2, '0')
  const d = date
  let tz = ''
  try {
    tz = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(d).find(x => x.type === 'timeZoneName').value
  } catch (e) { /* no Intl time zones */ }
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${tz ? ' ' + tz : ''}`
}

/** Text box geometry for an image of w × h: font size scales with the shorter side. */
export function stampLayout (w, h, position, textWidth) {
  const size = Math.max(12, Math.round(Math.min(w, h) * 0.035))
  const pad = Math.round(size * 0.35)
  const margin = Math.round(size * 0.6)
  const bw = Math.ceil(textWidth + 2 * pad)
  const bh = Math.ceil(size * 1.25 + 2 * pad)
  const right = position.endsWith('right')
  const bottom = position.startsWith('bottom')
  const x = right ? w - margin - bw : margin
  const y = bottom ? h - margin - bh : margin
  return { size, pad, x, y, bw, bh }
}

/**
 * Returns a new JPEG with the stamp drawn in the given corner. Decodes once,
 * at the frame's full size.
 */
export async function stampJpeg (blob, date, position, quality = 0.9) {
  const bmp = await createImageBitmap(blob)
  const w = bmp.width
  const h = bmp.height
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.drawImage(bmp, 0, 0)
  bmp.close()
  const text = formatStamp(date)
  const probe = Math.max(12, Math.round(Math.min(w, h) * 0.035))
  ctx.font = `600 ${probe}px system-ui, Roboto, sans-serif`
  const L = stampLayout(w, h, position, ctx.measureText(text).width)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
  ctx.fillRect(L.x, L.y, L.bw, L.bh)
  ctx.fillStyle = '#ffffff'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, L.x + L.pad, L.y + L.bh / 2)
  const out = await new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', quality))
  canvas.width = canvas.height = 0 // release the bitmap memory now, not at GC
  return { blob: out, w, h }
}
