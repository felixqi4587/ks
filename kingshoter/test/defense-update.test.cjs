const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function loadDefenseUpdate() {
  const browser = {};
  const context = { globalThis: browser, URL, Promise, Number, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/battle-update.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/defense-update.js'), 'utf8'), context);
  return browser.DefenseUpdate;
}

function response(body) {
  return { ok: true, json: async () => body };
}

function metadata(update, overrides = {}) {
  return {
    currentBuild: update.BUILD + 1,
    minKvkBuild: update.BUILD,
    minRallyBuild: update.BUILD,
    minDefenseBuild: update.BUILD + 1,
    minTripleBuild: update.BUILD,
    tripleEnabled: true,
    tripleQaEnabled: true,
    ...overrides
  };
}

test('Defense update gate uses only the Defense floor and the Defense query key', () => {
  const update = loadDefenseUpdate();
  assert.equal(update.BUILD, 2026071603);
  assert.equal(update.MIN_BUILD_KEY, 'minDefenseBuild');
  assert.equal(update.QUERY_KEY, '__defense_build');
  assert.equal(update.shouldReload(metadata(update)), true);
  assert.equal(update.shouldReload(metadata(update, {
    minRallyBuild: update.BUILD + 1,
    minDefenseBuild: update.BUILD
  })), false, 'Rally floor cannot refresh Defense');
  const target = new URL(update.reloadURL(
    'https://kingshoter.com/defense?room=qa&__rally_build=1&__defense_build=2',
    update.BUILD + 1
  ));
  assert.deepEqual(target.searchParams.getAll('__defense_build'), [String(update.BUILD + 1)]);
  assert.equal(target.searchParams.has('__rally_build'), false);
});

test('Defense controller delays a stale refresh until the personal future cue is gone', async () => {
  const update = loadDefenseUpdate();
  let active = true;
  const replacements = [];
  const controller = update.createController({
    fetcher: async () => response(metadata(update)),
    location: {
      href: 'https://kingshoter.com/defense?room=qa',
      replace: (url) => replacements.push(url)
    },
    document: { hidden: false, getElementById: () => null, addEventListener() {} },
    hasActivePersonalCommand: () => active,
    setIntervalFn() {}
  });
  assert.equal(await controller.check(), false);
  assert.deepEqual(replacements, []);
  active = false;
  assert.equal(controller.flush(), true);
  assert.equal(replacements.length, 1);
});

test('Defense browser predicate is conservative before mount and exact after canonical personal state arrives', () => {
  const update = loadDefenseUpdate();
  const rootWindow = {
    location: { href: 'https://kingshoter.com/defense?room=qa', search: '?room=qa' }
  };
  assert.equal(update.hasActivePersonalCommand(rootWindow), true,
    'a joined room cannot refresh before its first canonical snapshot');
  rootWindow.__kingshoterDefenseMounted = {
    connection: { serverNowMs: () => 1_000_000 },
    controller: { state: () => ({ personal: { captured: false, phase: 'waiting' } }) }
  };
  assert.equal(update.hasActivePersonalCommand(rootWindow), false);
  rootWindow.__kingshoterDefenseMounted.controller.state = () => ({
    personal: { captured: true, tooLate: false, goAtMs: 1_000_500 }
  });
  assert.equal(update.hasActivePersonalCommand(rootWindow), true);
  rootWindow.__kingshoterDefenseMounted.controller.state = () => ({
    personal: { captured: true, tooLate: false, goAtMs: 998_900 }
  });
  assert.equal(update.hasActivePersonalCommand(rootWindow), false,
    'the one-second cue tail releases immediately after it ends');
});

test('Defense wrapper installs one fail-closed browser controller and polls pending refreshes', () => {
  const update = loadDefenseUpdate();
  const intervals = [];
  const listeners = [];
  const win = {
    fetch: async () => response(metadata(update, { minDefenseBuild: update.BUILD })),
    location: { href: 'https://kingshoter.com/defense?room=qa', search: '?room=qa', replace() {} },
    document: {
      hidden: false,
      getElementById: () => null,
      addEventListener: (...args) => listeners.push(args)
    },
    setInterval(callback, ms) { intervals.push([callback, ms]); return intervals.length; },
    setTimeout,
    clearTimeout
  };
  const first = update.install(win);
  const second = update.install(win);
  assert.strictEqual(first, second);
  assert.equal(win.__kingshoterDefenseUpdate, first);
  assert.ok(intervals.some(([, ms]) => ms === 60_000), 'periodic metadata check remains installed');
  assert.ok(intervals.some(([, ms]) => ms === 1_000), 'pending refresh is released promptly after a cue');
  assert.ok(listeners.some(([type]) => type === 'visibilitychange'));
});
