const { basename } = require('node:path');

module.exports = function stopLegacyKvkScript(filename) {
  throw new Error(
    `Disabled legacy KvK script ${basename(String(filename || 'unknown'))}. ` +
    'Use npm run test:qa:delivery or npm run test:qa:triple; both create isolated qa-kvk-* rooms.'
  );
};
