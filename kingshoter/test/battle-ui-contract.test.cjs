const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const CSS_PATH = path.join(__dirname, '../public/battle-ui.css');
const APP_CSS_PATH = path.join(__dirname, '../public/app.css');

function contrast(rgbA, rgbB) {
  function luminance(rgb) {
    const channels = rgb.map(value => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }
  const a = luminance(rgbA);
  const b = luminance(rgbB);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function rgba(value) {
  const parts = value.match(/[\d.]+/g).map(Number);
  return { rgb: parts.slice(0, 3), alpha: parts.length > 3 ? parts[3] : 1 };
}

function fixture() {
  return `<!doctype html>
  <html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head>
  <body class="battle-page">
    <main class="battle-shell" data-battle-drawer-background>
      <div class="battle-status-strip" data-level="ready"><span class="battle-status-strip__mark">✓</span><span>Alerts ready</span></div>
      <section class="battle-card battle-form">
        <h2 class="battle-title">Rally</h2>
        <p class="battle-support">Website scheduling status</p>
        <label>Player ID<input value="10001"></label>
        <button class="battle-control">Save</button>
      </section>
      <section class="battle-card battle-progress" role="progressbar">Progress</section>
      <section class="battle-card battle-map">Castle field</section>
      <section class="battle-card battle-list">Players</section>
      <section class="battle-card battle-confirmation">Confirm removal</section>
      <button class="battle-action">Fire</button>
      <a class="battle-tab" href="#defense">Defense</a>
      <div class="battle-fire-dock">Fire dock</div>
    </main>
    <aside class="battle-drawer" data-drawer-state="command">
      <header class="battle-drawer__header"><button class="battle-drawer__handle">Console</button></header>
      <div class="battle-drawer__content"><button class="battle-control">Close console</button></div>
    </aside>
  </body></html>`;
}

async function withFixture(width, callback, height = 844) {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  const appCss = fs.readFileSync(APP_CSS_PATH, 'utf8');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setContent(fixture());
    await page.addStyleTag({ content: appCss });
    await page.addStyleTag({ content: css });
    return await callback(page, css);
  } finally {
    await browser.close();
  }
}

test('semantic battle surfaces preserve brand typography and meet readable contrast', async () => {
  await withFixture(390, async page => {
    const styles = await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      const support = getComputedStyle(document.querySelector('.battle-support'));
      const status = getComputedStyle(document.querySelector('.battle-status-strip'));
      const action = getComputedStyle(document.querySelector('.battle-action'));
      return {
        font: body.fontFamily,
        bodyColor: body.color,
        bodyBackground: body.backgroundColor,
        supportColor: support.color,
        supportBackground: getComputedStyle(document.querySelector('.battle-card')).backgroundColor,
        statusColor: status.color,
        statusBackground: status.backgroundColor,
        actionColor: action.color,
        actionBackground: action.backgroundColor
      };
    });
    assert.match(styles.font, /ui-rounded|SF Pro Rounded|Nunito|Quicksand/i);
    for (const [label, foreground, background] of [
      ['primary', styles.bodyColor, styles.bodyBackground],
      ['secondary', styles.supportColor, styles.supportBackground],
      ['ready status', styles.statusColor, styles.statusBackground],
      ['primary action', styles.actionColor, styles.actionBackground]
    ]) {
      assert.ok(contrast(rgba(foreground).rgb, rgba(background).rgb) >= 4.5, `${label} text meets AA`);
    }
  });
});

test('critical text, mobile inputs, and every shared hit region meet minimum sizes', async () => {
  for (const width of [320, 375, 390, 430]) {
    await withFixture(width, async page => {
      const metrics = await page.evaluate(() => {
        function size(selector) {
          const element = document.querySelector(selector);
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return { font: parseFloat(style.fontSize), width: rect.width, height: rect.height };
        }
        return {
          support: size('.battle-support'),
          input: size('input'),
          control: size('.battle-control'),
          action: size('.battle-action'),
          tab: size('.battle-tab'),
          handle: size('.battle-drawer__handle'),
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth
        };
      });
      assert.ok(metrics.support.font >= 11, `${width}px critical supporting text`);
      assert.ok(metrics.input.font >= 16, `${width}px input prevents focus zoom`);
      for (const key of ['control', 'action', 'tab', 'handle']) {
        assert.ok(metrics[key].width >= 44 && metrics[key].height >= 44, `${width}px ${key} hit region`);
      }
      assert.ok(metrics.action.height >= 48 && metrics.action.height <= 62, `${width}px primary action height`);
      assert.ok(metrics.scrollWidth <= metrics.clientWidth, `${width}px has no horizontal overflow`);
    });
  }
});

test('forms, progress, maps, lists, confirmations, and drawer content stay opaque', async () => {
  await withFixture(390, async page => {
    const selectors = [
      '.battle-card', '.battle-form', '.battle-progress', '.battle-map',
      '.battle-list', '.battle-confirmation', '.battle-drawer', '.battle-drawer__content'
    ];
    const surfaces = await page.evaluate(current => Object.fromEntries(current.map(selector => {
      const style = getComputedStyle(document.querySelector(selector));
      return [selector, { background: style.backgroundColor, backdrop: style.backdropFilter || style.webkitBackdropFilter }];
    })), selectors);
    for (const [selector, style] of Object.entries(surfaces)) {
      assert.equal(rgba(style.background).alpha, 1, `${selector} has an opaque background`);
      assert.ok(!style.backdrop || style.backdrop === 'none', `${selector} has no translucent material`);
    }
  });
});

test('translucency is allowlisted and reduced-transparency has solid fallbacks', async () => {
  await withFixture(390, async (page, css) => {
    const allowed = await page.evaluate(() => Object.fromEntries([
      '.battle-status-strip', '.battle-drawer__header', '.battle-fire-dock'
    ].map(selector => {
      const style = getComputedStyle(document.querySelector(selector));
      return [selector, { background: style.backgroundColor, backdrop: style.backdropFilter || style.webkitBackdropFilter }];
    })));
    for (const [selector, style] of Object.entries(allowed)) {
      assert.ok(rgba(style.background).alpha < 1, `${selector} is the only material layer`);
      assert.notEqual(style.backdrop, 'none', `${selector} carries the allowed blur`);
    }
    assert.match(css, /@media\s*\(prefers-reduced-transparency:\s*reduce\)/);
    assert.match(css, /@supports\s+not\s*\(\(backdrop-filter:/);
    assert.equal((css.match(/env\(safe-area-inset-top/g) || []).length, 1, 'top safe area is consumed once');
    assert.equal((css.match(/env\(safe-area-inset-bottom/g) || []).length, 1, 'bottom safe area is consumed once');
  });
});

test('motion, contrast, and forced-color preferences retain usable information', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /@media\s*\(prefers-contrast:\s*more\)/);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/);
  assert.match(css, /\.battle-drawer\.is-settling[\s\S]*transition:\s*transform/);
  assert.doesNotMatch(css, /transition:\s*(?:all|top|height|width)/i);
  assert.doesNotMatch(
    css,
    /(?:height|grid-template-rows|top|right|bottom|left|margin|padding)\s*:[^;{}]*--battle-drawer-y/i,
    'the per-frame drawer position never invalidates layout'
  );
});

test('safe areas are consumed by the active surface and the desktop drawer remains centered', async () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  const fireDockRules = [...css.matchAll(/\.battle-fire-dock\s*\{([^}]*)\}/g)];
  const fireDock = fireDockRules.find(match => /position:\s*sticky/.test(match[1]));
  assert.ok(fireDock);
  assert.doesNotMatch(fireDock[1], /--battle-safe-bottom/, 'the shell already consumes the fire dock safe area');
  assert.match(
    css,
    /\.battle-drawer\[data-drawer-state="manage"\]\s+\.battle-drawer__header\s*\{[^}]*--battle-safe-top/,
    'the full-height Manage header clears the top safe area exactly in that state'
  );

  await withFixture(820, async page => {
    const bounds = await page.locator('.battle-drawer').boundingBox();
    assert.ok(Math.abs(bounds.x - (820 - bounds.width) / 2) < 1, 'the widened drawer remains centered');
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 820, 'the desktop drawer never overflows');
  });
});

test('dynamic drawer header and content share all available height at 200% text', async () => {
  await withFixture(320, async page => {
    await page.evaluate(() => {
      const drawer = document.querySelector('.battle-drawer');
      drawer.dataset.drawerState = 'manage';
      drawer.style.setProperty('--battle-drawer-y', '0px');
      const handle = document.querySelector('.battle-drawer__handle');
      handle.textContent = 'Commander Console · Players and Room Settings · Back to command';
      handle.style.fontSize = '28px';
      handle.style.lineHeight = '1.35';
    });
    const layout = await page.evaluate(() => {
      const drawer = document.querySelector('.battle-drawer').getBoundingClientRect();
      const header = document.querySelector('.battle-drawer__header').getBoundingClientRect();
      const content = document.querySelector('.battle-drawer__content').getBoundingClientRect();
      return {
        drawer: { top: drawer.top, bottom: drawer.bottom, height: drawer.height },
        header: { top: header.top, bottom: header.bottom, height: header.height },
        content: { top: content.top, bottom: content.bottom, height: content.height }
      };
    });
    assert.ok(layout.header.height > 56, 'long 200% header is allowed to grow');
    assert.ok(Math.abs(layout.content.top - layout.header.bottom) < 1, 'content starts after the dynamic header');
    assert.ok(layout.content.bottom <= layout.drawer.bottom + 1, 'content bottom is never clipped by the drawer');
    assert.ok(Math.abs(layout.header.height + layout.content.height - layout.drawer.height) < 1,
      'dynamic header plus minmax content fills the drawer exactly');
  });
});

test('landscape command height preserves at least 160px of the live tactical page', async () => {
  await withFixture(844, async page => {
    await page.locator('.battle-shell').evaluate(element => {
      element.dataset.drawerBackgroundState = 'command';
    });
    const paddingBottom = await page.locator('.battle-shell').evaluate(element =>
      parseFloat(getComputedStyle(element).paddingBottom));
    assert.ok(paddingBottom <= 246.1, `390px viewport reserves tactical space instead of ${paddingBottom}px padding`);
  }, 390);
});
