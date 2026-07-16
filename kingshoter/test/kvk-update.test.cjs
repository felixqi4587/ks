const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadUpdate(build) {
  let source = fs.readFileSync(path.join(__dirname, '../public/kvk-update.js'), 'utf8');
  if (Number.isSafeInteger(build)) source = source.replace(/var BUILD = \d+;/, `var BUILD = ${build};`);
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, URL, globalThis: {} });
  return module.exports;
}

function meta(update, overrides = {}) {
  return {
    currentBuild: update.BUILD + 1,
    minKvkBuild: update.BUILD + 1,
    minTripleBuild: update.BUILD,
    tripleEnabled: false,
    tripleQaEnabled: true,
    ...overrides
  };
}

function response(body) {
  return { ok: true, json: async () => body };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('metadata must contain safe positive and internally consistent current/minimum builds', () => {
  const update = loadUpdate();
  assert.equal(update.BUILD, 2026071506);
  assert.equal(update.shouldReload(meta(update)), true);
  assert.equal(update.shouldReload(meta(update, { minKvkBuild: update.BUILD })), false);

  const invalid = [
    null,
    {},
    { currentBuild: update.BUILD + 1 },
    { minKvkBuild: update.BUILD + 1 },
    { currentBuild: String(update.BUILD + 1), minKvkBuild: update.BUILD + 1 },
    { currentBuild: update.BUILD + 1, minKvkBuild: String(update.BUILD + 1) },
    { currentBuild: 0, minKvkBuild: 0 },
    { currentBuild: -1, minKvkBuild: -1 },
    { currentBuild: update.BUILD + 0.5, minKvkBuild: update.BUILD },
    { currentBuild: Number.MAX_SAFE_INTEGER + 1, minKvkBuild: update.BUILD + 1 },
    { currentBuild: update.BUILD + 1, minKvkBuild: Number.MAX_SAFE_INTEGER + 1 },
    { currentBuild: update.BUILD + 1, minKvkBuild: update.BUILD + 2 }
  ];
  for (const value of invalid) assert.equal(update.shouldReload(value), false);
  const hostile = new Proxy({}, { get() { throw new Error('metadata getter failed'); } });
  assert.doesNotThrow(() => update.shouldReload(hostile));
  assert.equal(update.shouldReload(hostile), false);
});

test('the updater bootstrap keeps supported older updater generations running', () => {
  const metadata = {
    currentBuild: 2026071501,
    minKvkBuild: 2026071301,
    minTripleBuild: 2026071501
  };
  assert.equal(loadUpdate(2026071302).shouldReload(metadata), false);
  assert.equal(loadUpdate(2026071303).shouldReload(metadata), false);
});

test('a later minimum-build deployment refreshes every updater-capable stale generation', () => {
  const raisedMinimum = {
    currentBuild: 2026071501,
    minKvkBuild: 2026071501,
    minTripleBuild: 2026071501
  };
  assert.equal(loadUpdate(2026071302).shouldReload(raisedMinimum), true);
  assert.equal(loadUpdate(2026071303).shouldReload(raisedMinimum), true);
});

test('reloadURL preserves room state while replacing one cache-busting build parameter', () => {
  const update = loadUpdate();
  const href = 'https://kingshoter.com/kvk?room=qa-kvk-a&__kvk_build=1#command';
  const reloaded = new URL(update.reloadURL(href, update.BUILD + 1));
  assert.equal(reloaded.searchParams.get('room'), 'qa-kvk-a');
  assert.deepEqual(reloaded.searchParams.getAll('__kvk_build'), [String(update.BUILD + 1)]);
  assert.equal(reloaded.hash, '#command');
});

test('stale clients replace once with the minimum supported build URL', async () => {
  const update = loadUpdate();
  const fetchCalls = [];
  const replaceCalls = [];
  const gate = { hidden: true };
  const controller = update.createController({
    fetcher: async (...args) => { fetchCalls.push(args); return response(meta(update)); },
    location: {
      href: 'https://kingshoter.com/kvk?room=qa-kvk-a',
      replace: (url) => replaceCalls.push(url)
    },
    document: { hidden: false, getElementById: () => gate, addEventListener() {} },
    hasActivePersonalCommand: () => false,
    setIntervalFn() {}
  });

  assert.deepEqual(Object.keys(controller).sort(), ['check', 'flush', 'start']);
  assert.equal(await controller.check(), true);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0][0], '/api/build');
  assert.deepEqual(JSON.parse(JSON.stringify(fetchCalls[0][1])), { cache: 'no-store' });
  assert.equal(new URL(replaceCalls[0]).searchParams.get('__kvk_build'), String(update.BUILD + 1));
  assert.equal(gate.hidden, false);
  assert.equal(controller.flush(), false);
  assert.equal(await controller.check(), false);
  assert.equal(fetchCalls.length, 1, 'the reload latch suppresses later checks');
  assert.equal(replaceCalls.length, 1);
});

test('a later valid no-update response withdraws a deferred reload', async () => {
  const update = loadUpdate();
  let active = true;
  const bodies = [
    meta(update),
    meta(update, { minKvkBuild: update.BUILD })
  ];
  const replaceCalls = [];
  const controller = update.createController({
    fetcher: async () => response(bodies.shift()),
    location: { href: 'https://kingshoter.com/kvk?room=qa-kvk-withdraw', replace: (url) => replaceCalls.push(url) },
    document: { hidden: false, getElementById: () => ({ hidden: true }), addEventListener() {} },
    hasActivePersonalCommand: () => active,
    setIntervalFn() {}
  });

  assert.equal(await controller.check(), false);
  assert.equal(await controller.check(), false);
  active = false;
  assert.equal(controller.flush(), false);
  assert.deepEqual(replaceCalls, []);
});

test('active or throwing personal-command predicates defer without forgetting a valid update', async () => {
  const update = loadUpdate();
  let predicate = 'active';
  const replaceCalls = [];
  const gate = { hidden: true };
  const controller = update.createController({
    fetcher: async () => response(meta(update)),
    location: { href: 'https://kingshoter.com/kvk?room=qa-kvk-active', replace: (url) => replaceCalls.push(url) },
    document: { hidden: false, getElementById: () => gate, addEventListener() {} },
    hasActivePersonalCommand() {
      if (predicate === 'throw') throw new Error('countdown state unavailable');
      return predicate === 'active';
    },
    setIntervalFn() {}
  });

  assert.equal(await controller.check(), false);
  assert.deepEqual(replaceCalls, []);
  assert.equal(gate.hidden, true);
  predicate = 'throw';
  assert.equal(controller.flush(), false);
  assert.equal(gate.hidden, true);
  predicate = 'inactive';
  assert.equal(controller.flush(), true);
  assert.equal(replaceCalls.length, 1);
  assert.equal(gate.hidden, false);
});

test('overlapping checks share one fetch and can trigger only one replacement', async () => {
  const update = loadUpdate();
  let release;
  let fetchCalls = 0;
  const waiting = new Promise((resolve) => { release = resolve; });
  const replaceCalls = [];
  const controller = update.createController({
    fetcher: async () => { fetchCalls += 1; return waiting; },
    location: { href: 'https://kingshoter.com/kvk?room=qa-kvk-overlap', replace: (url) => replaceCalls.push(url) },
    document: { hidden: false, getElementById: () => ({ hidden: true }), addEventListener() {} },
    hasActivePersonalCommand: () => false,
    setIntervalFn() {}
  });

  const first = controller.check();
  const second = controller.check();
  assert.strictEqual(first, second);
  release(response(meta(update)));
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(fetchCalls, 1);
  assert.equal(replaceCalls.length, 1);
});

test('a hung build request times out and a later check can recover', async () => {
  const update = loadUpdate();
  let fetchCalls = 0;
  let timeoutCallback = null;
  let timeoutMs = 0;
  const cleared = [];
  const controller = update.createController({
    fetcher: async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) return new Promise(() => {});
      return response(meta(update, { minKvkBuild: update.BUILD }));
    },
    location: { href: 'https://kingshoter.com/kvk?room=qa-kvk-timeout', replace() {} },
    document: { hidden: false, getElementById: () => null, addEventListener() {} },
    hasActivePersonalCommand: () => false,
    setIntervalFn() {},
    setTimeoutFn(callback, ms) { timeoutCallback = callback; timeoutMs = ms; return 17; },
    clearTimeoutFn(id) { cleared.push(id); }
  });

  const first = controller.check();
  await settle();
  assert.equal(fetchCalls, 1);
  assert.equal(timeoutMs, 10_000);
  timeoutCallback();
  assert.equal(await first, false);

  assert.equal(await controller.check(), false);
  assert.equal(fetchCalls, 2, 'the timed-out request must not hold the single-flight latch');
  assert.deepEqual(cleared, [17], 'the successful retry clears its timeout');
});

test('a hung build response body shares the timeout and does not lock later checks', async () => {
  const update = loadUpdate();
  let fetchCalls = 0;
  let timeoutCallback = null;
  const controller = update.createController({
    fetcher: async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) return { ok: true, json: async () => new Promise(() => {}) };
      return response(meta(update, { minKvkBuild: update.BUILD }));
    },
    location: { href: 'https://kingshoter.com/kvk?room=qa-kvk-body-timeout', replace() {} },
    document: { hidden: false, getElementById: () => null, addEventListener() {} },
    hasActivePersonalCommand: () => false,
    setIntervalFn() {},
    setTimeoutFn(callback) { timeoutCallback = callback; return 23; },
    clearTimeoutFn() {}
  });

  const first = controller.check();
  await settle();
  timeoutCallback();
  const firstResult = await Promise.race([first, settle().then(() => 'still-hung')]);
  assert.equal(firstResult, false, 'body parsing must remain inside the bounded request');
  assert.equal(await controller.check(), false);
  assert.equal(fetchCalls, 2);
});

test('malformed and failed checks fail closed without erasing an earlier valid pending build', async () => {
  const update = loadUpdate();
  let active = true;
  const outcomes = [
    response(meta(update)),
    response({ currentBuild: update.BUILD + 1, minKvkBuild: update.BUILD + 2 }),
    response({ currentBuild: String(update.BUILD + 1), minKvkBuild: update.BUILD + 1 }),
    { ok: false, json: async () => meta(update) },
    new Error('network unavailable')
  ];
  const replaceCalls = [];
  const controller = update.createController({
    fetcher: async () => {
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    location: { href: 'https://kingshoter.com/kvk?room=qa-kvk-fail-closed', replace: (url) => replaceCalls.push(url) },
    document: { hidden: false, getElementById: () => ({ hidden: true }), addEventListener() {} },
    hasActivePersonalCommand: () => active,
    setIntervalFn() {}
  });

  for (let index = 0; index < 5; index += 1) assert.equal(await controller.check(), false);
  active = false;
  assert.equal(controller.flush(), true, 'only a later valid no-update response may clear pending');
  assert.equal(replaceCalls.length, 1);
});

test('a throwing replace hides the gate and releases the reload latch for an explicit retry', async () => {
  const update = loadUpdate();
  let shouldThrow = true;
  let replaceCalls = 0;
  const gate = { hidden: true };
  const controller = update.createController({
    fetcher: async () => response(meta(update)),
    location: {
      href: 'https://kingshoter.com/kvk?room=qa-kvk-retry',
      replace() {
        replaceCalls += 1;
        if (shouldThrow) throw new Error('replace unavailable');
      }
    },
    document: { hidden: false, getElementById: () => gate, addEventListener() {} },
    hasActivePersonalCommand: () => false,
    setIntervalFn() {}
  });

  assert.equal(await controller.check(), false);
  assert.equal(gate.hidden, true);
  shouldThrow = false;
  assert.equal(controller.flush(), true);
  assert.equal(gate.hidden, false);
  assert.equal(controller.flush(), false);
  assert.equal(replaceCalls, 2);
});

test('start is idempotent, checks initially, and checks only visible interval or visibility events', async () => {
  const update = loadUpdate();
  let fetchCalls = 0;
  let intervalCallback = null;
  let visibilityCallback = null;
  let intervalMs = 0;
  const document = {
    hidden: true,
    getElementById: () => null,
    addEventListener(type, callback) {
      assert.equal(type, 'visibilitychange');
      visibilityCallback = callback;
    }
  };
  const controller = update.createController({
    fetcher: async () => { fetchCalls += 1; return response(meta(update, { minKvkBuild: update.BUILD })); },
    location: { href: 'https://kingshoter.com/kvk?room=qa-kvk-start', replace() {} },
    document,
    hasActivePersonalCommand: () => false,
    setIntervalFn(callback, ms) { intervalCallback = callback; intervalMs = ms; return 7; }
  });

  assert.equal(controller.start(), true);
  assert.equal(controller.start(), false);
  await settle();
  assert.equal(fetchCalls, 1, 'the initial check runs even if the page starts hidden');
  assert.equal(intervalMs, 60_000);

  intervalCallback();
  visibilityCallback();
  await settle();
  assert.equal(fetchCalls, 1, 'background interval and visibility events stay inert');

  document.hidden = false;
  visibilityCallback();
  await settle();
  assert.equal(fetchCalls, 2);
  intervalCallback();
  await settle();
  assert.equal(fetchCalls, 3);
});

test('start contains scheduler failures and still performs its initial fail-closed check', async () => {
  const update = loadUpdate();
  let fetchCalls = 0;
  const controller = update.createController({
    fetcher: async () => { fetchCalls += 1; throw new Error('offline'); },
    location: { href: 'https://kingshoter.com/kvk?room=qa-kvk-start-errors', replace() {} },
    document: {
      hidden: false,
      getElementById() { throw new Error('DOM unavailable'); },
      addEventListener() { throw new Error('listener unavailable'); }
    },
    hasActivePersonalCommand: () => false,
    setIntervalFn() { throw new Error('timer unavailable'); }
  });

  assert.doesNotThrow(() => controller.start());
  await settle();
  assert.equal(fetchCalls, 1);
});
