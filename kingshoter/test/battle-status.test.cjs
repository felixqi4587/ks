const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_PATH = path.join(__dirname, '../public/battle-status.js');
const plain = value => JSON.parse(JSON.stringify(value));

function loadCommonApi() {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  const moduleValue = { exports: {} };
  vm.runInNewContext(source, { module: moduleValue, exports: moduleValue.exports, globalThis: {} }, { filename: MODULE_PATH });
  return moduleValue.exports;
}

function loadBrowserApi() {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  const context = {};
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: MODULE_PATH });
  return context.BattleStatus;
}

test('BattleStatus loads through CommonJS and the browser UMD surface', () => {
  const common = loadCommonApi();
  const browser = loadBrowserApi();
  assert.equal(typeof common.deriveReadiness, 'function');
  assert.equal(typeof browser.deriveReadiness, 'function');
  assert.deepEqual(Object.keys(common), ['deriveReadiness']);
});

test('green readiness requires all five independently measurable conditions', () => {
  const { deriveReadiness } = loadCommonApi();
  const healthy = {
    userEnabled: true,
    audioContextRunning: true,
    carrierAlive: true,
    connected: true,
    clockFresh: true
  };
  const ready = deriveReadiness(healthy);
  assert.deepEqual(plain(ready), { level: 'ready', green: true, reasons: [] });
  assert.equal(Object.isFrozen(ready), true);
  assert.equal(Object.isFrozen(ready.reasons), true);

  const reasonByField = {
    userEnabled: 'user_disabled',
    audioContextRunning: 'audio_context_not_running',
    carrierAlive: 'carrier_not_alive',
    connected: 'disconnected',
    clockFresh: 'clock_stale'
  };
  for (const [field, reason] of Object.entries(reasonByField)) {
    const input = { ...healthy, [field]: false };
    assert.deepEqual(plain(deriveReadiness(input)), {
      level: 'not_ready', green: false, reasons: [reason]
    }, field);
  }
});

test('readiness reasons are deterministic and input is never mutated', () => {
  const { deriveReadiness } = loadCommonApi();
  const input = Object.freeze({
    userEnabled: false,
    audioContextRunning: false,
    carrierAlive: false,
    connected: false,
    clockFresh: false
  });
  assert.deepEqual(plain(deriveReadiness(input)), {
    level: 'not_ready',
    green: false,
    reasons: [
      'user_disabled',
      'audio_context_not_running',
      'carrier_not_alive',
      'disconnected',
      'clock_stale'
    ]
  });
});
