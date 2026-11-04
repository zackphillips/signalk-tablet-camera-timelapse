// KIP has no extension API, but its Embed Webpage widget is a same-origin,
// unsandboxed iframe, so we can read KIP's theme variables straight from the
// parent page and follow theme switches (day, night, light).

/** The parent document if we are embedded in KIP, else null. */
export function kipParent () {
  try {
    if (window.parent === window) return null
    const doc = window.parent.document
    const css = window.parent.getComputedStyle(doc.body)
    return css.getPropertyValue('--kip-contrast-color').trim() ? doc : null
  } catch (e) {
    return null // cross-origin parent
  }
}

// Our variable <- KIP / Material 3 system variable (first one that is set).
const MAP = {
  '--tl-fg': ['--kip-contrast-color', '--mat-sys-on-surface'],
  '--tl-muted': ['--kip-contrast-dim-color', '--mat-sys-on-surface-variant'],
  '--tl-line': ['--kip-widget-card-border-color', '--mat-sys-outline-variant'],
  '--tl-bg': ['--kip-widget-card-background-color', '--mat-sys-surface'],
  '--tl-field': ['--mat-sys-surface-container', '--kip-card-background-color'],
  '--tl-accent': ['--mat-sys-primary'],
  '--tl-on-accent': ['--mat-sys-on-primary'],
  '--tl-warn-bg': ['--mat-sys-error-container'],
  '--tl-warn-fg': ['--mat-sys-on-error-container'],
  '--tl-btn-bg': ['--mat-sys-surface-container-high', '--kip-card-background-color'],
  '--tl-btn-fg': ['--kip-contrast-color'],
  '--tl-grey': ['--kip-grey-color'],
  '--tl-amber': ['--kip-orange-color', '--kip-zone-warn-color'],
  '--tl-yellow': ['--kip-yellow-color'],
  '--tl-radius': ['--mat-sys-corner-medium']
}

function apply (doc) {
  const win = doc.defaultView
  const css = win.getComputedStyle(doc.body)
  const root = document.documentElement.style
  for (const [ours, theirs] of Object.entries(MAP)) {
    const v = theirs.map(k => css.getPropertyValue(k).trim()).find(Boolean)
    if (v) root.setProperty(ours, v)
  }
  root.setProperty('--tl-font', css.fontFamily)
  const scheme = css.getPropertyValue('color-scheme').trim()
  if (scheme) root.setProperty('color-scheme', scheme)
  // KIP's night theme is a body class; dim our camera images with it.
  if (doc.body.classList.contains('night-theme')) document.documentElement.dataset.night = ''
  else delete document.documentElement.dataset.night
}

export function applyKipTheme (doc) {
  apply(doc)
  // KIP switches themes by changing classes/attributes on html or body.
  const obs = new MutationObserver(() => apply(doc))
  for (const n of [doc.documentElement, doc.body]) obs.observe(n, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
  setInterval(() => apply(doc), 10000) // belt and braces for stylesheet swaps
}
