const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

async function loadWorker() {
  const url = pathToFileURL(path.join(__dirname, '..', 'src', 'worker.js'));
  url.searchParams.set('testRun', `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

function assetsHarness() {
  const requests = [];
  return {
    requests,
    env: {
      ASSETS: {
        async fetch(request) {
          requests.push(request);
          return new Response(`asset:${new URL(request.url).pathname}`, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        }
      }
    }
  };
}

test('GET and HEAD canonical coordination routes preserve extensionless URLs for Assets HTML handling', async () => {
  const { default: worker } = await loadWorker();
  for (const route of ['/rally', '/defense']) {
    for (const method of ['GET', 'HEAD']) {
      const harness = assetsHarness();
      const response = await worker.fetch(new Request(`https://example.test${route}?room=qa&lang=en&notour=1`, { method }), harness.env);
      assert.equal(response.status, 200, `${method} ${route}`);
      assert.equal(harness.requests.length, 1);
      assert.equal(new URL(harness.requests[0].url).pathname, route);
      assert.equal(new URL(harness.requests[0].url).search, '?room=qa&lang=en&notour=1');
      assert.equal(harness.requests[0].method, method);
      if (method === 'HEAD') assert.equal(await response.text(), '');
    }
  }
});

test('legacy KvK routes redirect to Rally with only one validated value per whitelisted key', async () => {
  const { default: worker } = await loadWorker();
  for (const route of ['/kvk', '/kvk.html']) {
    const harness = assetsHarness();
    const response = await worker.fetch(new Request(
      `https://example.test${route}?room=qa&lang=en&notour=1&__kvk_build=2026071603&junk=x#command`
    ), harness.env);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/rally?room=qa&lang=en&notour=1&__rally_build=2026071603');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(harness.requests.length, 0, 'legacy routes must never render the legacy asset');
  }

  const duplicates = await worker.fetch(new Request(
    'https://example.test/kvk?room=qa&room=other&lang=en&lang=zh&notour=1&notour=0&__kvk_build=1&__kvk_build=2&next=https://evil.test'
  ), assetsHarness().env);
  assert.equal(duplicates.headers.get('location'), '/rally',
    'ambiguous duplicate and unknown parameters are dropped, never chosen by position');
});

test('legacy redirect rejects unsafe values and HEAD returns the same no-store location without a body', async () => {
  const { default: worker } = await loadWorker();
  const response = await worker.fetch(new Request(
    'https://example.test/kvk?room=qa%2Fevil&lang=fr&notour=true&__kvk_build=1.5',
    { method: 'HEAD' }
  ), assetsHarness().env);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/rally');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), '');
});

test('coordination routes reject unsupported methods with 405 before assets execute', async () => {
  const { default: worker } = await loadWorker();
  for (const route of ['/rally', '/defense', '/kvk', '/kvk.html']) {
    const harness = assetsHarness();
    const response = await worker.fetch(new Request(`https://example.test${route}`, { method: 'POST' }), harness.env);
    assert.equal(response.status, 405, route);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(harness.requests.length, 0);
  }
});

test('homepage exposes equal-level Rally and Defense room entries with localized truthful copy', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  assert.match(html, /href="\/rally"/);
  assert.match(html, /href="\/defense"/);
  assert.match(html, /data-i18n="card_rally"/);
  assert.match(html, /data-i18n="card_defense"/);
  assert.match(app, /card_rally:\s*"Rally Coordination"/);
  assert.match(app, /card_defense:\s*"Defense Coordination"/);
  assert.match(app, /集结协调/);
  assert.match(app, /防守协调/);
  assert.doesNotMatch(html, /href="(?:\/)?kvk(?:\.html)?"/);
});

test('Rally join and resume actions generate canonical Rally room URLs directly', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public/kvk.js'), 'utf8');
  assert.match(source, /location\.href = "\/rally\?room=" \+ encodeURIComponent\(lr\.room\)/);
  assert.match(source, /location\.href = "\/rally\?room=" \+ encodeURIComponent\(r\)/);
  assert.doesNotMatch(source, /location\.href = "kvk\.html\?room="/);
});

test('package exposes only runnable Rally-named gates while keeping one-release KvK aliases unconditional', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.scripts['test:rally-core'], 'node test/kvk-core-multibrowser.e2e.cjs --project=chromium');
  assert.equal(pkg.scripts['test:rally-core:all'], 'node test/kvk-core-multibrowser.e2e.cjs --project=all');
  assert.equal(pkg.scripts['test:kvk-core'], 'npm run test:rally-core');
  assert.equal(pkg.scripts['test:kvk-core:all'], 'npm run test:rally-core:all');
  assert.equal(pkg.scripts['test:rally-defense'],
    'node --test test/rally-*.test.cjs test/defense-*.test.cjs test/coordination-*.test.cjs');
  assert.equal(pkg.scripts['test:load:defense'], undefined);
  assert.equal(pkg.scripts['test:qa:rally-defense'], undefined);
  assert.equal(fs.existsSync(path.join(__dirname, 'kvk-core-multibrowser.e2e.cjs')), true);
  for (const prefix of ['rally-', 'defense-', 'coordination-']) {
    assert.equal(fs.readdirSync(__dirname).some(name => name.startsWith(prefix) && name.endsWith('.test.cjs')), true);
  }
});
