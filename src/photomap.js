'use strict'

/*
 * Photo markers for the chart: frames that carry a position, thinned so a
 * long passage draws a readable row of dots instead of a solid line, as a
 * GeoJSON FeatureCollection for the Freeboard data overlay.
 */

const EARTH_R = 6371008.8

function validPosition (p) {
  return !!p && typeof p.latitude === 'number' && typeof p.longitude === 'number' &&
    Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180 &&
    !(p.latitude === 0 && p.longitude === 0)
}

function distanceM (a, b) {
  const rad = Math.PI / 180
  const dLat = (b.latitude - a.latitude) * rad
  const dLon = (b.longitude - a.longitude) * rad
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)))
}

/**
 * Keep the first frame of a session, then each frame at least spacingM from
 * the last kept one, and always the last. Frames must be in time order.
 * Lying at anchor this leaves a handful of markers; the viewer steps through
 * every frame in between.
 */
function thinFrames (frames, spacingM) {
  const withPos = frames.filter(f => validPosition(f.position))
  if (!(spacingM > 0) || withPos.length < 3) return withPos
  const out = [withPos[0]]
  for (let i = 1; i < withPos.length - 1; i++) {
    if (distanceM(out[out.length - 1].position, withPos[i].position) >= spacingM) out.push(withPos[i])
  }
  const last = withPos[withPos.length - 1]
  if (last !== out[out.length - 1]) out.push(last)
  return out
}

const round = (v, d) => (typeof v === 'number' ? Number(v.toFixed(d)) : null)

/** sessions: [{ id, frames }] with frames in time order. */
function photoFeatures (sessions, { spacingM }) {
  const features = []
  let latest = null
  for (const s of sessions) {
    for (const f of thinFrames(s.frames, spacingM)) {
      const feat = {
        type: 'Feature',
        id: `${s.id}/${f.name}`,
        geometry: { type: 'Point', coordinates: [round(f.position.longitude, 6), round(f.position.latitude, 6)] },
        properties: {
          session: s.id,
          name: f.name,
          time: f.time,
          title: `Photo ${String(f.time || '').replace('T', ' ').slice(0, 16)} UTC`,
          latest: false
        }
      }
      if (!latest || f.time > latest.properties.time) latest = feat
      features.push(feat)
    }
  }
  if (latest) latest.properties.latest = true
  return { type: 'FeatureCollection', features }
}

module.exports = { validPosition, distanceM, thinFrames, photoFeatures }
