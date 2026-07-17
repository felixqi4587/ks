const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, firefox, webkit } = require('playwright');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'public/battle-ui.css'), 'utf8');
const script = fs.readFileSync(path.join(root, 'public/battle-drawer.js'), 'utf8');

function fixture() {
  return `<!doctype html><html><head>
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  </head><body class="battle-page">
    <main id="battle" class="battle-shell" data-battle-drawer-background>
      <div class="battle-status-strip" data-level="ready">✓ Alerts ready</div>
      <section class="battle-card"><p id="live">frame 0</p><input value="Player"></section>
      <button id="entry" class="battle-action">Commander console</button>
    </main>
    <aside id="drawer" class="battle-drawer" aria-label="Commander console">
      <header id="handle" class="battle-drawer__header battle-drawer__handle">
        <div class="battle-drawer__grabber" aria-hidden="true"></div>
        <span>Commander console</span>
      </header>
      <div class="battle-drawer__content">
        <button id="first" class="battle-control" data-drawer-focus>Players</button>
        <div id="scroll" class="battle-list" style="height:160px;overflow:auto">
          ${Array.from({ length: 20 }, (_, index) => `<p>Player ${index + 1}</p>`).join('')}
        </div>
        <button id="last" class="battle-control">Back to command</button>
      </div>
    </aside>
  </body></html>`;
}

async function install(page, options = {}) {
  await page.setContent(fixture());
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await page.evaluate(({ paneSwap }) => {
    let commandTrigger = null;
    let manageTarget = null;
    if (paneSwap) {
      const content = document.querySelector('.battle-drawer__content');
      commandTrigger = document.createElement('button');
      commandTrigger.id = 'commandTrigger';
      commandTrigger.className = 'battle-control';
      commandTrigger.textContent = 'Open Players';
      manageTarget = document.createElement('button');
      manageTarget.id = 'managePreferred';
      manageTarget.className = 'battle-control';
      manageTarget.dataset.drawerFocus = '';
      manageTarget.textContent = 'Manage player';
      manageTarget.hidden = true;
      document.querySelector('#first').hidden = true;
      content.prepend(manageTarget);
      content.prepend(commandTrigger);
    }
    window.drawer = BattleDrawer.create({
      root: document.querySelector('#drawer'),
      handle: document.querySelector('#handle'),
      background: document.querySelector('#battle'),
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)'),
      onStateChange(state) {
        if (!paneSwap) return;
        commandTrigger.hidden = state !== 'command';
        manageTarget.hidden = state !== 'manage';
      }
    });
    document.querySelector('#entry').addEventListener('click', () => window.drawer.openCommand());
    document.querySelector('#last').addEventListener('click', () => window.drawer.backToCommand());
    if (paneSwap) commandTrigger.addEventListener('click', () => window.drawer.openManage());
  }, { paneSwap: !!options.paneSwap });
}

async function assertCommandContentReachable(page, engineName, height) {
  await page.setViewportSize({ width: 390, height });
  await install(page);
  await page.evaluate(() => {
    const spacer = document.createElement('div');
    spacer.id = 'commandOverflow';
    spacer.style.height = '520px';
    spacer.style.flex = '0 0 520px';
    document.querySelector('#last').before(spacer);
    drawer.openCommand();
  });
  await page.waitForTimeout(350);
  const geometry = await page.evaluate(() => {
    const content = document.querySelector('.battle-drawer__content');
    const last = document.querySelector('#last');
    content.scrollTop = 0;
    last.scrollIntoView({ block: 'end' });
    const rect = last.getBoundingClientRect();
    return {
      bottom: rect.bottom,
      viewportHeight: innerHeight,
      maxScroll: content.scrollHeight - content.clientHeight,
      scrollTop: content.scrollTop
    };
  });
  assert.ok(geometry.maxScroll > 0,
    `${engineName} ${height}px Command content exposes a real scroll range: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.scrollTop > 0 && geometry.bottom <= geometry.viewportHeight + 1,
    `${engineName} ${height}px can scroll the last Command control onscreen: ${JSON.stringify(geometry)}`);
}

async function assertAnchoredDirectManipulation(page, engineName) {
  await install(page);
  await page.locator('#entry').click();
  await page.waitForTimeout(350);
  const handle = await page.locator('#handle').boundingBox();
  const x = handle.x + handle.width / 2;
  const startY = handle.y + 5;
  const startTop = handle.y;
  await page.mouse.move(x, startY);
  await page.mouse.down();
  await page.mouse.move(x, startY - 160, { steps: 5 });
  const upward = await page.evaluate(() => {
    const drawerRect = document.querySelector('#drawer').getBoundingClientRect();
    const handleRect = document.querySelector('#handle').getBoundingClientRect();
    return { drawerBottom: drawerRect.bottom, drawerHeight: drawerRect.height, handleTop: handleRect.top, viewport: innerHeight };
  });
  assert.ok(upward.drawerBottom >= upward.viewport - 1 && upward.drawerHeight >= upward.viewport - 1,
    `${engineName} upward drag keeps a full sheet covering the bottom: ${JSON.stringify(upward)}`);
  assert.ok(Math.abs(upward.handleTop - (startTop - 160)) <= 2,
    `${engineName} upward drag follows the pointer 1:1: ${JSON.stringify(upward)}`);

  await page.mouse.move(x, startY - 80, { steps: 3 });
  const reversed = await page.evaluate(() => {
    const drawerRect = document.querySelector('#drawer').getBoundingClientRect();
    const handleRect = document.querySelector('#handle').getBoundingClientRect();
    return { drawerBottom: drawerRect.bottom, drawerHeight: drawerRect.height, handleTop: handleRect.top, viewport: innerHeight };
  });
  assert.ok(reversed.drawerBottom >= reversed.viewport - 1 && reversed.drawerHeight >= reversed.viewport - 1,
    `${engineName} reversed drag remains bottom-covered: ${JSON.stringify(reversed)}`);
  assert.ok(Math.abs(reversed.handleTop - (startTop - 80)) <= 2,
    `${engineName} reverse drag remains 1:1: ${JSON.stringify(reversed)}`);
  await page.mouse.up();
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [320, 375, 390, 430]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: true });
      await install(page);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
      assert.equal(await page.locator('input').evaluate(element => parseFloat(getComputedStyle(element).fontSize) >= 16), true);

      await page.locator('#entry').click();
      assert.equal(await page.evaluate(() => drawer.state()), 'command');
      await page.waitForTimeout(350);
      await page.locator('#live').evaluate(element => { element.textContent = 'frame 1'; });
      assert.equal(await page.locator('#live').textContent(), 'frame 1', 'command keeps the tactical page live');

      const box = await page.locator('#handle').boundingBox();
      const grabberY = box.y + 5;
      await page.mouse.move(box.x + box.width / 2, grabberY);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, 40, { steps: 5 });
      await page.mouse.up();
      assert.equal(await page.evaluate(() => drawer.state()), 'manage');
      assert.equal(await page.locator('#battle').getAttribute('inert'), '');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'first');

      await page.locator('#handle').focus();
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'last');
      await page.locator('#last').click();
      assert.equal(await page.evaluate(() => drawer.state()), 'command');
      assert.equal(await page.locator('#battle').getAttribute('inert'), null);
      await page.waitForTimeout(350);

      const beforeScrollDrag = await page.evaluate(() => drawer.state());
      const scrollBox = await page.locator('#scroll').boundingBox();
      await page.mouse.move(scrollBox.x + 20, scrollBox.y + 60);
      await page.mouse.down();
      await page.mouse.move(scrollBox.x + 20, scrollBox.y + 10);
      await page.mouse.up();
      assert.equal(await page.evaluate(() => drawer.state()), beforeScrollDrag, 'roster scroll never moves the drawer');

      await page.locator('#handle').focus();
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.evaluate(() => drawer.state()), 'closed');
      await page.close();
    }

    const touch = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await install(touch);
    await touch.locator('#entry').tap();
    await touch.waitForTimeout(350);
    const touchHandle = await touch.locator('#handle').boundingBox();
    const touchX = touchHandle.x + touchHandle.width / 2;
    const touchStartY = touchHandle.y + 5;
    const touchCdp = await touch.context().newCDPSession(touch);
    await touchCdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: touchX, y: touchStartY, id: 1 }]
    });
    for (const y of [touchStartY - 40, touchStartY - 120, touchStartY - 240, 40]) {
      await touchCdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: touchX, y, id: 1 }]
      });
    }
    await touchCdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.equal(await touch.evaluate(() => drawer.state()), 'manage', 'real touch events reach Manage');
    await touch.close();

    const resized = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await install(resized);
    await resized.locator('#entry').click();
    await resized.waitForTimeout(350);
    const resizeHandle = await resized.locator('#handle').boundingBox();
    const resizeX = resizeHandle.x + resizeHandle.width / 2;
    const resizeY = resizeHandle.y + 5;
    await resized.mouse.move(resizeX, resizeY);
    await resized.mouse.down();
    await resized.mouse.move(resizeX, resizeY + 120, { steps: 4 });
    await resized.setViewportSize({ width: 390, height: 390 });
    await resized.waitForTimeout(50);
    await resized.mouse.up();
    const resizedState = await resized.locator('#drawer').evaluate(element => ({
      state: drawer.state(),
      y: parseFloat(element.style.getPropertyValue('--battle-drawer-y')),
      top: element.getBoundingClientRect().top
    }));
    assert.equal(resizedState.state, 'command');
    assert.ok(resizedState.y <= 230, `resize rebases command inside viewport: ${resizedState.y}`);
    assert.ok(resizedState.top >= 159, `landscape retains tactical page: ${resizedState.top}`);
    await resized.close();

    const reduced = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await reduced.emulateMedia({ reducedMotion: 'reduce' });
    await install(reduced);
    await reduced.locator('#entry').click();
    assert.deepEqual(await reduced.locator('#drawer').evaluate(element => ({
      state: window.drawer.state(),
      motion: element.dataset.drawerMotion,
      settling: element.classList.contains('is-settling')
    })), { state: 'command', motion: 'static', settling: false });
    await reduced.close();

    const transparency = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const cdp = await transparency.context().newCDPSession(transparency);
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }]
    });
    await install(transparency);
    const alpha = await transparency.locator('.battle-drawer__header').evaluate(element => {
      const parts = getComputedStyle(element).backgroundColor.match(/[\d.]+/g).map(Number);
      return parts.length > 3 ? parts[3] : 1;
    });
    assert.equal(alpha, 1, 'reduced transparency uses a solid drawer header');
    await transparency.close();

    for (const [engineName, browserType] of [
      ['Chromium', chromium], ['Firefox', firefox], ['WebKit', webkit]
    ]) {
      const engine = await browserType.launch({ headless: true });
      try {
        const panePage = await engine.newPage({ viewport: { width: 390, height: 844 } });
        await install(panePage, { paneSwap: true });
        await panePage.locator('#entry').click();
        await panePage.waitForTimeout(350);
        await panePage.locator('#commandTrigger').focus();
        await panePage.keyboard.press('Enter');
        assert.equal(await panePage.evaluate(() => document.activeElement.id), 'managePreferred',
          `${engineName} focuses the Manage target revealed by the pane swap`);
        await panePage.evaluate(() => drawer.backToCommand());
        assert.equal(await panePage.evaluate(() => document.activeElement.id), 'commandTrigger',
          `${engineName} restores the exact Command trigger after the pane swap`);
        await panePage.close();

        const directPage = await engine.newPage({ viewport: { width: 390, height: 844 } });
        await assertAnchoredDirectManipulation(directPage, engineName);
        await directPage.close();

        for (const height of [844, 390]) {
          const overflowPage = await engine.newPage({ viewport: { width: 390, height } });
          await assertCommandContentReachable(overflowPage, engineName, height);
          await overflowPage.close();
        }

        const page = await engine.newPage({ viewport: { width: 390, height: 844 } });
        await install(page);
        assert.equal(await page.locator('#drawer').getAttribute('inert'), '', `${engineName} closed drawer is inert`);
        const closedFocus = await page.evaluate(() => {
          document.querySelector('#first').focus();
          return document.activeElement.id;
        });
        assert.notEqual(closedFocus, 'first', `${engineName} cannot focus closed drawer internals`);
        const closedAccessibility = await page.locator('body').ariaSnapshot();
        assert.doesNotMatch(closedAccessibility, /Players/, `${engineName} removes closed content from accessibility`);

        await page.locator('#entry').click();
        assert.equal(await page.locator('#drawer').getAttribute('inert'), null, `${engineName} command is interactive`);
        await page.waitForTimeout(350);
        assert.match(await page.locator('body').ariaSnapshot(), /Players/, `${engineName} exposes open command content`);
        const engineHandle = await page.locator('#handle').boundingBox();
        const engineX = engineHandle.x + engineHandle.width / 2;
        await page.mouse.move(engineX, engineHandle.y + 5);
        await page.mouse.down();
        await page.mouse.move(engineX, 40, { steps: 5 });
        await page.mouse.up();
        assert.equal(await page.evaluate(() => drawer.state()), 'manage', `${engineName} pointer drag reaches Manage`);
        await page.evaluate(() => drawer.backToCommand());
        await page.evaluate(() => {
          const content = document.querySelector('.battle-drawer__content');
          const hidden = document.createElement('button');
          hidden.id = 'cssHidden';
          hidden.dataset.drawerFocus = '';
          hidden.style.display = 'none';
          content.prepend(hidden);

          const inertGroup = document.createElement('div');
          inertGroup.inert = true;
          inertGroup.innerHTML = '<button id="inertChild" data-drawer-focus>Inert</button>';
          hidden.after(inertGroup);

          const ariaGroup = document.createElement('div');
          ariaGroup.setAttribute('aria-hidden', 'true');
          ariaGroup.innerHTML = '<button id="ariaHiddenChild" data-drawer-focus>Hidden</button>';
          inertGroup.after(ariaGroup);

          const editable = document.createElement('div');
          editable.id = 'editable';
          editable.contentEditable = 'true';
          editable.textContent = 'Editable manager note';
          document.querySelector('#first').after(editable);
          drawer.openManage();
        });
        assert.equal(await page.evaluate(() => document.activeElement.id), 'first',
          `${engineName} skips hidden preferred controls`);
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'editable',
          `${engineName} includes visible contenteditable in the focus order`);
        const drawerState = await page.evaluate(() => { drawer.close(); return drawer.state(); });
        assert.equal(drawerState, 'closed');
        assert.equal(await page.locator('#drawer').getAttribute('inert'), '');
        await page.close();
      } finally {
        await engine.close();
      }
    }

    process.stdout.write('battle drawer e2e: PASS\n');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
