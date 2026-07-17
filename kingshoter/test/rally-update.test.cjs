const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function loadRallyUpdate() {
  const browser = {};
  const context = { globalThis: browser, URL, Promise, Number, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/battle-update.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/rally-update.js'), 'utf8'), context);
  return browser.RallyUpdate;
}

function response(body) {
  return { ok: true, json: async () => body };
}

function metadata(update, overrides = {}) {
  return {
    currentBuild: update.BUILD + 1,
    minKvkBuild: update.BUILD,
    minRallyBuild: update.BUILD + 1,
    minDefenseBuild: update.BUILD,
    minTripleBuild: update.BUILD,
    tripleEnabled: true,
    tripleQaEnabled: true,
    ...overrides
  };
}

test('Rally update gate uses only the Rally floor and supports one-cycle minKvk compatibility', () => {
  const update = loadRallyUpdate();
  assert.equal(update.BUILD, 2026071701);
  assert.equal(update.MIN_BUILD_KEY, 'minRallyBuild');
  assert.equal(update.QUERY_KEY, '__rally_build');
  assert.equal(update.shouldReload(metadata(update)), true);
  assert.equal(update.shouldReload(metadata(update, {
    minRallyBuild: update.BUILD,
    minDefenseBuild: update.BUILD + 1
  })), false, 'Defense floor cannot refresh Rally');
  assert.equal(update.shouldReload({
    currentBuild: update.BUILD + 1,
    minKvkBuild: update.BUILD + 1
  }), true, 'legacy metadata remains supported for one migration cycle');
});

test('Rally metadata validation fails closed for malformed or inconsistent floors', () => {
  const update = loadRallyUpdate();
  for (const value of [
    null,
    {},
    { currentBuild: update.BUILD + 1 },
    { currentBuild: String(update.BUILD + 1), minRallyBuild: update.BUILD + 1 },
    { currentBuild: update.BUILD + 1, minRallyBuild: String(update.BUILD + 1) },
    { currentBuild: update.BUILD + 1, minRallyBuild: update.BUILD + 2 },
    { currentBuild: 0, minRallyBuild: 0 }
  ]) assert.equal(update.shouldReload(value), false);
  assert.equal(update.shouldReload({
    currentBuild: update.BUILD + 1,
    minRallyBuild: 'malformed',
    minKvkBuild: update.BUILD + 1
  }), false, 'legacy fallback applies only when the surface floor is absent, never malformed');
  const hostile = new Proxy({}, { get() { throw new Error('hostile getter'); } });
  assert.doesNotThrow(() => update.shouldReload(hostile));
  assert.equal(update.shouldReload(hostile), false);
});

test('Rally reload URL writes one Rally build key and preserves room state and hash', () => {
  const update = loadRallyUpdate();
  const target = new URL(update.reloadURL(
    'https://kingshoter.com/rally?room=qa&lang=en&notour=1&__kvk_build=1&__rally_build=2&__rally_build=3&__defense_build=4#command',
    update.BUILD + 1
  ));
  assert.equal(target.pathname, '/rally');
  assert.equal(target.searchParams.get('room'), 'qa');
  assert.equal(target.searchParams.get('lang'), 'en');
  assert.equal(target.searchParams.get('notour'), '1');
  assert.deepEqual(target.searchParams.getAll('__rally_build'), [String(update.BUILD + 1)]);
  assert.equal(target.searchParams.has('__kvk_build'), false);
  assert.equal(target.searchParams.has('__defense_build'), false);
  assert.equal(target.hash, '#command');
});

test('Rally stale client refreshes immediately when idle and defers while its personal cue is future', async () => {
  const update = loadRallyUpdate();
  let active = false;
  const replacements = [];
  const controller = update.createController({
    fetcher: async () => response(metadata(update)),
    location: {
      href: 'https://kingshoter.com/rally?room=qa',
      replace: (url) => replacements.push(url)
    },
    document: { hidden: false, getElementById: () => null, addEventListener() {} },
    hasActivePersonalCommand: () => active,
    setIntervalFn() {}
  });
  assert.equal(await controller.check(), true);
  assert.equal(replacements.length, 1);

  active = true;
  const deferred = [];
  const deferredController = update.createController({
    fetcher: async () => response(metadata(update)),
    location: {
      href: 'https://kingshoter.com/rally?room=qa',
      replace: (url) => deferred.push(url)
    },
    document: { hidden: false, getElementById: () => null, addEventListener() {} },
    hasActivePersonalCommand: () => active,
    setIntervalFn() {}
  });
  assert.equal(await deferredController.check(), false);
  assert.deepEqual(deferred, []);
  active = false;
  assert.equal(deferredController.flush(), true);
  assert.equal(deferred.length, 1);
});

test('Rally build request timeout fails closed and releases the single-flight latch', async () => {
  const update = loadRallyUpdate();
  let calls = 0;
  let timeoutCallback;
  const controller = update.createController({
    fetcher: async () => {
      calls += 1;
      if (calls === 1) return new Promise(() => {});
      return response(metadata(update, { minRallyBuild: update.BUILD }));
    },
    location: { href: 'https://kingshoter.com/rally?room=qa', replace() {} },
    document: { hidden: false, getElementById: () => null, addEventListener() {} },
    hasActivePersonalCommand: () => false,
    setIntervalFn() {},
    setTimeoutFn(callback, ms) {
      assert.equal(ms, 10_000);
      timeoutCallback = callback;
      return 7;
    },
    clearTimeoutFn() {}
  });
  const first = controller.check();
  await new Promise((resolve) => setImmediate(resolve));
  timeoutCallback();
  assert.equal(await first, false);
  assert.equal(await controller.check(), false);
  assert.equal(calls, 2);
});
