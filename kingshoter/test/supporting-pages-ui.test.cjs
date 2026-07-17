const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Home presents Rally and Defense as equal truthful primary choices', () => {
  const html = read('public/index.html');
  assert.match(html, /<main\b/i);
  assert.match(html, /class="[^"]*coordination-grid[^"]*"/i);
  assert.match(html, /href="\/rally"/i);
  assert.match(html, /href="\/defense"/i);
  assert.doesNotMatch(html, />\s*LIVE\s*</i);
  assert.doesNotMatch(html, /href="[^"]*\/kvk(?:\.html)?(?:[?"#])/i);
  const rally = html.indexOf('href="/rally"');
  const defense = html.indexOf('href="/defense"');
  const codes = html.indexOf('href="/codes"');
  assert.ok(rally >= 0 && defense >= 0 && codes > Math.max(rally, defense));
});

test('supporting pages expose canonical mobile navigation and semantic status', () => {
  for (const file of ['public/codes.html', 'public/guide.html']) {
    const html = read(file);
    assert.match(html, /<main\b/i, `${file} needs main`);
    assert.match(html, /href="\/rally(?:[?"#])/i, `${file} needs Rally navigation`);
    assert.match(html, /href="\/defense(?:[?"#])/i, `${file} needs Defense navigation`);
    assert.doesNotMatch(html, /href="[^"]*\/kvk(?:\.html)?(?:[?"#])/i);
  }
  const codes = read('public/codes.html');
  assert.match(codes, /href="app\.css\?v=2026071701"/);
  assert.match(codes, /src="app\.js\?v=2026071701"/);
  assert.match(codes, /id="codesStatus"[^>]*role="status"[^>]*aria-live="polite"/i);
  assert.match(codes, /id="codeFilter"[^>]*type="search"/i);
  assert.match(codes, /id="retryCodes"[^>]*>.*?<\/button>/is);
  assert.match(codes, /navigator\.clipboard/);
  assert.match(codes, /execCommand\(["']copy["']\)/);
  assert.match(codes, /Promise\.resolve\(navigator\.clipboard\.writeText\(value\)\)\.then/,
    'clipboard rejection must settle through the fallback instead of reporting success synchronously');
  assert.match(codes, /copyCode\(code\)\.then/,
    'copy status must wait for the asynchronous clipboard result');
  assert.doesNotMatch(codes, /var\s+copied\s*=\s*copyCode\(code\)/,
    'a pending clipboard Promise is not a successful copy');

  const events = read('public/events.html');
  assert.match(events, /href="app\.css\?v=2026071701"/);
  assert.match(events, /src="app\.js\?v=2026071701"/);
  assert.match(events, /href="\/rally"/i);
  assert.doesNotMatch(events, /href="[^"]*kvk(?:\.html)?/i);
});

test('Guide reuses the shared battle cast and has stable reduced-motion rendering', () => {
  const html = read('public/guide.html');
  assert.match(html, /window\.ksActor\(/);
  assert.match(html, /window\.ksCastle\(/);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /motionReduced|reduceMotion/);
  assert.match(html, /aria-hidden="true"/i);
  assert.match(html, /href="\/rally"/i);
  assert.match(html, /href="\/defense"/i);
});

test('shared interaction tokens preserve readable mobile controls and accessibility preferences', () => {
  const css = read('public/app.css');
  assert.match(css, /:focus-visible[^}]*outline:/s);
  assert.match(css, /\.supporting-control[^}]*min-height:\s*44px/s);
  assert.match(css, /\.supporting-page[^}]*input[^}]*font-size:\s*16px/s);
  assert.match(css, /prefers-reduced-transparency:\s*reduce/);
  assert.match(css, /prefers-contrast:\s*more/);
  assert.match(css, /\.coordination-grid[^}]*display:\s*grid/s);
});

test('supporting-page browser gate owns an isolated local Wrangler and audits every mobile surface', () => {
  const source = read('test/supporting-pages-ui.e2e.cjs');
  assert.match(source, /async function startIsolatedWrangler\(/,
    'the gate must create its own disposable local server');
  assert.match(source, /wrangler['"],\s*['"]dev['"]/,
    'the disposable server must be Wrangler so Worker and static-asset routing match production');
  assert.match(source, /--persist-to/,
    'the gate must isolate Durable Object state');
  assert.match(source, /async function stopWrangler\(/,
    'the disposable server and state must be cleaned up');
  assert.doesNotMatch(source, /process\.env\.BASE|127\.0\.0\.1:8791/,
    'the gate must never reuse an ambient preview server');
  for (const surface of ["'Home', '/'", "'Guide', '/guide'", "'Codes', '/codes'"]) {
    assert.ok(source.includes(surface), `missing browser gate for ${surface}`);
  }
  assert.match(source, /font-size:\s*200%\s*!important/,
    'each surface must survive 200% text without horizontal overflow');
  assert.match(source, /keyboard\.press\(['"]Tab['"]\)/,
    'the gate must exercise keyboard focus order');
  assert.match(source, /keyboard\.press\(['"]Enter['"]\)/,
    'the gate must activate a supporting-page control from the keyboard');
  assert.match(source, /width\s*<\s*43\.5|width\s*>=\s*44/,
    'the gate must enforce 44px touch targets');
});
