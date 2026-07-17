const { basename } = require('node:path');

module.exports = function stopLegacyKvkScript(filename) {
  throw new Error(
    `Disabled legacy KvK script ${basename(String(filename || 'unknown'))}. ` +
    'Use npm run test:qa:rally-defense; it is locked to the fixed QA room and password qa.'
  );
};
