const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'kvk.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'app.css'), 'utf8');
const kvk = fs.readFileSync(path.join(root, 'public', 'kvk.js'), 'utf8');
const BUILD = '2026071501';

function count(source, token) {
  return source.split(token).length - 1;
}

function loadRuntimeWiring(overrides = {}) {
  const start = kvk.indexOf('function noUpdateController()');
  const end = kvk.indexOf('function announceCmd(', start);
  assert.ok(start >= 0 && end > start, 'supported-build wiring block must remain extractable');
  const context = {
    ROOM: 'qa-kvk-update-wiring',
    initialStateSeen: false,
    room: null,
    liveCommands: () => [],
    myTarget: () => ({ anchor: 0, mine: false }),
    window: {
      fetch: async () => ({ ok: true, json: async () => ({}) }),
      location: { href: 'https://example.test/kvk?room=qa-kvk-update-wiring', replace() {} },
      serverNow: () => 1_000_000,
      setInterval() {}
    },
    document: {},
    Promise,
    ...overrides
  };
  vm.runInNewContext(kvk.slice(start, end), context);
  return context;
}

test('browser, server, and first-party asset builds stay identical', async () => {
  const source = fs.readFileSync(path.join(root, 'public', 'kvk-update.js'), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, URL, globalThis: {} });
  const client = await import(`${pathToFileURL(path.join(root, 'src', 'client-build.js')).href}?test=${Date.now()}`);
  assert.equal(module.exports.BUILD, client.CURRENT_KVK_BUILD);
  assert.equal(BUILD, String(client.CURRENT_KVK_BUILD));
});

test('one build generation owns every first-party KvK asset and the blocking gate', () => {
  const assets = [
    `app.css?v=${BUILD}`,
    `kvk-update.js?v=${BUILD}`,
    `app.js?v=${BUILD}`,
    `kvk-delivery-shadow.js?v=${BUILD}`,
    `kvk-rally.js?v=${BUILD}`,
    `kvk.js?v=${BUILD}`
  ];
  for (const asset of assets) assert.equal(count(html, asset), 1, `${asset} must load exactly once`);

  const updater = html.indexOf(`kvk-update.js?v=${BUILD}`);
  const app = html.indexOf(`app.js?v=${BUILD}`);
  const shadow = html.indexOf(`kvk-delivery-shadow.js?v=${BUILD}`);
  const rally = html.indexOf(`kvk-rally.js?v=${BUILD}`);
  const runtime = html.indexOf(`kvk.js?v=${BUILD}`);
  assert.ok(updater >= 0 && updater < app && app < shadow && shadow < rally && rally < runtime);
  assert.match(html, /id="updateGate"[^>]*role="status"[^>]*aria-live="assertive"[^>]*hidden/);
  assert.match(html, /<div[^>]*class="update-card"[^>]*>Updating…<\/div>/);
  assert.doesNotMatch(html, /id="updateGate"[\s\S]{0,200}<button/i);
  assert.match(css, /\.update-gate\{/);
  assert.match(css, /\.update-gate\[hidden\]\{display:none\}/);
});

test('updater wiring defers until canonical personal timing is known and then self-flushes', () => {
  assert.match(kvk, /function noUpdateController\(/);
  assert.match(kvk, /function makeUpdateController\(/);
  assert.match(kvk, /if \(ROOM && \(!initialStateSeen \|\| !syncedOK\)\) return true/,
    'a joined room must not reload before its first current snapshot or fresh clock sync');
  assert.match(kvk, /liveCommands\(room\)\.some\([\s\S]{0,220}myTarget\(command\)[\s\S]{0,160}target\.mine[\s\S]{0,120}target\.anchor > now - 1/);
  assert.match(kvk, /function safeUpdateStart\(/);
  assert.match(kvk, /function safeUpdateCheck\(/);
  assert.match(kvk, /function safeUpdateFlush\(/);
  assert.match(kvk, /sock\.onOpen\s*=\s*function\s*\(\)\s*\{[\s\S]{0,420}safeUpdateCheck\(\)/,
    'every current socket open/reconnect rechecks the minimum build');
  assert.match(kvk, /function onResume\(\)\s*\{[\s\S]{0,180}!sock\.connected[\s\S]{0,100}initialStateSeen = false[\s\S]{0,100}beginClockSync\(\); safeUpdateCheck\(\)/,
    'resume invalidates a silently dead socket and clock before checking the build');
  assert.match(kvk, /function tick\(\)\s*\{[\s\S]{0,180}safeUpdateFlush\(\)/,
    'a naturally completed personal countdown releases a pending update promptly');
  const onState = kvk.slice(kvk.indexOf('function onState('), kvk.indexOf('/* ---------- fill ---------- */'));
  assert.ok(onState.indexOf('room = r;') >= 0 &&
    onState.indexOf('safeUpdateFlush();') > onState.indexOf('room = r;'),
  'state reconciliation evaluates pending updates only after canonical room adoption');
  const bootstrap = kvk.slice(kvk.indexOf('/* ---------- bootstrap'));
  assert.ok(bootstrap.indexOf('safeUpdateStart();') >= 0 &&
    bootstrap.indexOf('safeUpdateStart();') < bootstrap.indexOf('if (!ROOM)') &&
    bootstrap.indexOf('connect();') > bootstrap.indexOf('if (!ROOM)'),
  'a contained updater starts on the join page and before normal room initialization');
  assert.match(kvk, /new window\.RoomSocket\(ROOM, onState, \{ clientBuild: advertisedKvkBuild \}\)/,
    'the socket advertises the build selected by the complete Triple runtime gate');
});

test('partial and throwing updater generations cannot stop the existing KvK runtime', () => {
  const cases = [
    null,
    {},
    { createController: 1 },
    { createController() { throw new Error('mixed cached generation'); } },
    { createController() { return { start() {} }; } },
    { createController() { return {
      start() { throw new Error('start failed'); },
      check() { throw new Error('check failed'); },
      flush() { throw new Error('flush failed'); }
    }; } },
    { createController() { return {
      start() {},
      check() { throw new Error('check failed'); },
      flush() { throw new Error('flush failed'); }
    }; } }
  ];

  for (const api of cases) {
    const context = loadRuntimeWiring({
      window: {
        KvkUpdate: api,
        fetch: async () => ({ ok: true, json: async () => ({}) }),
        location: { href: 'https://example.test/kvk?room=qa-kvk-update-wiring', replace() {} },
        serverNow: () => 1_000_000,
        setInterval() {}
      }
    });
    assert.doesNotThrow(() => context.safeUpdateStart());
    assert.doesNotThrow(() => context.safeUpdateCheck());
    assert.equal(context.safeUpdateFlush(), false);
  }
});

test('runtime deferral is conservative before state and exact to this captain afterward', () => {
  const context = loadRuntimeWiring({
    room: { live: { commands: {} } },
    liveCommands: (room) => room.commands,
    myTarget: (command) => command.target,
    window: {
      fetch: async () => ({ ok: true, json: async () => ({}) }),
      location: { href: 'https://example.test/kvk?room=qa-kvk-update-wiring', replace() {} },
      serverNow: () => 1_000_000,
      setInterval() {}
    }
  });

  assert.equal(context.hasActivePersonalCommandForUpdate(), true,
    'a reconnecting room must preserve a possibly active personal countdown');
  context.initialStateSeen = true;
  context.room = { commands: [] };
  context.syncedOK = false;
  assert.equal(context.hasActivePersonalCommandForUpdate(), true,
    'a resumed device must not trust stale clock offset before synchronization succeeds');
  context.syncedOK = true;
  context.room = { commands: [{ target: { mine: false, anchor: 9_999 } }] };
  assert.equal(context.hasActivePersonalCommandForUpdate(), false,
    'another captain command never blocks this device update');
  context.room = { commands: [{ target: { mine: true, anchor: 999.5 } }] };
  assert.equal(context.hasActivePersonalCommandForUpdate(), true,
    'this captain remains protected through the one-second cue tail');
  context.room = { commands: [{ target: { mine: true, anchor: 998.9 } }] };
  assert.equal(context.hasActivePersonalCommandForUpdate(), false,
    'the update is released immediately after this captain cue tail');
});
