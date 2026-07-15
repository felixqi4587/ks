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
} = require('./support/qa-kvk.cjs');

const ROOT = path.join(__dirname, '..');

function inspectConfig(env = {}, configFile = 'playwright.qa-kvk.config.cjs') {
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
      ALLOW_PRODUCTION_QA: '',
      ...env
    }
  });
}

test('helper and production predicate agree for generated and representative rooms', async () => {
  const { isQaRoomName } = await import(
    pathToFileURL(path.join(ROOT, 'src/delivery.js')).href + '?t=' + Date.now()
  );
  const rejected = [
    'operation-room', 'demo', '_', '', 'qa-kvk-',
    'qa-kvk-bad_', 'QA-KVK-UPPER'
  ];
  for (const room of rejected) {
    assert.equal(isQaRoomName(room), false, room || '<empty>');
    assert.throws(
      () => assertQaRoomName(room),
      error => /^Refusing non-QA KvK room:/.test(error.message),
      room || '<empty>'
    );
  }
  for (const room of ['qa-kvk-a', 'qa-kvk-20260713-7f3a', makeQaRoom('predicate')]) {
    assert.equal(assertQaRoomName(room), room);
    assert.equal(isQaRoomName(room), true);
  }
});

test('guard aborts before route installation for every operation room', async () => {
  for (const room of ['operation-room', 'demo', '_']) {
    let routes = 0;
    const context = { async routeWebSocket() { routes += 1; } };
    await assert.rejects(
      Promise.resolve().then(() => installQaWebSocketGuard(context, room)),
      error => /^Refusing non-QA KvK room:/.test(error.message)
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

test('core browser base accepts only a clean loopback origin', () => {
  for (const value of [
    'http://127.0.0.1:8791', 'http://localhost:8791', 'https://[::1]:8791/'
  ]) assert.equal(localQaBaseURL(value), new URL(value).origin);

  for (const value of [
    'https://kingshoter.com', 'https://example.com',
    'http://127.0.0.1:8791/path', 'http://127.0.0.1:8791/?room=qa-kvk-a',
    'http://user:pass@127.0.0.1:8791', 'ftp://127.0.0.1:8791', 'not-a-url'
  ]) assert.throws(() => localQaBaseURL(value), /local QA origin/i, value);

  const core = fs.readFileSync(path.join(ROOT, 'test', 'kvk-core-multibrowser.e2e.cjs'), 'utf8');
  assert.match(core, /const base = localQaBaseURL\(process\.env\.BASE \|\| ['"]http:\/\/127\.0\.0\.1:8791['"]\)/);
  assert.match(core, /installQaWebSocketGuard\(context, room, \{[\s\S]{0,120}expectedOrigin: base/);
});

test('generated rooms and URLs are unique, bounded, and use both exact shadow gates', () => {
  const input = { title: 'reliable shadow topology' };
  const a = makeQaRoom(input);
  const b = makeQaRoom(input);
  assert.notEqual(a, b);
  for (const room of [a, b]) {
    assert.equal(assertQaRoomName(room), room);
    assert.ok(room.length <= 48);
    const url = new URL(qaRoomUrl('http://127.0.0.1:8799', room, {
      deliveryQa: '1',
      deliveryShadow: '1'
    }));
    assert.equal(url.origin, 'http://127.0.0.1:8799');
    assert.equal(url.pathname, '/kvk.html');
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

test('delivery sources have no direct named-room equality or literal membership branch', () => {
  const roomExpression = String.raw`(?:\b(?:room|roomName|ROOM)\b|String\(\s*(?:room|roomName|ROOM)\s*\))`;
  const namedRoomBranches = [
    new RegExp(String.raw`(?<!typeof\s)${roomExpression}\s*={2,3}\s*['"][A-Za-z0-9_-]+['"]`),
    new RegExp(String.raw`['"][A-Za-z0-9_-]+['"]\s*={2,3}\s*${roomExpression}`),
    new RegExp(String.raw`\[[^\]\n]{0,200}['"][A-Za-z0-9_-]+['"][^\]\n]{0,200}\]\.includes\(\s*${roomExpression}`)
  ];
  for (const file of [
    'src/delivery.js',
    'src/room.js',
    'public/kvk-delivery-shadow.js',
    'public/kvk.js'
  ]) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const pattern of namedRoomBranches) assert.doesNotMatch(source, pattern, file);
  }
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

  const unknown = inspectConfig({ QA_BASE_URL: 'https://kingshoter.com.evil.example' });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unapproved_qa_origin/);

  const production = inspectConfig({ QA_BASE_URL: 'https://kingshoter.com:443' });
  assert.notEqual(production.status, 0);
  assert.match(production.stderr, /production_qa_requires_ALLOW_PRODUCTION_QA_1/);

  const wrongPort = inspectConfig({
    QA_BASE_URL: 'https://kingshoter.com:444',
    ALLOW_PRODUCTION_QA: '1'
  });
  assert.notEqual(wrongPort.status, 0);
  assert.match(wrongPort.stderr, /unapproved_qa_origin/);

  const explicitlyAllowed = inspectConfig({
    QA_BASE_URL: 'https://kingshoter.com:443',
    ALLOW_PRODUCTION_QA: '1'
  });
  assert.equal(explicitlyAllowed.status, 0, explicitlyAllowed.stderr);
  const allowedConfig = JSON.parse(explicitlyAllowed.stdout);
  assert.equal(allowedConfig.baseURL, 'https://kingshoter.com');
  assert.equal(allowedConfig.hasWebServer, false);
});

test('Triple Playwright config gates loopback and the exact production origin', () => {
  const configFile = 'playwright.qa-kvk-triple.config.cjs';
  const local = inspectConfig({}, configFile);
  assert.equal(local.status, 0, local.stderr);
  const config = JSON.parse(local.stdout);
  assert.equal(config.baseURL, 'http://127.0.0.1:8799');
  assert.equal(config.webServer.url, 'http://127.0.0.1:8799/api/time');
  assert.equal(config.webServer.reuseExistingServer, false);
  assert.match(config.webServer.command, /wrangler dev --local --ip 127\.0\.0\.1 --port 8799/);
  assert.match(config.webServer.command, /--var TRIPLE_RALLY_ENABLED:0/);
  assert.match(config.webServer.command, /--var TRIPLE_RALLY_QA_ENABLED:1/);

  const loopback = inspectConfig({ QA_BASE_URL: 'http://127.0.0.1:8791' }, configFile);
  assert.equal(loopback.status, 0, loopback.stderr);
  assert.equal(JSON.parse(loopback.stdout).hasWebServer, false);

  const unknown = inspectConfig({
    QA_BASE_URL: 'https://example.com', ALLOW_PRODUCTION_QA: '1'
  }, configFile);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unapproved_qa_origin/);

  const production = inspectConfig({ QA_BASE_URL: 'https://kingshoter.com' }, configFile);
  assert.notEqual(production.status, 0);
  assert.match(production.stderr, /production_qa_requires_ALLOW_PRODUCTION_QA_1/);

  const allowed = inspectConfig({
    QA_BASE_URL: 'https://kingshoter.com', ALLOW_PRODUCTION_QA: '1'
  }, configFile);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(JSON.parse(allowed.stdout).baseURL, 'https://kingshoter.com');

  for (const candidate of [
    'https://kingshoter.com:444', 'https://kingshoter.com/path',
    'https://kingshoter.com/?query=1', 'https://user:pass@kingshoter.com'
  ]) {
    const rejected = inspectConfig({ QA_BASE_URL: candidate, ALLOW_PRODUCTION_QA: '1' }, configFile);
    assert.notEqual(rejected.status, 0, candidate);
    assert.match(rejected.stderr, /unapproved_qa_origin/, candidate);
  }
});

test('focused delivery scripts are additive and retain every existing command', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test test/*.test.cjs');
  assert.equal(pkg.scripts['test:kvk-core'], 'node test/kvk-core-multibrowser.e2e.cjs --project=chromium');
  assert.equal(pkg.scripts['test:kvk-core:all'], 'node test/kvk-core-multibrowser.e2e.cjs --project=all');
  assert.equal(pkg.scripts.deploy, 'wrangler deploy');
  assert.equal(pkg.scripts.dev, 'wrangler dev');
  assert.equal(pkg.scripts['test:delivery'], [
    'node --test',
    'test/delivery-model.test.cjs',
    'test/room-delivery.test.cjs',
    'test/reliable-room-delivery.test.cjs',
    'test/delivery-shadow-client.test.cjs',
    'test/delivery-browser-wiring.test.cjs',
    'test/qa-kvk-delivery-guard.test.cjs'
  ].join(' '));
  assert.equal(pkg.scripts['test:qa:delivery'],
    'playwright test -c playwright.qa-kvk.config.cjs');
  assert.equal(pkg.scripts['test:qa:delivery:chromium'],
    'playwright test -c playwright.qa-kvk.config.cjs --project=chromium');
  assert.match(pkg.scripts['test:triple'], /test\/qa-kvk-delivery-guard\.test\.cjs/,
    'the focused Triple gate must exercise its remote-origin guard');
  assert.match(pkg.scripts['test:triple'], /test\/legacy-kvk-script-guard\.test\.cjs/,
    'the focused Triple gate must keep retained production scripts disabled');
});
