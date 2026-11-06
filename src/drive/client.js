'use strict'

/*
 * The built-in Google OAuth client ("TVs and Limited Input devices"), so
 * connecting Drive is just Connect + approve, with no Google Cloud setup.
 *
 * Google treats installed/device-flow clients as public: the secret is not
 * confidential and ships in the code by design. The client can only reach
 * files this plugin created (drive.file). Leave both empty to require
 * "Use my own Google credentials" in the panel.
 */
module.exports = {
  clientId: '331036943648-744duvflgr2k6r55vhom8djn9u5o0726.apps.googleusercontent.com',
  clientSecret: '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'
}
