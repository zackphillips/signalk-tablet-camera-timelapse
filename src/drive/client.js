'use strict'

/*
 * The built-in Google OAuth client ("TVs and Limited Input devices"), so
 * connecting Drive is just Connect + approve, with no Google Cloud setup.
 *
 * Empty in git on purpose. The publish workflow (.github/workflows/publish.yml)
 * writes the real values with scripts/write-client.js just before npm publish,
 * so they reach the npm package without being committed. Google treats
 * device-flow clients as public, but GitHub secret scanning flags the secret.
 *
 * With both empty (a build from the repository), the panel requires
 * "Use my own Google Cloud client".
 */
module.exports = {
  clientId: '',
  clientSecret: ''
}
