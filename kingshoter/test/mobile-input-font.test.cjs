const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium, webkit } = require('playwright');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'public', 'app.css'), 'utf8');
const kvkHtml = fs.readFileSync(path.join(root, 'public', 'rally.html'), 'utf8');
const viewportMeta = kvkHtml.match(/<meta\s+name=["']viewport["'][^>]*>/i);
const staticKvkHtml = kvkHtml
  .replace(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi, '')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

const textEntrySelectors = [
  '#jr', '#pid', '#pwInput', '#rosterSearch', '.foe .nm', 'textarea', 'select'
];
const marchInputSelectors = ['.mmss input', '.commander-march input'];
const excludedInputSelectors = ['#marchRange', '#tripleMode', '#fontContractRadio'];
const desktopBaseline = {
  '#jr': 15,
  '#pid': 15,
  '#pwInput': 15,
  '#rosterSearch': 15,
  '.foe .nm': 14,
  textarea: 13.5,
  select: 15,
  '.mmss input': 20,
  '.commander-march input': 20
};

async function renderKvkFixture(page) {
  await page.setContent(staticKvkHtml);
  await page.locator('body').evaluate(element => {
    element.insertAdjacentHTML('beforeend', `
      <div class="foe"><div class="r1">
        <input class="nm">
        <span class="mmss">
          <input type="number"><span class="u">m</span><span class="c">:</span>
          <input type="number"><span class="u">s</span>
        </span>
        <button class="del">×</button>
      </div></div>
      <textarea></textarea>
      <select><option>Kingdom 1</option></select>
      <input id="fontContractRadio" type="radio">
    `);
  });
  await page.addStyleTag({ content: css });
}

async function getFontSizes(page, selectors) {
  return page.evaluate(currentSelectors => Object.fromEntries(
    currentSelectors.map(selector => [
      selector,
      Number.parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)
    ])
  ), selectors);
}

async function newReducedMotionPage(browser, viewport) {
  const page = await browser.newPage({ viewport });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  return page;
}

test('KvK viewport keeps pinch zoom enabled', () => {
  assert.ok(viewportMeta, 'rally.html declares a viewport meta tag');
  assert.doesNotMatch(viewportMeta[0], /(?:user-scalable\s*=\s*no|maximum-scale)/i);
});

for (const [engineName, browserType] of [
  ['Chromium', chromium],
  ['WebKit', webkit]
]) {
  test(`${engineName}: KvK mobile input sizes are scoped without desktop regressions`, async () => {
    const browser = await browserType.launch({ headless: true });
    try {
      const mobilePage = await newReducedMotionPage(browser, { width: 390, height: 844 });
      await renderKvkFixture(mobilePage);

      const allSelectors = [
        ...textEntrySelectors,
        ...marchInputSelectors,
        ...excludedInputSelectors
      ];
      const mobileFontSizes = await getFontSizes(mobilePage, allSelectors);

      const undersized = textEntrySelectors
        .filter(selector => mobileFontSizes[selector] < 16)
        .map(selector => `${selector}: ${mobileFontSizes[selector]}px`);
      assert.deepEqual(undersized, [], 'mobile text-entry controls must compute to at least 16px');
      assert.equal(mobileFontSizes['.mmss input'], 20);
      assert.equal(mobileFontSizes['.commander-march input'], 20);

      const desktopPage = await newReducedMotionPage(browser, { width: 821, height: 768 });
      await renderKvkFixture(desktopPage);
      const desktopFontSizes = await getFontSizes(desktopPage, allSelectors);
      assert.deepEqual(
        Object.fromEntries(Object.keys(desktopBaseline).map(selector => [
          selector,
          desktopFontSizes[selector]
        ])),
        desktopBaseline,
        'desktop controls must retain their baseline sizes above the 820px breakpoint'
      );
      assert.deepEqual(
        Object.fromEntries(excludedInputSelectors.map(selector => [
          selector,
          mobileFontSizes[selector]
        ])),
        Object.fromEntries(excludedInputSelectors.map(selector => [
          selector,
          desktopFontSizes[selector]
        ])),
        'range, checkbox, and radio inputs must be unchanged by the mobile rule'
      );

      const sharedPage = await newReducedMotionPage(browser, { width: 390, height: 844 });
      await sharedPage.setContent(`
        <!doctype html>
        <html><body>
          <div class="whale"><div class="r1"><input class="nm"></div></div>
        </body></html>
      `);
      await sharedPage.addStyleTag({ content: css });
      const sharedPageFontSizes = await getFontSizes(sharedPage, ['.whale .r1 .nm']);
      assert.equal(
        sharedPageFontSizes['.whale .r1 .nm'],
        14,
        'shared app.css must retain compact inputs outside KvK pages on mobile'
      );
    } finally {
      await browser.close();
    }
  });
}
