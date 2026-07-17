const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const wrangler = require('node:fs').readFileSync(path.join(__dirname, '../wrangler.toml'), 'utf8');

async function loadWorker() {
  const url = pathToFileURL(path.join(__dirname, '..', 'src', 'worker.js'));
  url.searchParams.set('testRun', `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

test('GET /api/build returns uncached build metadata and does not reach other routes', async () => {
  const { default: worker } = await loadWorker();
  const response = await worker.fetch(new Request('https://example.test/api/build?room=qa-kvk-forged&TRIPLE_RALLY_ENABLED=1'), {
    TRIPLE_RALLY_ENABLED: '0',
    TRIPLE_RALLY_QA_ENABLED: '1',
    ASSETS: { fetch() { throw new Error('assets route must not run'); } },
    ROOM: { idFromName() { throw new Error('room route must not run'); } }
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await response.json(), {
    currentBuild: 2026071701,
    minKvkBuild: 2026071701,
    minRallyBuild: 2026071701,
    minDefenseBuild: 2026071701,
    minTripleBuild: 2026071701,
    tripleEnabled: false,
    tripleQaEnabled: true
  });
});

test('GET /api/build enables gates only for the exact string value 1', async () => {
  const { default: worker } = await loadWorker();
  const enabled = await worker.fetch(new Request('https://example.test/api/build'), {
    TRIPLE_RALLY_ENABLED: '1',
    TRIPLE_RALLY_QA_ENABLED: '1'
  });
  const malformed = await worker.fetch(new Request('https://example.test/api/build'), {
    TRIPLE_RALLY_ENABLED: true,
    TRIPLE_RALLY_QA_ENABLED: 'true'
  });

  assert.deepEqual(await enabled.json(), {
    currentBuild: 2026071701,
    minKvkBuild: 2026071701,
    minRallyBuild: 2026071701,
    minDefenseBuild: 2026071701,
    minTripleBuild: 2026071701,
    tripleEnabled: true,
    tripleQaEnabled: true
  });
  assert.deepEqual(await malformed.json(), {
    currentBuild: 2026071701,
    minKvkBuild: 2026071701,
    minRallyBuild: 2026071701,
    minDefenseBuild: 2026071701,
    minTripleBuild: 2026071701,
    tripleEnabled: false,
    tripleQaEnabled: false
  });
});

test('platform gates do not capture the top-level custom-domain routes as vars', () => {
  const routes = wrangler.indexOf('\nroutes = [');
  const vars = wrangler.indexOf('\n[vars]');
  const assets = wrangler.indexOf('\n[assets]');
  assert.ok(routes >= 0 && vars > routes && assets > vars,
    'routes must remain top-level, with [vars] introduced only after its array closes');
});

test('production enables Triple for every room', () => {
  assert.match(wrangler, /^TRIPLE_RALLY_ENABLED = "1"$/m);
});

test('production routes every canonical and legacy coordination path through the Worker', () => {
  assert.doesNotMatch(wrangler, /^html_handling\s*=/m,
    'default asset HTML handling must preserve homepage and extensionless static routes');
  assert.match(wrangler, /^run_worker_first = \["\/rally", "\/defense", "\/kvk", "\/kvk\.html"\]$/m);
});
