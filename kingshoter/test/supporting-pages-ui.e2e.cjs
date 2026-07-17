const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const widths = [320, 375, 390, 430];
const surfaces = [['Home', '/'], ['Guide', '/guide'], ['Codes', '/codes']];

const gsapProbe = `
  window.__guideGsap = { created: 0, killed: 0 };
  (function () {
    function each(target, fn) {
      if (Array.isArray(target) || (target && typeof target.length === 'number' && !target.nodeType)) {
        Array.prototype.forEach.call(target, fn);
      } else if (target) fn(target);
    }
    function apply(target, vars) {
      vars = vars || {};
      each(target, function (element) {
        if (!element || !element.setAttribute) return;
        if (vars.attr) Object.keys(vars.attr).forEach(function (key) { element.setAttribute(key, vars.attr[key]); });
        if (Number.isFinite(vars.x) || Number.isFinite(vars.y)) {
          var x = Number.isFinite(vars.x) ? vars.x : Number(element._sx || 0);
          var y = Number.isFinite(vars.y) ? vars.y : Number(element._sy || 0);
          element.setAttribute('transform', 'translate(' + x + ',' + y + ')');
        }
        if (vars.opacity != null) element.setAttribute('opacity', vars.opacity);
      });
    }
    window.gsap = {
      set: function (target, vars) { apply(target, vars); return target; },
      timeline: function () {
        window.__guideGsap.created += 1;
        var killed = false;
        var chain = {
          set: function (target, vars) { apply(target, vars); return chain; },
          to: function () { return chain; },
          call: function (fn) { if (typeof fn === 'function') fn(); return chain; },
          play: function () { return chain; },
          pause: function () { return chain; },
          kill: function () { if (!killed) { killed = true; window.__guideGsap.killed += 1; } return chain; }
        };
        return chain;
      }
    };
  })();
`;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.unref();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const port = socket.address().port;
      socket.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function startIsolatedWrangler() {
  const port = await freePort();
  const statePath = fs.mkdtempSync(path.join(os.tmpdir(), 'kingshoter-supporting-pages-'));
  const child = spawn('npx', [
    'wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port),
    '--persist-to', statePath, '--var', 'TRIPLE_RALLY_ENABLED:0',
    '--var', 'TRIPLE_RALLY_QA_ENABLED:1', '--log-level', 'warn'
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  const collect = chunk => { logs = (logs + String(chunk)).slice(-12_000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const baseURL = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`isolated Wrangler exited ${child.exitCode}\n${logs}`);
    try {
      const response = await fetch(`${baseURL}/api/time`);
      if (response.ok) return { child, statePath, baseURL, logs: () => logs };
    } catch (_) {}
    await delay(200);
  }
  child.kill('SIGTERM');
  throw new Error(`isolated Wrangler did not start\n${logs}`);
}

async function stopWrangler(server) {
  if (!server) return;
  if (server.child.exitCode == null) {
    server.child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => server.child.once('exit', resolve)),
      delay(3_000)
    ]);
    if (server.child.exitCode == null) server.child.kill('SIGKILL');
  }
  fs.rmSync(server.statePath, { recursive: true, force: true });
}

async function installLocalOnlyRoutes(context, baseURL) {
  const localOrigin = new URL(baseURL).origin;
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.href.startsWith('https://cdnjs.cloudflare.com/ajax/libs/gsap/')) {
      return route.fulfill({ status: 200, contentType: 'application/javascript', body: gsapProbe });
    }
    if (url.origin !== localOrigin) return route.abort('blockedbyclient');
    return route.continue();
  });
}

async function openSurface(browser, baseURL, surface, options = {}) {
  const context = await browser.newContext({
    viewport: { width: options.width || 390, height: options.height || 1000 },
    locale: 'en-US',
    hasTouch: true,
    reducedMotion: options.reducedMotion || 'no-preference'
  });
  await installLocalOnlyRoutes(context, baseURL);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const pathName = surfaces.find(item => item[0] === surface)[1];
  await page.goto(`${baseURL}${pathName}`, { waitUntil: 'domcontentloaded' });
  await page.locator('main').waitFor();
  if (surface === 'Guide') await page.waitForFunction(() => document.querySelectorAll('.term').length === 6);
  if (surface === 'Codes') {
    await page.waitForFunction(() => typeof window.renderCodes === 'function');
    await page.evaluate(() => { window.CODES = ['QA-CODE']; window.CODES_ERR = false; window.renderCodes(); });
    await page.locator('.code button').waitFor();
  }
  return { context, page, errors };
}

async function assertNoHorizontalOverflow(page, label) {
  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    bodyWidth: document.body.getBoundingClientRect().width
  }));
  assert.ok(layout.scrollWidth <= layout.clientWidth + 1,
    `${label} must reflow without horizontal scrolling: ${JSON.stringify(layout)}`);
}

async function assertTouchTargets(page, surface, width) {
  const selectors = {
    Home: '.supporting-control, #langtoggle button',
    Guide: '.supporting-nav a, .guide-actions a, #langtoggle button',
    Codes: '.supporting-nav a, #langtoggle button, #codeFilter, .code button'
  };
  const targets = await page.locator(selectors[surface]).evaluateAll(elements => elements
    .filter(element => {
      const style = getComputedStyle(element), rect = element.getBoundingClientRect();
      return !element.hidden && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    })
    .map(element => {
      const rect = element.getBoundingClientRect();
      return { text: element.textContent.trim(), id: element.id, width: rect.width, height: rect.height };
    }));
  assert.ok(targets.length > 0, `${surface} at ${width}px must expose critical controls`);
  const undersized = targets.filter(target => target.width < 43.5 || target.height < 43.5);
  assert.deepEqual(undersized, [],
    `${surface} at ${width}px keeps critical controls at least 44×44: ${JSON.stringify(undersized)}`);
}

async function assertKeyboardOperation(page, surface) {
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
  });
  await page.keyboard.press('Tab');
  const tabFocus = await page.evaluate(() => {
    const element = document.activeElement;
    const rect = element.getBoundingClientRect();
    return { tag: element.tagName, width: rect.width, height: rect.height };
  });
  assert.match(tabFocus.tag, /^(A|BUTTON|INPUT)$/,
    `${surface} Tab must enter a visible interactive control, got ${JSON.stringify(tabFocus)}`);
  assert.ok(tabFocus.width > 0 && tabFocus.height > 0,
    `${surface} Tab focus must remain visible`);

  const activationTargets = {
    Home: 'a[href="/rally"]',
    Guide: '.guide-actions a[href="/rally"]',
    Codes: '.supporting-nav a[href="/rally"]'
  };
  await page.locator(activationTargets[surface]).evaluate(element => {
    window.__supportingKeyboardActivations = 0;
    element.addEventListener('click', event => {
      event.preventDefault();
      window.__supportingKeyboardActivations += 1;
    }, { capture: true, once: true });
    element.focus();
  });
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.__supportingKeyboardActivations), 1,
    `${surface} primary navigation must activate with Enter`);
}

async function enlargeText(page) {
  await page.addStyleTag({ content: `
    :where(h1,h2,p,a,button,input,label,.hint,.tag,.sub,.clock,.term .def,.term .cap,.codes-note,.supporting-status) {
      font-size: 200% !important;
      line-height: 1.5 !important;
      overflow-wrap: anywhere !important;
      min-width: 0 !important;
    }
  ` });
}

(async () => {
  let server = null;
  let browser = null;
  try {
    server = await startIsolatedWrangler();
    browser = await chromium.launch({ headless: true });

    for (const width of widths) {
      for (const [surface] of surfaces) {
        const view = await openSurface(browser, server.baseURL, surface, { width });
        await assertNoHorizontalOverflow(view.page, `${surface} at ${width}px`);
        await assertTouchTargets(view.page, surface, width);
        await assertKeyboardOperation(view.page, surface);
        assert.equal(view.errors.length, 0, `${surface} at ${width}px has no page errors: ${view.errors.join(' | ')}`);
        await view.context.close();
      }
    }

    for (const [surface] of surfaces) {
      const enlarged = await openSurface(browser, server.baseURL, surface, { width: 320 });
      await enlargeText(enlarged.page);
      await assertNoHorizontalOverflow(enlarged.page, `${surface} with 200% text`);
      assert.equal(enlarged.errors.length, 0,
        `${surface} with 200% text has no page errors: ${enlarged.errors.join(' | ')}`);
      await enlarged.context.close();
    }

    const regular = await openSurface(browser, server.baseURL, 'Guide');
    const page = regular.page;
    assert.deepEqual(await page.locator('.guide-actions a').evaluateAll(links => links.map(link => link.getAttribute('href'))),
      ['/rally', '/defense'], 'Guide offers equal canonical Rally and Defense actions');
    assert.equal(await page.locator('svg:not([aria-hidden="true"])').count(), 0,
      'all decorative Guide SVGs are hidden from assistive technology');
    assert.equal(await page.locator('.term .def').count(), 6,
      'every illustration keeps its explanation as readable HTML');
    await page.waitForFunction(() => window.__guideGsap && window.__guideGsap.created > 0);
    const beforeReduce = await page.evaluate(() => ({ ...window.__guideGsap }));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(expected =>
      document.querySelectorAll('.term[data-motion="static"]').length === expected,
    await page.locator('.term').count());
    await page.waitForTimeout(100);
    const afterReduce = await page.evaluate(() => ({ ...window.__guideGsap }));
    assert.equal(afterReduce.created, beforeReduce.created,
      'switching to reduced motion does not create another repeating GSAP timeline');
    assert.ok(afterReduce.killed >= beforeReduce.created,
      'switching to reduced motion kills timelines already in flight');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForFunction(previous => window.__guideGsap.created > previous, afterReduce.created);
    assert.equal(regular.errors.length, 0, `Guide has no page errors: ${regular.errors.join(' | ')}`);
    await regular.context.close();

    const reduced = await openSurface(browser, server.baseURL, 'Guide', { reducedMotion: 'reduce' });
    assert.deepEqual(await reduced.page.evaluate(() => ({
      timelines: window.__guideGsap.created,
      staticTerms: document.querySelectorAll('.term[data-motion="static"]').length,
      captions: [...document.querySelectorAll('.term .cap')].every(element => element.textContent.trim().length > 0)
    })), { timelines: 0, staticTerms: 6, captions: true },
    'reduced motion starts as a complete, stable, captioned illustration instead of an infinite animation');
    assert.equal(reduced.errors.length, 0, `Reduced-motion Guide has no page errors: ${reduced.errors.join(' | ')}`);
    await reduced.context.close();

    console.log('✓ Supporting pages: isolated local Home/Guide/Codes, mobile touch/keyboard, 200% text and reduced motion');
  } finally {
    if (browser) await browser.close();
    await stopWrangler(server);
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
