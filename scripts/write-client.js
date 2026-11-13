'use strict'

// Writes src/drive/client.js from GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.
// Run only in the publish workflow; never commit the result.

const fs = require('fs')
const path = require('path')

const id = (process.env.GOOGLE_CLIENT_ID || '').trim()
const secret = (process.env.GOOGLE_CLIENT_SECRET || '').trim()

if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(id)) {
  console.error('GOOGLE_CLIENT_ID is missing or not a Google client ID')
  process.exit(1)
}
if (!secret) {
  console.error('GOOGLE_CLIENT_SECRET is missing')
  process.exit(1)
}

const out = path.join(__dirname, '..', 'src', 'drive', 'client.js')
fs.writeFileSync(out, `'use strict'

// Written by scripts/write-client.js at publish time.
module.exports = ${JSON.stringify({ clientId: id, clientSecret: secret }, null, 2)}
`)
console.log(`wrote ${path.relative(process.cwd(), out)} for client ${id}`)
