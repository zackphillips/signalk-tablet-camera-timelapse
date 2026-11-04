// Follow Freeboard's night mode so our pages switch palettes with it.
export async function followFreeboardNight (client) {
  if (!client.hasCapability('nightMode')) return
  const set = (on) => { if (on) document.documentElement.dataset.night = ''; else delete document.documentElement.dataset.night }
  try { set((await client.call('nightMode.get')).enabled) } catch (e) { /* ignore */ }
  await client.subscribe(['nightMode.changed'], (_n, p) => set(p.enabled))
}
