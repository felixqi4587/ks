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
const room = makeQaRoom('march-domain');
const url = qaRoomUrl(base, room, { notour: 1, lang: 'en' });
const password = 'march-domain-password';
const players = [
  { pid: '830000001', name: 'Thirty', march: 30, profileKey: '83000000-0000-4000-8000-000000000001' },
  { pid: '830000002', name: 'Sixty', march: 60, profileKey: '83000000-0000-4000-8000-000000000002' },
  { pid: '830000003', name: 'One Twenty', march: 120, profileKey: '83000000-0000-4000-8000-000000000003' }
];

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function sendMessages(page, messages) {
  assertQaRoomName(room);
  await page.evaluate(({ roomName, payloads }) => new Promise((resolve, reject) => {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}/api/ws?room=${encodeURIComponent(roomName)}`);
    const timer = setTimeout(() => reject(new Error('QA WebSocket timeout')), 5000);
    socket.onopen = () => {
      payloads.forEach(payload => socket.send(JSON.stringify(payload)));
      setTimeout(() => { clearTimeout(timer); socket.close(); resolve(); }, 400);
    };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('QA WebSocket failed')); };
  }), { roomName: room, payloads: messages });
}

async function readRoom(page) {
  assertQaRoomName(room);
  return page.evaluate(roomName => new Promise((resolve, reject) => {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}/api/ws?room=${encodeURIComponent(roomName)}`);
    const timer = setTimeout(() => reject(new Error('QA room snapshot timeout')), 5000);
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data));
      if (message.t !== 'state') return;
      clearTimeout(timer);
      socket.close();
      resolve(message.room);
    };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('QA room snapshot failed')); };
  }), room);
}

async function laneRows(page) {
  return page.locator('#lanes .lane').evaluateAll(rows => rows.map(row => ({
    name: (row.querySelector('.lname')?.textContent || '').trim(),
    dotLeft: Number.parseFloat(row.querySelector('.ldot')?.style.left || 'NaN'),
    time: (row.querySelector('.ltimev')?.textContent || '').trim(),
    live: row.querySelector('.ltrack')?.classList.contains('live') === true,
    hasLegacyGatherBand: row.querySelector('.gband, .ldot.tgt') !== null
  })));
}

function rowNamed(rows, name) {
  const row = rows.find(candidate => candidate.name.includes(name));
  assert.ok(row, `lane for ${name} exists`);
  return row;
}

function assertApprox(actual, expected, label, tolerance = 0.12) {
  assert.ok(Number.isFinite(actual), `${label} is numeric`);
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected.toFixed(2)}%, received ${actual.toFixed(2)}%`);
}

(async () => {
  console.log(`QA room: ${room}`);
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({
    viewport: { width: 390, height: 1100 },
    locale: 'en-US',
    timezoneId: 'UTC'
  });
  const clientMarchMutations = [];
  const pageErrors = [];
  const requirementFailures = [];
  const check = async (label, run) => {
    try { await run(); }
    catch (error) {
      const detail = `${label}: ${error.message}`;
      requirementFailures.push(detail);
      console.error(`REQUIREMENT FAIL ${detail}`);
    }
  };

  try {
    await installQaWebSocketGuard(context, room, {
      expectedOrigin: base,
      shouldDropClientMessage({ data }) {
        try {
          const message = JSON.parse(String(data));
          if (message.t === 'setPlayerMarch') clientMarchMutations.push(message);
        } catch (_) {}
        return false;
      }
    });

    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    await check('player slider maximum', async () => {
      assert.equal(await page.locator('#marchRange').getAttribute('max'), '120');
    });
    await check('English one-sentence battle hint', async () => {
      assert.equal((await page.locator('#marchTip').textContent()).trim(),
        'Battle tip: if you will use a pet march-speed buff, activate it before measuring.');
    });

    await sendMessages(page, [
      { t: 'setConfig', password, config: { castleName: '', rallyAllies: [], enemyWhales: [] }, by: 'march-domain-bootstrap' },
      ...players.map(player => ({
        t: 'registerPlayer', pid: player.pid, name: player.name, march: player.march,
        identityMode: 'playerId', alliance: '', profileKey: player.profileKey
      })),
      { t: 'stage', password, staged: { kingdom: 1, modeRevision: 0, pairs: [
        { pid: players[0].pid, role: 'weak' },
        { pid: players[1].pid, role: 'main' }
      ] } },
      { t: 'stage', password, staged: { kingdom: 2, modeRevision: 0, pairs: [
        { pid: players[2].pid, role: 'weak' }
      ] } }
    ]);
    await page.waitForFunction(() => document.querySelectorAll('#lanes .lane').length === 3);

    let rows = await laneRows(page);
    assertApprox(rowNamed(rows, 'Thirty').dotLeft, 25, '30-second idle position');
    assertApprox(rowNamed(rows, 'Sixty').dotLeft, 50, '60-second idle position');
    assertApprox(rowNamed(rows, 'One Twenty').dotLeft, 96, '120-second bounded idle endpoint');

    await page.locator('#soundGate').click();
    await page.locator('#cmdUnlock').click();
    await page.locator('#pwInput').fill(password);
    await page.locator('#pwGo').click();
    await page.locator('#console').waitFor({ state: 'visible' });
    await page.locator('#commanderManageOpen').click();
    await page.locator('#commanderManagePane').waitFor({ state: 'visible' });

    for (const player of players) {
      await page.locator(`#roster .roster-time[data-pid="${player.pid}"]`).click();
      await page.locator('#commanderMarchEditor').waitFor({ state: 'visible' });
      const expectedDraft = `${Math.floor(player.march / 60)}:${String(player.march % 60).padStart(2, '0')}`;
      assert.equal(await page.locator('#commanderMarchInput').inputValue(), expectedDraft);
      await page.locator('#commanderMarchCancel').click();
      await page.locator('#commanderMarchEditor').waitFor({ state: 'hidden' });
    }

    const maxPlayer = players[2];
    await page.locator(`#roster .roster-time[data-pid="${maxPlayer.pid}"]`).click();
    await page.locator('#commanderMarchInput').fill('2:00');
    const beforeMaxSave = clientMarchMutations.length;
    await page.locator('#commanderMarchSave').click();
    await page.locator('#commanderMarchEditor').waitFor({ state: 'hidden' });
    assert.equal(clientMarchMutations.length, beforeMaxSave + 1, '2:00 sends one successful mutation');
    assert.equal(clientMarchMutations.at(-1).march, 120);
    await page.locator(`#roster .roster-time[data-pid="${maxPlayer.pid}"]`).filter({ hasText: '2:00' }).waitFor();

    await page.locator(`#roster .roster-time[data-pid="${maxPlayer.pid}"]`).click();
    await page.locator('#commanderMarchInput').fill('2:01');
    const beforeInvalid = clientMarchMutations.length;
    await page.locator('#commanderMarchSave').click();
    await delay(500);
    await check('2:01 localized invalid message', async () => {
      assert.equal((await page.locator('#commanderMarchStatus').textContent()).trim(),
        'Enter 0:05–2:00 (5–120 seconds)');
      assert.equal(await page.locator('#commanderMarchInput').getAttribute('aria-invalid'), 'true');
    });
    await check('2:01 sends no successful mutation', async () => {
      assert.equal(clientMarchMutations.length, beforeInvalid);
    });
    if (await page.locator('#commanderMarchEditor').isVisible()) {
      await page.locator('#commanderMarchCancel').click();
      await page.locator('#commanderMarchEditor').waitFor({ state: 'hidden' });
    }

    await page.locator(`#roster .roster-time[data-pid="${maxPlayer.pid}"]`).click();
    await page.locator('#commanderMarchInput').fill('1:30');
    const beforeScaleSave = clientMarchMutations.length;
    await page.locator('#commanderMarchSave').click();
    await page.locator('#commanderMarchEditor').waitFor({ state: 'hidden' });
    assert.equal(clientMarchMutations.length, beforeScaleSave + 1, 'the valid 1:30 scale probe sends one mutation');
    assert.equal(clientMarchMutations.at(-1).march, 90);
    await page.locator(`#roster .roster-time[data-pid="${maxPlayer.pid}"]`).filter({ hasText: '1:30' }).waitFor();

    rows = await laneRows(page);
    await check('idle map stays on the fixed 120-second scale after a valid shorter edit', async () => {
      assertApprox(rowNamed(rows, 'Thirty').dotLeft, 25, '30-second fixed idle position');
      assertApprox(rowNamed(rows, 'Sixty').dotLeft, 50, '60-second fixed idle position');
      assertApprox(rowNamed(rows, 'One Twenty').dotLeft, 75, '90-second fixed idle position');
    });

    await page.evaluate(() => window.setLang('zh'));
    await check('Chinese one-sentence battle hint', async () => {
      assert.equal((await page.locator('#marchTip').textContent()).trim(),
        '实战提示：如果你会使用宠物行军速度增益，请在测量前先开启。');
    });
    await page.evaluate(() => window.setLang('en'));

    const firstPress = Math.floor(Date.now() / 1000) + 120;
    await sendMessages(page, [{
      t: 'cmd', password,
      cmd: {
        type: 'double_rally', kingdom: 1, anchorUTC: firstPress, payload: {
          firstPress, kingdom: 1,
          pairs: [
            { pid: players[0].pid, role: 'weak', march: players[0].march, pressUTC: firstPress + 29 },
            { pid: players[1].pid, role: 'main', march: players[1].march, pressUTC: firstPress }
          ]
        }
      }
    }]);
    await page.locator('#lanes .ltrack.live').first().waitFor();

    const canonicalRoom = await readRoom(page);
    const command = canonicalRoom.live.commands['1'];
    assert.ok(command && command.payload && command.payload.pairs.length === 2, 'valid command is canonical');
    const canonicalPairs = command.payload.pairs;
    rows = await laneRows(page);

    for (const player of players.slice(0, 2)) {
      const pair = canonicalPairs.find(candidate => candidate.pid === player.pid);
      assert.ok(pair, `canonical pair for ${player.name} exists`);
      assert.equal(pair.march, player.march, `${player.name} keeps the canonical march`);
      const row = rowNamed(rows, player.name);
      const expectedDistance = Math.min(96, pair.march / 120 * 100);
      assertApprox(row.dotLeft, expectedDistance, `${player.name} fixed 2:00 live distance`, 0.02);
      assert.equal(row.time, `${Math.floor(pair.march / 60)}:${String(pair.march % 60).padStart(2, '0')}`,
        `${player.name} keeps exact M:SS`);
      assert.equal(row.live, true, `${player.name} exposes the live progress bar`);
      assert.equal(row.hasLegacyGatherBand, false, `${player.name} no longer switches to the five-minute ruler`);
    }

    const firstLivePositions = rows.map(row => row.dotLeft);
    await delay(350);
    const secondLivePositions = (await laneRows(page)).map(row => row.dotLeft);
    assert.deepEqual(secondLivePositions, firstLivePositions,
      'markers remain at departure while the future rally is staged or gathering');

    const field = await page.evaluate(() => ({
      scale: document.querySelector('#mapScaleLabel')?.textContent || '',
      routes: [...document.querySelectorAll('#radar .rally-route')].map(route => ({
        x1: Number(route.getAttribute('x1')),
        y1: Number(route.getAttribute('y1')),
        x2: Number(route.getAttribute('x2')),
        y2: Number(route.getAttribute('y2'))
      })),
      overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth
    }));
    assert.match(field.scale, /1:38/, 'the 90-second selected maximum uses about 8% field headroom');
    assert.equal(field.routes.length, 3, 'both live captains and the other kingdom staged captain stay visible');
    assert.ok(field.routes.every(route => route.x1 === 180 && route.y1 === 135),
      'every route uses the centered castle and the full frame');
    assert.ok(field.routes.some(route => route.y2 < 100) && field.routes.some(route => route.y2 > 170),
      'kingdom/role angles use both upper and lower field space');
    assert.ok(field.overflow <= 1, 'the tactical page has no horizontal overflow');

    assert.deepEqual(pageErrors, [], 'no browser page errors');
    if (requirementFailures.length) {
      assert.fail(`march-domain requirements failed:\n- ${requirementFailures.join('\n- ')}`);
    }
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
