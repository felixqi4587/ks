const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'public', 'app.css'), 'utf8');
const kvkHtml = fs.readFileSync(path.join(root, 'public', 'kvk.html'), 'utf8');
const viewportMeta = kvkHtml.match(/<meta\s+name=["']viewport["'][^>]*>/i);
const staticKvkHtml = kvkHtml
  .replace(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi, '')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

test('mobile KvK text-entry controls keep zoom-safe font sizes', async () => {
  assert.ok(viewportMeta, 'kvk.html declares a viewport meta tag');

  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(staticKvkHtml);
    await page.locator('#enemyList').evaluate(element => {
      element.innerHTML = `
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
      `;
    });
    await page.addStyleTag({ content: css });

    const result = await page.evaluate(() => {
      const selectors = [
        '#jr',
        '#pid',
        '#pwInput',
        '#rosterSearch',
        '.foe .nm',
        'textarea',
        'select',
        '.mmss input',
        '.commander-march input'
      ];
      const fontSizes = Object.fromEntries(selectors.map(selector => [
        selector,
        Number.parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)
      ]));
      return {
        fontSizes,
        viewport: document.querySelector('meta[name="viewport"]').content
      };
    });

    assert.doesNotMatch(result.viewport, /(?:user-scalable\s*=\s*no|maximum-scale)/i);
    assert.equal(result.fontSizes['.mmss input'], 20);
    assert.equal(result.fontSizes['.commander-march input'], 20);

    const textEntrySelectors = [
      '#jr', '#pid', '#pwInput', '#rosterSearch', '.foe .nm', 'textarea', 'select'
    ];
    const undersized = textEntrySelectors
      .filter(selector => result.fontSizes[selector] < 16)
      .map(selector => `${selector}: ${result.fontSizes[selector]}px`);
    assert.deepEqual(undersized, [], 'mobile text-entry controls must compute to at least 16px');
  } finally {
    await browser.close();
  }
});
