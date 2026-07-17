const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const baseUrl = process.env.KINGSHOT_LOCAL_ORIGIN || 'http://127.0.0.1:8807';

async function waitForState(page, state) {
  await page.waitForFunction(expected => {
    const drawer = document.querySelector('#console');
    return drawer?.dataset.drawerState === expected && !drawer.classList.contains('is-settling');
  }, state);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const presoundContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await presoundContext.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === baseUrl) route.continue();
      else route.fulfill({ status: 204, body: '' });
    });
    const presoundPage = await presoundContext.newPage();
    await presoundPage.addInitScript(() => localStorage.setItem('kingshoter_r_qa_pw', 'qa'));
    await presoundPage.goto(`${baseUrl}/kvk?room=qa&notour=1&lang=en`, { waitUntil: 'networkidle' });
    await waitForState(presoundPage, 'command');
    assert.equal(await presoundPage.locator('#roomView').evaluate(element => element.classList.contains('presound')), true);
    assert.deepEqual(await presoundPage.locator('#console').evaluate(element => ({
      visibility: getComputedStyle(element).visibility,
      pointerEvents: getComputedStyle(element).pointerEvents
    })), { visibility: 'hidden', pointerEvents: 'none' },
    'saved commander authentication cannot bypass the required sound gesture');
    await presoundPage.locator('#soundGate').click();
    await presoundPage.waitForFunction(() => !document.querySelector('#roomView')?.classList.contains('presound'));
    assert.equal(await presoundPage.locator('#console').isVisible(), true,
      'the authenticated drawer becomes available after sound is explicitly enabled');
    await presoundContext.close();

    const viewports = [
      { width: 320, height: 844 },
      { width: 375, height: 844 },
      { width: 390, height: 844 },
      { width: 430, height: 844 },
      { width: 667, height: 375 },
      { width: 844, height: 390 },
      { width: 568, height: 320 }
    ];
    for (const viewport of viewports) {
      const label = `${viewport.width}x${viewport.height}`;
      const context = await browser.newContext({ viewport, hasTouch: true });
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === baseUrl) route.continue();
        else route.fulfill({ status: 204, body: '' });
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

      await page.goto(`${baseUrl}/kvk?room=qa&notour=1&lang=en`, { waitUntil: 'networkidle' });
      await waitForState(page, 'closed');
      assert.equal(await page.evaluate(() => document.body.classList.contains('cmdmode')), false);
      assert.equal(await page.locator('#cmdGate').isVisible(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);

      await page.locator('#soundGate').click();
      await page.waitForFunction(() => !document.querySelector('#roomView')?.classList.contains('presound'));
      await page.locator('#cmdUnlock').click();
      assert.equal(await page.locator('#pwOvl').evaluate(element => element.classList.contains('show')), true);
      await page.locator('#pwInput').fill('qa');
      await page.locator('#pwGo').click();
      await waitForState(page, 'command');

      assert.equal(await page.locator('#commanderCommandPane').isVisible(), true);
      assert.equal(await page.locator('#commanderManagePane').isVisible(), false);
      assert.equal(await page.locator('#battleMain').getAttribute('inert'), null);
      assert.equal(await page.locator('#battleMain').getAttribute('data-drawer-background-state'), 'command');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
      const commandControls = await page.evaluate(() => {
        const visibleInViewport = id => {
          const rect = document.querySelector(id).getBoundingClientRect();
          return rect.top >= 0 && rect.bottom <= innerHeight;
        };
        const setup = document.querySelector('#commanderCommandScroll');
        const content = document.querySelector('.commander-drawer-content');
        return {
          fire: visibleInViewport('#fireDouble'),
          manage: visibleInViewport('#commanderManageOpen'),
          setupHeight: setup.clientHeight,
          contentClientHeight: content.clientHeight,
          contentScrollHeight: content.scrollHeight
        };
      });
      if (viewport.height >= 360) {
        assert.equal(commandControls.fire, true, `${label} keeps Fire visible without setup scrolling`);
        assert.equal(commandControls.manage, true, `${label} keeps Manage visible without setup scrolling`);
        assert.ok(commandControls.setupHeight >= 32,
          `${label} preserves a usable setup viewport instead of collapsing it to ${commandControls.setupHeight}px`);
      } else {
        assert.ok(commandControls.contentScrollHeight > commandControls.contentClientHeight,
          `${label} uses one bounded Command scroller when fixed rows cannot fit`);
        for (const selector of ['#kingdomPick', '#fireDouble']) {
          await page.locator(selector).scrollIntoViewIfNeeded();
          assert.equal(await page.locator(selector).evaluate(element => {
            const rect = element.getBoundingClientRect();
            return rect.top >= 0 && rect.bottom <= innerHeight;
          }), true, `${label} can scroll ${selector} fully into view`);
        }
      }

      const assertInlineToast = async state => {
        await page.evaluate(message => window.toast(message), `Drawer toast QA ${state}`);
        await page.locator('#commanderToast.show').waitFor({ state: 'visible' });
        const result = await page.evaluate(() => {
          const toast = document.querySelector('#commanderToast');
          const rect = toast.getBoundingClientRect();
          const intersectsHeaderControl = Array.from(document.querySelectorAll('#console .battle-drawer__header button'))
            .filter(control => control.getClientRects().length && getComputedStyle(control).visibility !== 'hidden')
            .some(control => {
              const target = control.getBoundingClientRect();
              return rect.left < target.right && rect.right > target.left && rect.top < target.bottom && rect.bottom > target.top;
            });
          const contentRect = document.querySelector('#console .battle-drawer__content').getBoundingClientRect();
          return {
            globalVisible: document.querySelector('#toast').classList.contains('show'),
            insideDrawer: document.querySelector('#console').contains(toast),
            rect: rect.toJSON(),
            intersectsHeaderControl,
            precedesContent: rect.bottom <= contentRect.top + 0.5
          };
        });
        assert.equal(result.globalVisible, false, `${label} ${state} feedback uses the reserved drawer status row`);
        assert.equal(result.insideDrawer, true, `${label} ${state} feedback stays in drawer flow`);
        assert.equal(result.intersectsHeaderControl, false, `${label} ${state} feedback never covers a header control`);
        assert.equal(result.precedesContent, true, `${label} ${state} feedback reserves flow space above all content controls`);
        assert.ok(result.rect.top >= 0 && result.rect.bottom <= viewport.height,
          `${label} ${state} feedback remains inside the viewport`);
        await page.evaluate(() => document.querySelector('#commanderToast').classList.remove('show'));
      };
      await assertInlineToast('command');

      await page.locator('#commanderManageOpen').click();
      await waitForState(page, 'manage');
      assert.equal(await page.locator('#commanderCommandPane').isVisible(), false);
      assert.equal(await page.locator('#commanderManagePane').isVisible(), true);
      assert.equal(await page.locator('#battleMain').getAttribute('inert'), '');
      assert.equal(await page.locator('#settings').evaluate(element => !!element.closest('[inert]')), true,
        'Manage makes every non-drawer room control inert');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'commanderManageBack');
      await assertInlineToast('manage');

      await page.locator('#commanderManageBack').click();
      await waitForState(page, 'command');
      await page.locator('#commanderDrawerClose').click();
      await waitForState(page, 'closed');
      assert.equal(await page.locator('#cmdGate').isVisible(), true);
      assert.equal(await page.locator('#battleMain').getAttribute('inert'), null);
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'cmdUnlock',
        'closing never leaves focus inside the inert drawer');

      await page.locator('#cmdUnlock').click();
      await waitForState(page, 'command');
      assert.equal(await page.locator('#pwOvl').evaluate(element => element.classList.contains('show')), false,
        'collapse retains this page session authentication');
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('rally drawer integration e2e: PASS');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
