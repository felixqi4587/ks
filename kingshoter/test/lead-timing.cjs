const { chromium } = require('playwright');

(async () => {
  const host = process.argv[2] || 'http://127.0.0.1:8800';
  const room = `personal${Date.now()}`;
  const url = `${host}/kvk.html?room=${room}&notour=1`;
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--autoplay-policy=no-user-gesture-required']
  });
  let pass = 0;
  let fail = 0;
  const errors = [];
  const ok = (condition, label) => {
    condition ? pass++ : fail++;
    console.log(`${condition ? '✓' : '✗ FAIL'} ${label}`);
  };

  const openPage = async (label) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 1200 }, locale: 'en-US' });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`));
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    await page.keyboard.press('Escape').catch(() => {});
    await page.locator('#soundGate').click({ force: true }).catch(() => {});
    await page.waitForTimeout(150);
    return page;
  };

  const addCaptain = async (fid, march) => {
    const page = await openPage(fid);
    await page.locator('#pid').fill(fid);
    await page.waitForTimeout(1700);
    await page.locator('#marchRange').fill(String(march));
    await page.locator('#saveBtn').click();
    await page.waitForTimeout(650);
    return page;
  };

  const installPersonalProbe = async (page) => page.evaluate(() => {
    window.__countTrace = [];
    window.__sayTrace = [];
    window.__waitTitles = [];
    let lastNumber = null;
    let lastSay = String(window.__say || '');
    let lastWaitTitle = '';
    const readNumber = (text) => {
      const raw = String(text || '').trim();
      if (/^\d+$/.test(raw)) return Number(raw);
      const mmss = /^(\d+):(\d+)$/.exec(raw);
      return mmss ? Number(mmss[1]) * 60 + Number(mmss[2]) : NaN;
    };
    const sample = () => {
      const hero = document.querySelector('#phero');
      const title = String(document.querySelector('#pheroTitle')?.textContent || '').trim();
      if (/waiting|等待/i.test(title) && title !== lastWaitTitle) {
        lastWaitTitle = title;
        window.__waitTitles.push(title);
      }
      const number = readNumber(document.querySelector('#pheroNum')?.textContent);
      if (!hero || hero.classList.contains('hide') || !Number.isFinite(number) || number === lastNumber) return;
      lastNumber = number;
      window.__countTrace.push({ value: number, serverMs: window.serverNow() });
    };
    new MutationObserver(sample).observe(document.querySelector('#phero'), {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true
    });
    window.__sayProbe = setInterval(() => {
      const text = String(window.__say || '');
      if (text && text !== lastSay) {
        lastSay = text;
        window.__sayTrace.push({ text, serverMs: window.serverNow() });
      }
    }, 20);
    sample();
  });

  const weakPid = '900000001';
  const mainPid = '900000002';
  const weakMarch = 60;
  const mainMarch = 65;
  const selectedLead = Number(process.argv[3] || 10);
  if (![10, 15, 30, 60].includes(selectedLead)) throw new Error(`unsupported lead option: ${selectedLead}`);
  const weakPage = await addCaptain(weakPid, weakMarch);
  const mainPage = await addCaptain(mainPid, mainMarch);
  await installPersonalProbe(weakPage);
  await installPersonalProbe(mainPage);
  const commander = await openPage('commander');

  await commander.locator('#cmdUnlock').click();
  await commander.locator('#pwInput').fill('personal-timing-password');
  await commander.locator('#pwGo').click();
  await commander.waitForTimeout(1800);
  await commander.locator(`#roster .rp:has-text("${weakPid}")`).first().click();
  await commander.waitForTimeout(150);
  await commander.locator(`#roster .rp:has-text("${mainPid}")`).first().click();
  await commander.locator(`#lead button[data-v="${selectedLead}"]`).click();

  await commander.evaluate(() => {
    window.__fireClickTimes = [];
    document.addEventListener('click', (event) => {
      if (event.target && event.target.closest && event.target.closest('#fireDouble')) {
        window.__fireClickTimes.push(window.serverNow());
      }
    }, true);
  });

  await commander.locator('#fireDouble').click();
  await commander.waitForFunction(() => {
    const phase = window.serverNow() % 1000;
    return phase >= 850 && phase <= 950;
  }, null, { timeout: 3000 });
  await commander.locator('#fireDouble').click();

  await Promise.all([
    weakPage.waitForFunction((lead) => window.__countTrace.some((entry) => entry.value === lead), selectedLead, { timeout: 9000 }),
    mainPage.waitForFunction((lead) => window.__countTrace.some((entry) => entry.value === lead), selectedLead, { timeout: 9000 })
  ]);
  await weakPage.waitForTimeout(500);

  const snapshot = await commander.evaluate(async (roomName) => {
    const response = await fetch(`/api/ws?room=${encodeURIComponent(roomName)}`);
    return response.json();
  }, room);
  const command = snapshot.room.live.commands['1'];
  const pairs = command.payload.pairs;
  const weak = pairs.find((pair) => pair.pid === weakPid);
  const main = pairs.find((pair) => pair.pid === mainPid);
  const confirmedMs = await commander.evaluate(() => window.__fireClickTimes[1]);
  const earliestPress = Math.min(weak.pressUTC, main.pressUTC);
  const expectedStagger = Math.abs(mainMarch - weakMarch - 1);

  const readPersonalState = async (page) => page.evaluate(() => ({
    countTrace: window.__countTrace.slice(),
    sayTrace: window.__sayTrace.slice(),
    waitTitles: window.__waitTitles.slice(),
    cues: Object.entries(window.__cues || {}).map(([key, cue]) => ({
      key,
      targetMs: cue.t,
      nodes: (cue.nodes || []).length
    }))
  }));
  const weakState = await readPersonalState(weakPage);
  const mainState = await readPersonalState(mainPage);
  const earlyPair = weak.pressUTC < main.pressUTC ? weak : main;
  const latePair = weak.pressUTC < main.pressUTC ? main : weak;
  const earlyState = earlyPair.pid === weakPid ? weakState : mainState;
  const lateState = latePair.pid === weakPid ? weakState : mainState;
  const spokenNumbers = (state) => state.sayTrace.map((entry) => {
    const match = /(?:还有|in)\s*(\d+)/i.exec(entry.text);
    return match ? Number(match[1]) : NaN;
  }).filter(Number.isFinite);
  const cueAt = (state, seconds) => state.cues.find((cue) => cue.key.endsWith(`-me:${seconds}`));

  ok(command.payload.leadSeconds === selectedLead,
    'the selected lead is preserved in the command payload');
  ok(earliestPress * 1000 - confirmedMs >= selectedLead * 1000 - 250
      && earliestPress * 1000 - confirmedMs <= selectedLead * 1000 + 250,
    `lead ${selectedLead} means a full ${selectedLead}-second delay after final confirmation`);
  ok(Math.abs(Math.abs(weak.pressUTC - main.pressUTC) - expectedStagger) < 0.001,
    `captain launch targets retain the ${expectedStagger}s march-difference stagger`);
  ok(Math.abs((main.pressUTC + 300 + mainMarch) - (weak.pressUTC + 300 + weakMarch) - 1) < 0.001,
    'main still lands one second after sacrifice');

  ok(earlyState.countTrace[0] && earlyState.countTrace[0].value === selectedLead,
    `earliest captain visible countdown starts at ${selectedLead}`);
  ok(lateState.countTrace[0] && lateState.countTrace[0].value === selectedLead,
    `later captain visible countdown starts at its own ${selectedLead}`);
  ok(lateState.countTrace.every((entry) => entry.value <= selectedLead),
    `later captain never sees a numeric countdown above ${selectedLead}`);
  ok(lateState.waitTitles.some((title) => title.includes(String(selectedLead))),
    `later captain waiting state confirms the selected ${selectedLead}-second lead`);
  ok(lateState.countTrace[0]
      && Math.abs(lateState.countTrace[0].serverMs - (latePair.pressUTC - selectedLead) * 1000) <= 450,
    `later countdown appears at personal T-${selectedLead} instead of being clamped early`);

  const earlySpeech = spokenNumbers(earlyState);
  const lateSpeech = spokenNumbers(lateState);
  ok(earlySpeech[0] === selectedLead, `earliest captain announcement says ${selectedLead} seconds`);
  ok(lateSpeech[0] === selectedLead && lateSpeech.every((value) => value <= selectedLead),
    `later captain is not told a larger number before personal T-${selectedLead}`);

  const earlyT10 = cueAt(earlyState, 10);
  const lateT10 = cueAt(lateState, 10);
  ok(earlyT10 && Math.abs(earlyT10.targetMs - (earlyPair.pressUTC - 10) * 1000) < 1,
    'earliest captain keeps the exact T-10 clock while the immediate announcement covers network arrival');
  ok(lateT10 && lateT10.nodes > 0 && Math.abs(lateT10.targetMs - (latePair.pressUTC - 10) * 1000) < 1,
    'later captain has an audible T-10 cue on the exact personal clock');
  const lateStartCue = cueAt(lateState, selectedLead);
  ok(selectedLead === 10
      ? !!(lateStartCue && lateStartCue.nodes > 0)
      : !!(lateStartCue && lateStartCue.nodes > 0
          && Math.abs(lateStartCue.targetMs - (latePair.pressUTC - selectedLead) * 1000) < 1),
    `later captain has an audible personal T-${selectedLead} countdown-start cue`);
  if (selectedLead !== 15) {
    ok(!cueAt(earlyState, 15) && !cueAt(lateState, 15),
      `lead ${selectedLead} does not schedule the obsolete fixed T-15 cue`);
  }
  ok(errors.length === 0, `no page errors${errors.length ? ` → ${errors.join(' | ')}` : ''}`);

  await Promise.race([browser.close(), new Promise((resolve) => setTimeout(resolve, 3000))]);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error('ERR', error.stack || error.message);
  process.exit(2);
});
