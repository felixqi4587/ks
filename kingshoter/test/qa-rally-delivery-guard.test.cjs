const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const {
  assertQaRoomName,
  makeQaRoom,
  qaRoomUrl,
  installQaWebSocketGuard,
  localQaBaseURL
} = require('./support/qa-coordination.cjs');

const ROOT = path.join(__dirname, '..');

function inspectConfig(env = {}, configFile = 'playwright.qa-rally-defense.config.cjs') {
  const script = [
    `const config = require(${JSON.stringify(`./${configFile}`)});`,
    'process.stdout.write(JSON.stringify({',
    '  baseURL: config.use.baseURL, webServer: config.webServer,',
    '  projects: config.projects.map(project => ({',
    '    name: project.name, browserType: project.use.defaultBrowserType',
    '  })),',
    '  hasWebServer: config.webServer !== undefined,',
    '  workers: config.workers, timeout: config.timeout, outputDir: config.outputDir',
    '}));'
  ].join('\n');
  return spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      QA_BASE_URL: '',
      QA_REMOTE_ORIGIN: '',
      ALLOW_REMOTE_QA: '',
      ...env
    }
  });
}

test('helper and production predicate accept only the fixed qa room', async () => {
  const { isQaRoomName } = await import(
    pathToFileURL(path.join(ROOT, 'src/delivery.js')).href + '?t=' + Date.now()
  );
  const rejected = [
    'operation-room', 'demo', '_', '', 'qa-kvk-a', 'QA', 'qa '
  ];
  for (const room of rejected) {
    assert.equal(isQaRoomName(room), false, room || '<empty>');
    assert.throws(
      () => assertQaRoomName(room),
      error => /^Refusing non-QA coordination room:/.test(error.message),
      room || '<empty>'
    );
  }
  assert.equal(makeQaRoom('predicate'), 'qa');
  assert.equal(assertQaRoomName('qa'), 'qa');
  assert.equal(isQaRoomName('qa'), true);
});

test('guard aborts before route installation for every operation room', async () => {
  for (const room of ['operation-room', 'demo', '_']) {
    let routes = 0;
    const context = { async routeWebSocket() { routes += 1; } };
    await assert.rejects(
      Promise.resolve().then(() => installQaWebSocketGuard(context, room)),
      error => /^Refusing non-QA coordination room:/.test(error.message)
    );
    assert.equal(routes, 0, room);
  }
});

test('guard rejects the wrong WebSocket origin before connecting upstream', async () => {
  const room = makeQaRoom('origin-guard');
  let handler = null;
  let connected = 0;
  const context = {
    async routeWebSocket(_pattern, callback) { handler = callback; }
  };
  await installQaWebSocketGuard(context, room, {
    expectedOrigin: 'http://127.0.0.1:8799'
  });
  const route = url => ({
    url() { return url; },
    connectToServer() {
      connected += 1;
      return { send() {}, onMessage() {} };
    },
    send() {},
    onMessage() {}
  });
  assert.throws(
    () => handler(route(`wss://kingshoter.com/api/ws?room=${room}`)),
    /WebSocket origin/i
  );
  assert.equal(connected, 0);
  assert.doesNotThrow(
    () => handler(route(`ws://127.0.0.1:8799/api/ws?room=${room}`))
  );
  assert.equal(connected, 1);
});

test('core browser gate owns an isolated local Wrangler unless a clean loopback base is explicit', () => {
  for (const value of [
    'http://127.0.0.1:8791', 'http://localhost:8791', 'https://[::1]:8791/'
  ]) assert.equal(localQaBaseURL(value), new URL(value).origin);

  for (const value of [
    'https://kingshoter.com', 'https://example.com',
    'http://127.0.0.1:8791/path', 'http://127.0.0.1:8791/?room=qa',
    'http://user:pass@127.0.0.1:8791', 'ftp://127.0.0.1:8791', 'not-a-url'
  ]) assert.throws(() => localQaBaseURL(value), /local QA origin/i, value);

  const core = fs.readFileSync(path.join(ROOT, 'test', 'rally-core-multibrowser.e2e.cjs'), 'utf8');
  assert.match(core, /process\.env\.BASE\s*\?\s*localQaBaseURL\(process\.env\.BASE\)\s*:\s*null/,
    'an explicit reusable server is still restricted to a clean loopback origin');
  assert.match(core, /async function startIsolatedWrangler\(/,
    'the release gate must create its own disposable local server by default');
  assert.match(core, /wrangler['"],\s*['"]dev['"]/,
    'the disposable server must use Wrangler so Worker and asset routing match production');
  assert.match(core, /listen\(0,\s*['"]127\.0\.0\.1['"]/,
    'the disposable server must reserve a random loopback port');
  assert.match(core, /--persist-to/,
    'the release gate must isolate Durable Object state');
  assert.match(core, /async function stopWrangler\(/,
    'the release gate must stop its server and delete disposable state');
  assert.match(core, /async function installLocalOnlyRoutes\(/,
    'every browser context must block external and production HTTP requests');
  assert.doesNotMatch(core, /process\.env\.BASE\s*\|\||127\.0\.0\.1:8791/,
    'the default release gate must not depend on an ambient preview server');
  assert.match(core, /installQaWebSocketGuard\(context, room, \{[\s\S]{0,120}expectedOrigin: base/);
});

test('QA URLs always use the fixed room and canonical Rally route', () => {
  const input = { title: 'reliable shadow topology' };
  const a = makeQaRoom(input);
  const b = makeQaRoom(input);
  assert.equal(a, 'qa');
  assert.equal(b, 'qa');
  for (const room of [a, b]) {
    assert.equal(assertQaRoomName(room), room);
    const url = new URL(qaRoomUrl('http://127.0.0.1:8799', room, {
      deliveryQa: '1',
      deliveryShadow: '1'
    }));
    assert.equal(url.origin, 'http://127.0.0.1:8799');
    assert.equal(url.pathname, '/rally');
    assert.equal(url.searchParams.getAll('room').length, 1);
    assert.equal(url.searchParams.get('room'), room);
    assert.deepEqual(url.searchParams.getAll('deliveryQa'), ['1']);
    assert.deepEqual(url.searchParams.getAll('deliveryShadow'), ['1']);
  }
  assert.throws(
    () => qaRoomUrl('http://127.0.0.1:8799', a, { room: 'operation-room' }),
    /room override/i
  );
});

test('delivery predicates use only the explicit qa room and Rally-named assets', () => {
  for (const file of [
    'src/delivery.js',
    'src/room.js',
    'public/rally-delivery-shadow.js',
    'public/rally-controller.js'
  ]) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(source, /qa-kvk-/i, file);
  }
  assert.match(fs.readFileSync(path.join(ROOT, 'src/delivery.js'), 'utf8'), /return room === ['"]qa['"]/);
  assert.match(fs.readFileSync(path.join(ROOT, 'public/rally-delivery-shadow.js'), 'utf8'), /return room === ['"]qa['"]/);
});

test('Playwright config defaults to isolated loopback and gates every remote origin', () => {
  const local = inspectConfig();
  assert.equal(local.status, 0, local.stderr);
  const config = JSON.parse(local.stdout);
  assert.equal(config.baseURL, 'http://127.0.0.1:8799');
  assert.equal(config.webServer.url, 'http://127.0.0.1:8799/api/time');
  assert.equal(config.webServer.reuseExistingServer, false);
  assert.match(config.webServer.command, /wrangler dev --local --ip 127\.0\.0\.1 --port 8799/);
  assert.match(config.webServer.command, /--persist-to/);
  assert.deepEqual(config.projects, [
    { name: 'chromium', browserType: 'chromium' },
    { name: 'firefox', browserType: 'firefox' },
    { name: 'webkit', browserType: 'webkit' }
  ]);
  assert.equal(config.hasWebServer, true);
  assert.equal(config.workers, 1);
  assert.equal(config.timeout, 90_000);
  assert.ok(config.outputDir.startsWith(os.tmpdir()));

  const unknown = inspectConfig({ QA_BASE_URL: 'https://qa.example.test' });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /remote_qa_requires_ALLOW_REMOTE_QA_1/);

  const production = inspectConfig({
    QA_BASE_URL: 'https://kingshoter.com',
    QA_REMOTE_ORIGIN: 'https://kingshoter.com',
    ALLOW_REMOTE_QA: '1'
  });
  assert.notEqual(production.status, 0);
  assert.match(production.stderr, /production_origin_is_not_qa/);

  const wrongOrigin = inspectConfig({
    QA_BASE_URL: 'https://qa.example.test',
    QA_REMOTE_ORIGIN: 'https://other.example.test',
    ALLOW_REMOTE_QA: '1'
  });
  assert.notEqual(wrongOrigin.status, 0);
  assert.match(wrongOrigin.stderr, /unapproved_qa_origin/);

  for (const origin of [
    'https://kingshoter.kingshot1406.workers.dev',
    'https://qa.example.test'
  ]) {
    const explicitlyRejected = inspectConfig({
      QA_BASE_URL: origin,
      QA_REMOTE_ORIGIN: origin,
      ALLOW_REMOTE_QA: '1'
    });
    assert.notEqual(explicitlyRejected.status, 0, origin);
    assert.match(explicitlyRejected.stderr, /unapproved_qa_origin/, origin);
  }

  const explicitlyAllowed = inspectConfig({
    QA_BASE_URL: 'https://kingshoter-qa.kingshot1406.workers.dev',
    QA_REMOTE_ORIGIN: 'https://kingshoter-qa.kingshot1406.workers.dev',
    ALLOW_REMOTE_QA: '1'
  });
  assert.equal(explicitlyAllowed.status, 0, explicitlyAllowed.stderr);
  const allowedConfig = JSON.parse(explicitlyAllowed.stdout);
  assert.equal(allowedConfig.baseURL, 'https://kingshoter-qa.kingshot1406.workers.dev');
  assert.equal(allowedConfig.hasWebServer, false);

  const explicitLoopback = inspectConfig({ QA_BASE_URL: 'http://localhost:8799' });
  assert.equal(explicitLoopback.status, 0, explicitLoopback.stderr);
  assert.equal(JSON.parse(explicitLoopback.stdout).baseURL, 'http://localhost:8799');
});

test('one serialized Playwright config covers Rally delivery, Triple, and Defense', () => {
  const source = fs.readFileSync(path.join(ROOT, 'playwright.qa-rally-defense.config.cjs'), 'utf8');
  assert.match(source, /qa-rally-\(\?:defense\|delivery\|triple\)/);
  assert.match(source, /--var TRIPLE_RALLY_ENABLED:0/);
  assert.match(source, /--var TRIPLE_RALLY_QA_ENABLED:1/);
  assert.match(source, /fullyParallel: false/);
  assert.match(source, /workers: 1/);
});

test('focused delivery scripts retain runnable existing commands and one-release Rally aliases', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test test/*.test.cjs');
  assert.equal(pkg.scripts['test:rally-core'], 'node test/rally-core-multibrowser.e2e.cjs --project=chromium');
  assert.equal(pkg.scripts['test:rally-core:all'], 'node test/rally-core-multibrowser.e2e.cjs --project=all');
  assert.equal(pkg.scripts['test:kvk-core'], 'npm run test:rally-core');
  assert.equal(pkg.scripts['test:kvk-core:all'], 'npm run test:rally-core:all');
  assert.equal(fs.existsSync(path.join(ROOT, 'test/rally-core-multibrowser.e2e.cjs')), true);
  assert.equal(pkg.scripts['test:rally-defense:browser'],
    'node test/supporting-pages-ui.e2e.cjs && node test/rally-defense-isolation.e2e.cjs && node test/defense-multibrowser.e2e.cjs && node test/coordination-accessibility.e2e.cjs');
  assert.equal(pkg.scripts['test:load:defense'], 'node test/defense-load.e2e.mjs');
  assert.equal(pkg.scripts['test:qa:rally-defense'],
    'playwright test -c playwright.qa-rally-defense.config.cjs');
  assert.equal(pkg.scripts.deploy, 'wrangler deploy');
  assert.equal(pkg.scripts.dev, 'wrangler dev');
  assert.equal(pkg.scripts['test:delivery'], [
    'node --test',
    'test/delivery-model.test.cjs',
    'test/room-delivery.test.cjs',
    'test/reliable-room-delivery.test.cjs',
    'test/delivery-shadow-client.test.cjs',
    'test/delivery-browser-wiring.test.cjs',
    'test/qa-rally-delivery-guard.test.cjs'
  ].join(' '));
  assert.match(pkg.scripts['test:triple'], /test\/qa-rally-delivery-guard\.test\.cjs/,
    'the focused Triple gate must exercise its remote-origin guard');
  assert.match(pkg.scripts['test:triple'], /test\/legacy-kvk-script-guard\.test\.cjs/,
    'the focused Triple gate must keep retained production scripts disabled');
});
