const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const {
  assertQaRoomName,
  installQaWebSocketGuard,
  localQaBaseURL,
  makeQaRoom,
  qaRoomUrl
} = require('./support/qa-kvk.cjs');

const base = localQaBaseURL(process.env.BASE || 'http://127.0.0.1:8791');
const room = makeQaRoom('rally-tactical');
const url = qaRoomUrl(base, room, { notour: 1, lang: 'en' });
const password = 'rally-tactical-password';
const players = [5, 20, 36, 40, 50, 60].map((march, index) => ({
  pid: `84000000${index + 1}`,
  name: `Captain ${index + 1}`,
  march,
  profileKey: `84000000-0000-4000-8000-00000000000${index + 1}`
}));

async function sendMessages(page, messages) {
  assertQaRoomName(room);
  await page.evaluate(({ roomName, payloads }) => new Promise((resolve, reject) => {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}/api/ws?room=${encodeURIComponent(roomName)}`);
    const timer = setTimeout(() => reject(new Error('QA WebSocket timeout')), 8000);
    socket.onopen = () => {
      payloads.forEach(payload => socket.send(JSON.stringify(payload)));
      setTimeout(() => { clearTimeout(timer); socket.close(); resolve(); }, 700);
    };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('QA WebSocket failed')); };
  }), { roomName: room, payloads: messages });
}

async function unlockCommander(page) {
  if (await page.locator('#roomView').evaluate(element => element.classList.contains('presound'))) {
    await page.locator('#soundGate').click({ force: true });
    await page.waitForFunction(() => !document.querySelector('#roomView')?.classList.contains('presound'));
  }
  await page.locator('#cmdUnlock').click();
  if (await page.locator('#pwOvl').evaluate(element => element.classList.contains('show'))) {
    await page.locator('#pwInput').fill(password);
    await page.locator('#pwGo').click();
  }
  await page.locator('#console[data-drawer-state="command"]').waitFor({ timeout: 8_000 });
}

function parseTime(text) {
  const [minutes, seconds] = text.split(':').map(Number);
  return minutes * 60 + seconds;
}

function rgb(value) {
  const channels = String(value).match(/[\d.]+/g);
  assert.ok(channels && channels.length >= 3, `expected rgb color, got ${value}`);
  return channels.slice(0, 3).map(Number);
}

function luminance(color) {
  const channels = Array.isArray(color) ? color : rgb(color);
  const linear = channels.map(channel => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(foreground, background) {
  const left = luminance(foreground);
  const right = luminance(background);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

async function fieldGeometry(page) {
  return page.evaluate(() => {
    const rect = element => {
      const value = element.getBoundingClientRect();
      return { left: value.left, right: value.right, top: value.top, bottom: value.bottom,
        width: value.width, height: value.height };
    };
    const intersects = (left, right) =>
      left.width > 0 && left.height > 0 && right.width > 0 && right.height > 0 &&
      left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
    const pond = rect(document.querySelector('#situation .pond'));
    const labels = ['#mapScaleLabel', '#mapMessage', '#mapLegend'].map(selector =>
      rect(document.querySelector(selector)));
    const markers = [...document.querySelectorAll('#radar .rally-dot')].map(rect);
    return {
      pond, markers,
      labelCollisions: markers.flatMap((marker, markerIndex) =>
        labels.map((label, labelIndex) => intersects(marker, label) ? { markerIndex, labelIndex, marker, label } : null)
          .filter(Boolean))
    };
  });
}

function assertSafeFieldGeometry(geometry, width, mode) {
  assert.ok(geometry.markers.every(marker =>
    marker.left >= geometry.pond.left + 9 && marker.right <= geometry.pond.right - 9 &&
    marker.top >= geometry.pond.top + 9 && marker.bottom <= geometry.pond.bottom - 9),
  `${width}px ${mode} keeps every max-distance role inside the 9px safe field inset`);
  assert.equal(geometry.labelCollisions.length, 0,
    `${width}px ${mode} keeps every max-distance role clear of scale, message, and legend copy: ${JSON.stringify(geometry.labelCollisions)}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 430, height: 1400 }, locale: 'en-US' });
  const pageErrors = [];

  try {
    await installQaWebSocketGuard(context, room, { expectedOrigin: base });
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => (document.querySelector('#mapMessage')?.textContent || '').trim().length > 0);
    const emptyField = await page.evaluate(() => {
      const message = document.querySelector('#mapMessage');
      const legend = document.querySelector('#mapLegend');
      const messageRect = message.getBoundingClientRect();
      const legendRect = legend.getBoundingClientRect();
      return {
        messageVisible: !message.hidden && messageRect.height > 0,
        legendHidden: legend.hidden || getComputedStyle(legend).display === 'none',
        overlaps: messageRect.left < legendRect.right && messageRect.right > legendRect.left &&
          messageRect.top < legendRect.bottom && messageRect.bottom > legendRect.top
      };
    });
    assert.equal(emptyField.messageVisible, true, 'an empty field explains that captains are still waiting');
    assert.equal(emptyField.legendHidden, true, 'role and identity legend stays hidden until actors exist');
    assert.equal(emptyField.overlaps, false, 'empty field copy never overlaps a role legend');

    await sendMessages(page, [
      { t: 'setConfig', password, config: { castleName: '', rallyAllies: [], enemyWhales: [] }, by: 'rally-tactical-bootstrap' },
      ...players.map(player => ({
        t: 'registerPlayer', pid: player.pid, name: player.name, march: player.march,
        identityMode: 'playerId', alliance: '', profileKey: player.profileKey
      })),
      { t: 'setRallyMode', mutationId: 'tactical-mode-1', password, kingdom: 1, mode: 'triple', baseRevision: 0 },
      { t: 'setRallyMode', mutationId: 'tactical-mode-2', password, kingdom: 2, mode: 'triple', baseRevision: 0 },
      { t: 'stage', password, staged: { kingdom: 1, modeRevision: 1, pairs: [
        { pid: players[0].pid, role: 'weak' },
        { pid: players[1].pid, role: 'weak2' },
        { pid: players[2].pid, role: 'main' }
      ] } },
      { t: 'stage', password, staged: { kingdom: 2, modeRevision: 1, pairs: [
        { pid: players[3].pid, role: 'weak' },
        { pid: players[4].pid, role: 'weak2' },
        { pid: players[5].pid, role: 'main' }
      ] } }
    ]);

    await page.evaluate(({ roomName, player }) => {
      localStorage.setItem(`kingshoter_r_${roomName}_me`, JSON.stringify({
        pid: player.pid,
        playerId: player.pid,
        name: player.name,
        march: player.march,
        marchRevision: 0,
        identityMode: 'playerId',
        editable: true,
        profileKey: player.profileKey
      }));
    }, { roomName: room, player: players[0] });
    await page.reload({ waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => document.querySelectorAll('#lanes .lane').length === 6, null, { timeout: 8000 });

    for (const width of [320, 375, 390, 430]) {
      await page.setViewportSize({ width, height: 1400 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const layout = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('#lanes .lane')];
        const routes = [...document.querySelectorAll('#radar .rally-route')];
        return {
          groups: document.querySelectorAll('#lanes .lane-group').length,
          rows: rows.map(row => ({
            name: row.querySelector('.lname')?.textContent.trim() || '',
            time: row.querySelector('.ltimev')?.textContent.trim() || '',
            nameSize: Number.parseFloat(getComputedStyle(row.querySelector('.lname')).fontSize),
            timeSize: Number.parseFloat(getComputedStyle(row.querySelector('.ltimev')).fontSize),
            trackWidth: row.querySelector('.ltrack').getBoundingClientRect().width
          })),
          routeRadii: routes.map(route => Math.hypot(
            Number(route.getAttribute('x2')) - Number(route.getAttribute('x1')),
            Number(route.getAttribute('y2')) - Number(route.getAttribute('y1'))
          )),
          routeCenters: routes.map(route => [Number(route.getAttribute('x1')), Number(route.getAttribute('y1'))]),
          routeScreenRadii: (() => {
            const matrix = document.querySelector('#radar').getScreenCTM();
            return routes.map(route => {
              const start = new DOMPoint(Number(route.getAttribute('x1')), Number(route.getAttribute('y1'))).matrixTransform(matrix);
              const end = new DOMPoint(Number(route.getAttribute('x2')), Number(route.getAttribute('y2'))).matrixTransform(matrix);
              return Math.hypot(end.x - start.x, end.y - start.y);
            });
          })(),
          scale: document.querySelector('#mapScaleLabel')?.textContent || '',
          colors: (() => {
            const firstName = rows[0].querySelector('.lname');
            firstName.classList.add('contrast-probe');
            rows[0].classList.add('me');
            const legend = document.querySelector('#mapLegend');
            const message = document.querySelector('#mapMessage');
            const note = document.querySelector('#lanes .lanenote');
            const kingdom = document.querySelector('#lanes .lane-group.kingdom-1 .lane-group-head');
            const priorMessage = { hidden: message.hidden, text: message.textContent };
            message.hidden = false;
            message.textContent = 'Waiting for captains';
            const sample = {
              scale: getComputedStyle(document.querySelector('#mapScaleLabel')).color,
              legend: getComputedStyle(legend).color,
              legendSize: Number.parseFloat(getComputedStyle(legend).fontSize),
              legendHeight: legend.getBoundingClientRect().height,
              messageSize: Number.parseFloat(getComputedStyle(message).fontSize),
              messageHeight: message.getBoundingClientRect().height,
              note: getComputedStyle(note).color,
              noteBackground: getComputedStyle(document.querySelector('#situation')).backgroundColor,
              kingdom: getComputedStyle(kingdom).color,
              kingdomBackground: getComputedStyle(kingdom).backgroundColor,
              mine: getComputedStyle(firstName).color
            };
            message.hidden = priorMessage.hidden;
            message.textContent = priorMessage.text;
            rows[0].classList.remove('me');
            firstName.classList.remove('contrast-probe');
            return sample;
          })(),
          glyphColors: (() => {
            const actorCircles = [...document.querySelectorAll('#radar .rally-dot > circle:last-child')];
            const mineRing = document.querySelector('#radar .rally-dot > circle[r="9"]');
            return {
              actors: actorCircles.map(circle => getComputedStyle(circle).stroke),
              mineRing: mineRing ? getComputedStyle(mineRing).stroke : ''
            };
          })(),
          pondHeight: document.querySelector('#situation .pond')?.getBoundingClientRect().height || 0,
          pondWidth: document.querySelector('#situation .pond')?.getBoundingClientRect().width || 0,
          pageOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
          tacticalOverflow: document.querySelector('#situation').scrollWidth - document.querySelector('#situation').clientWidth
        };
      });

      assert.equal(layout.groups, 2, `${width}px keeps both kingdoms together`);
      assert.equal(layout.rows.length, 6, `${width}px keeps all six selected captains`);
      assert.deepEqual(layout.rows.map(row => row.time).map(parseTime), players.map(player => player.march),
        `${width}px preserves every exact M:SS value`);
      assert.ok(layout.rows.every(row => row.nameSize >= 13), `${width}px keeps player names readable`);
      assert.ok(layout.rows.every(row => row.timeSize >= 14), `${width}px keeps exact times readable`);
      assert.ok(layout.rows.every(row => row.trackWidth >= 70), `${width}px preserves meaningful progress bars`);
      assert.ok(layout.routeCenters.every(([x, y]) => x === 180 && y === 135), `${width}px centers every route on the castle`);
      assert.ok(layout.routeRadii.every((radius, index, radii) => index === 0 || radius > radii[index - 1]),
        `${width}px preserves relative march distances`);
      assert.ok(layout.routeRadii.at(-1) > 111 && layout.routeRadii.at(-1) < 115,
        `${width}px farthest captain uses the field with castle-safe headroom`);
      assert.ok(layout.routeRadii[0] > 24 && layout.routeRadii[0] < layout.routeRadii[1],
        `${width}px 5s and 20s marches remain visibly distinct outside the castle`);
      assert.match(layout.scale, /1:05/, `${width}px exposes the dynamic 65-second field scale`);
      assert.ok(layout.pondHeight >= 250 && layout.pondHeight <= 274,
        `${width}px keeps the existing field frame instead of enlarging the castle (${layout.pondHeight}px)`);
      assert.ok(layout.routeScreenRadii.at(-1) / (layout.pondHeight / 2) >= 0.82,
        `${width}px farthest captain uses most of the visible field height`);
      assert.ok(layout.pageOverflow <= 1 && layout.tacticalOverflow <= 1, `${width}px has no horizontal overflow`);
      assert.ok(contrast(layout.colors.scale, [182, 235, 226]) >= 4.5,
        `${width}px field scale passes 4.5:1 on the darkest pond color`);
      assert.ok(contrast(layout.colors.legend, [182, 235, 226]) >= 4.5,
        `${width}px map legend passes 4.5:1 on the darkest pond color`);
      assert.ok(contrast(layout.colors.note, layout.colors.noteBackground) >= 4.5,
        `${width}px tactical note passes 4.5:1`);
      assert.ok(contrast(layout.colors.kingdom, layout.colors.kingdomBackground) >= 4.5,
        `${width}px kingdom heading passes 4.5:1`);
      assert.ok(contrast(layout.colors.mine, layout.colors.noteBackground) >= 4.5,
        `${width}px selected player name passes 4.5:1`);
      for (const color of layout.glyphColors.actors) {
        for (const background of [[182, 235, 226], [205, 242, 236], [232, 251, 248]]) {
          assert.ok(contrast(color, background) >= 3,
            `${width}px actor marker ${color} passes 3:1 on the tactical field`);
        }
      }
      for (const background of [[182, 235, 226], [205, 242, 236], [232, 251, 248]]) {
        assert.ok(contrast(layout.glyphColors.mineRing, background) >= 3,
          `${width}px personal identity ring passes 3:1 on the tactical field`);
      }
      assert.ok(layout.colors.legendSize >= 11 && layout.colors.legendHeight >= 11,
        `${width}px map legend remains at least 11px after SVG scaling is removed`);
      assert.ok(layout.colors.messageSize >= 11 && layout.colors.messageHeight >= 11,
        `${width}px empty-state map copy remains at least 11px`);
    }

    await sendMessages(page, players.map((player, index) => ({
      t: 'setPlayerMarch', mutationId: `tactical-max-${index}`, password,
      pid: player.pid, march: 120, baseRevision: 0
    })));
    await page.waitForFunction(() => [...document.querySelectorAll('#lanes .ltimev')]
      .filter(node => node.textContent.trim() === '2:00').length === 6, null, { timeout: 8_000 });

    for (const width of [320, 375, 390, 430]) {
      await page.setViewportSize({ width, height: 1400 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assertSafeFieldGeometry(await fieldGeometry(page), width, 'ordinary view');
    }

    await unlockCommander(page);
    for (const width of [320, 375, 390, 430]) {
      await page.setViewportSize({ width, height: 1400 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const geometry = await fieldGeometry(page);
      assert.ok(geometry.pond.height >= 220,
        `${width}px commander keeps enough tactical height (${geometry.pond.height}px)`);
      assertSafeFieldGeometry(geometry, width, 'commander view');
    }

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await sendMessages(page, [
      { t: 'setRallyMode', mutationId: 'tactical-mode-double', password, kingdom: 1, mode: 'double', baseRevision: 1 }
    ]);
    await page.waitForFunction(() => /Double/.test(document.querySelector('#lanes .kingdom-1 .lane-group-head')?.textContent || ''));
    const firstPress = Math.floor(Date.now() / 1000) + 60;
    await sendMessages(page, [{
      t: 'cmd', password,
      cmd: {
        type: 'double_rally', kingdom: 1, anchorUTC: firstPress,
        payload: {
          firstPress, kingdom: 1,
          pairs: [
            { pid: players[0].pid, role: 'weak', march: players[0].march, pressUTC: firstPress },
            { pid: players[2].pid, role: 'main', march: players[2].march, pressUTC: firstPress + 1 }
          ]
        }
      }
    }]);
    await page.locator('#lanes .ltrack.live').first().waitFor();
    const reducedMotion = await page.evaluate(async () => {
      const originalNow = window.serverNow;
      window.__tacticalMotionNow = originalNow() + 365_000;
      window.serverNow = () => window.__tacticalMotionNow;
      const targets = [document.querySelector('#radar'), document.querySelector('#lanes')];
      let mutations = 0;
      const observer = new MutationObserver(records => {
        mutations += records.filter(record => record.type === 'attributes' &&
          (record.attributeName === 'transform' || record.attributeName === 'style')).length;
      });
      targets.forEach(target => observer.observe(target, { subtree: true, attributes: true,
        attributeFilter: ['transform', 'style'] }));
      await new Promise(resolve => setTimeout(resolve, 250));
      const firstWindow = mutations;
      mutations = 0;
      window.__tacticalMotionNow += 1_000;
      await new Promise(resolve => setTimeout(resolve, 250));
      const nextWindow = mutations;
      observer.disconnect();
      window.serverNow = originalNow;
      return {
        firstWindow, nextWindow,
        transition: getComputedStyle(document.querySelector('#lanes .ldot.trav')).transitionDuration,
        reduced: matchMedia('(prefers-reduced-motion: reduce)').matches
      };
    });
    assert.equal(reducedMotion.reduced, true, 'browser applies reduced-motion preference');
    assert.equal(reducedMotion.transition, '0s', 'reduced motion removes smooth marker transitions');
    assert.ok(reducedMotion.firstWindow > 0 && reducedMotion.firstWindow <= 12,
      `reduced motion performs one bounded clock-derived update (${reducedMotion.firstWindow})`);
    assert.ok(reducedMotion.nextWindow > 0 && reducedMotion.nextWindow <= 12,
      `the next second advances with one bounded step (${reducedMotion.nextWindow})`);

    assert.deepEqual(pageErrors, [], 'Rally tactical page has no browser errors');
    console.log('✓ Rally tactical field: six captains, dynamic scale, centered full frame, 320–430px');
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
