const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const BUILD = '2026071603';

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

test('canonical Rally page uses the coherent Rally updater before the unchanged runtime', () => {
  const html = read('public/rally.html');
  const shared = html.indexOf(`/battle-update.js?v=${BUILD}`);
  const updater = html.indexOf(`/rally-update.js?v=${BUILD}`);
  const app = html.indexOf(`/app.js?v=${BUILD}`);
  const runtime = html.indexOf(`/kvk.js?v=${BUILD}`);
  assert.ok(shared >= 0 && shared < updater && updater < app && app < runtime);
  assert.doesNotMatch(html, /\/kvk-update\.js/);
  assert.equal((html.match(/id="updateGate"/g) || []).length, 1);
});

test('Rally wrapper is thin and exposes the temporary KvkUpdate alias required by the unchanged runtime', () => {
  const source = read('public/rally-update.js');
  assert.match(source, /BattleUpdate/);
  assert.match(source, /createSurface/);
  assert.doesNotMatch(source, /function\s+requestBuild|BUILD_CHECK_TIMEOUT_MS/,
    'controller implementation belongs only to the shared module');

  const browser = {};
  const context = { globalThis: browser, URL, Promise, Number };
  vm.runInNewContext(read('public/battle-update.js'), context);
  vm.runInNewContext(source, context);
  assert.strictEqual(browser.RallyUpdate, browser.KvkUpdate);
});

test('Defense page loads the shared update implementation and Defense wrapper exactly once', () => {
  const html = read('public/defense.html');
  for (const asset of [`/battle-update.js?v=${BUILD}`, `/defense-update.js?v=${BUILD}`]) {
    assert.equal(html.split(asset).length - 1, 1, asset);
  }
  assert.ok(html.indexOf(`/battle-update.js?v=${BUILD}`) < html.indexOf(`/defense-update.js?v=${BUILD}`));
  assert.ok(html.indexOf(`/defense-update.js?v=${BUILD}`) < html.indexOf(`/defense-controller.js?v=${BUILD}`));
  assert.match(html, /id="updateGate"[^>]*role="status"[^>]*aria-live="assertive"[^>]*hidden/);
  assert.match(html, /<div[^>]*class="update-card"[^>]*>Updating…<\/div>/);
});
