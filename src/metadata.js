'use strict'

/*
 * Navigation snapshot taken from the server's data at ingest, written as a
 * sidecar JSON and (optionally) as JPEG EXIF GPS/time tags.
 * Values are Signal K SI units (m/s, radians).
 */

const SNAPSHOT_PATHS = {
  position: 'navigation.position',
  speedOverGround: 'navigation.speedOverGround',
  courseOverGroundTrue: 'navigation.courseOverGroundTrue',
  headingTrue: 'navigation.headingTrue',
  headingMagnetic: 'navigation.headingMagnetic',
  windSpeedApparent: 'environment.wind.speedApparent',
  windAngleApparent: 'environment.wind.angleApparent',
  windSpeedTrue: 'environment.wind.speedTrue',
  windAngleTrueWater: 'environment.wind.angleTrueWater',
  windDirectionTrue: 'environment.wind.directionTrue'
}

function readPath (app, p) {
  try {
    const v = app.getSelfPath(p)
    if (v === undefined || v === null) return undefined
    if (typeof v === 'object' && 'value' in v) {
      return v.value === null ? undefined : { value: v.value, timestamp: v.timestamp }
    }
    return { value: v }
  } catch (e) {
    return undefined
  }
}

function snapshot (app) {
  const out = {}
  for (const [k, p] of Object.entries(SNAPSHOT_PATHS)) {
    const v = readPath(app, p)
    if (v !== undefined) out[k] = v
  }
  return out
}

function buildSidecar ({ captureDate, receivedDate, sessionId, mode, device, width, height, bytes, nav }) {
  return {
    captureTime: captureDate.toISOString(),
    receivedTime: receivedDate.toISOString(),
    sessionId,
    mode,
    device: device || null,
    image: { width: width || null, height: height || null, bytes },
    units: 'Signal K SI (m/s, rad, deg for position)',
    navigation: nav
  }
}

function toRational (x, denom) {
  return [Math.round(x * denom), denom]
}

function dms (deg) {
  const a = Math.abs(deg)
  const d = Math.floor(a)
  const mFloat = (a - d) * 60
  const m = Math.floor(mFloat)
  const s = (mFloat - m) * 60
  return [[d, 1], [m, 1], toRational(s, 1000)]
}

function exifDate (d) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}:${p(d.getUTCMonth() + 1)}:${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

/**
 * Insert EXIF GPS + time into a JPEG buffer. Keeps existing EXIF from the
 * camera. Returns the original buffer on any failure.
 */
function addExif (jpeg, { captureDate, nav }) {
  let piexif
  try { piexif = require('piexifjs') } catch (e) { return { buf: jpeg, error: 'piexifjs not installed' } }
  try {
    const bin = jpeg.toString('binary')
    let exif
    try { exif = piexif.load(bin) } catch (e) { exif = {} }
    exif['0th'] = exif['0th'] || {}
    exif.Exif = exif.Exif || {}
    exif.GPS = exif.GPS || {}
    const dt = exifDate(captureDate)
    // EXIF DateTime has no zone; these are UTC (GPSDateStamp/GPSTimeStamp are UTC by definition).
    exif['0th'][piexif.ImageIFD.DateTime] = dt
    exif.Exif[piexif.ExifIFD.DateTimeOriginal] = dt
    const pos = nav.position && nav.position.value
    if (pos && Number.isFinite(pos.latitude) && Number.isFinite(pos.longitude)) {
      exif.GPS[piexif.GPSIFD.GPSVersionID] = [2, 3, 0, 0]
      exif.GPS[piexif.GPSIFD.GPSLatitudeRef] = pos.latitude >= 0 ? 'N' : 'S'
      exif.GPS[piexif.GPSIFD.GPSLatitude] = dms(pos.latitude)
      exif.GPS[piexif.GPSIFD.GPSLongitudeRef] = pos.longitude >= 0 ? 'E' : 'W'
      exif.GPS[piexif.GPSIFD.GPSLongitude] = dms(pos.longitude)
      const d = captureDate
      exif.GPS[piexif.GPSIFD.GPSDateStamp] = exifDate(d).slice(0, 10)
      exif.GPS[piexif.GPSIFD.GPSTimeStamp] = [[d.getUTCHours(), 1], [d.getUTCMinutes(), 1], [d.getUTCSeconds(), 1]]
    }
    const sog = nav.speedOverGround && nav.speedOverGround.value
    if (Number.isFinite(sog)) {
      exif.GPS[piexif.GPSIFD.GPSSpeedRef] = 'N'
      exif.GPS[piexif.GPSIFD.GPSSpeed] = toRational(sog * 1.943844, 100)
    }
    const cog = nav.courseOverGroundTrue && nav.courseOverGroundTrue.value
    if (Number.isFinite(cog)) {
      exif.GPS[piexif.GPSIFD.GPSTrackRef] = 'T'
      exif.GPS[piexif.GPSIFD.GPSTrack] = toRational(((cog * 180 / Math.PI) % 360 + 360) % 360, 100)
    }
    const hdg = nav.headingTrue && nav.headingTrue.value
    if (Number.isFinite(hdg)) {
      exif.GPS[piexif.GPSIFD.GPSImgDirectionRef] = 'T'
      exif.GPS[piexif.GPSIFD.GPSImgDirection] = toRational(((hdg * 180 / Math.PI) % 360 + 360) % 360, 100)
    }
    // Thumbnails from the camera can push EXIF past the 64 KB APP1 limit.
    delete exif.thumbnail
    exif['1st'] = {}
    const out = piexif.insert(piexif.dump(exif), bin)
    return { buf: Buffer.from(out, 'binary') }
  } catch (e) {
    return { buf: jpeg, error: e.message }
  }
}

module.exports = { snapshot, buildSidecar, addExif, SNAPSHOT_PATHS, dms }
