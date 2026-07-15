require('./support/legacy-kvk-script-guard.cjs')(__filename);
const { chromium } = require("playwright");
(async () => {
  const RM = "v" + Date.now(), base = "https://kingshoter.com/kvk.html?k=test&room=" + RM;
  const b = await chromium.launch({ headless: true, channel: "chrome" });
  let pass = 0, fail = 0; const ok = (c, l) => { (c ? pass++ : fail++); console.log((c ? "✓" : "✗ FAIL") + " " + l); };
  const errs = [];
  const dis = async p => { try { if (await p.locator("#obGo").isVisible()) await p.locator("#obGo").click(); } catch (e) {} };
  const mk = async (fid, preset) => {
    const p = await (await b.newContext({ viewport: { width: 390, height: 900 }, locale: "en-US" })).newPage();
    p.on("pageerror", e => errs.push(fid + ": " + e.message));
    await p.goto(base); await p.waitForLoadState("networkidle"); await dis(p);
    await p.locator("#pid").fill(fid); await p.waitForTimeout(1700);
    await p.locator('#marchPresets button[data-v="' + preset + '"]').click();
    await p.locator("#saveBtn").click(); await p.waitForTimeout(900); return p;
  };
  // commander
  const cmd = await (await b.newContext({ viewport: { width: 390, height: 900 }, locale: "en-US" })).newPage();
  cmd.on("pageerror", e => errs.push("cmd: " + e.message));
  await cmd.goto(base); await cmd.waitForLoadState("networkidle"); await dis(cmd);
  // settings controls present (everyone)
  ok(await cmd.locator("#alertMode button").count() === 2, "alerts: Voice/Beep toggle present");
  ok(await cmd.locator("#voiceLang").count() === 1, "alerts: voice language picker present");
  await cmd.locator("#cmdFold > summary").click();
  await cmd.locator("#cmdUnlock").click(); await cmd.locator("#pwInput").fill("pw"); await cmd.locator("#pwGo").click(); await cmd.waitForTimeout(1200);
  ok(await cmd.locator("#kingdomPick button").count() === 2, "kingdom selector present (2 kingdoms)");
  ok(await cmd.locator('[data-cmd="counter"]').count() === 0 && await cmd.locator('[data-cmd="refill"]').count() === 0 && await cmd.locator('#customTxt').count() === 0, "console trimmed: no counter/refill/custom");
  ok(await cmd.locator("#fireDouble").count() === 1, "console keeps double-rally");
  // players
  const p1 = await mk("207573838", "90"), p2 = await mk("999999999", "75");
  await cmd.waitForTimeout(700);
  // pick kingdom 2 + 2 captains + fire
  await cmd.locator('#kingdomPick button[data-k="2"]').click();
  await cmd.locator("#roster .rp").nth(0).click(); await cmd.locator("#roster .rp").nth(1).click();
  await cmd.locator("#fireDouble").click(); await p1.waitForTimeout(1500);
  const bt = (await p1.locator("#bTitle").textContent() || "");
  ok(/🌍|K2|Kingdom/.test(bt), "banner shows kingdom tag (" + bt.trim() + ")");
  const mapTxt = (await p1.locator("#map").textContent() || "");
  ok(/Kingdom 2/.test(mapTxt), "live map labels Kingdom 2");
  ok(/YOU/.test(mapTxt), "live map highlights YOU + role");
  ok(await p1.locator("#map circle").count() >= 4, "live map renders cars+castle (circles=" + await p1.locator("#map circle").count() + ")");
  const c1 = (await p1.locator("#bCd").textContent() || "").trim(), c2 = (await p2.locator("#bCd").textContent() || "").trim();
  ok(c1 !== c2, "per-captain countdowns differ (p1=" + c1 + " p2=" + c2 + ")");
  // onboarding context-aware (p1 already filled)
  await cmd.locator('[data-cmd="cancel"]').click(); await p1.waitForTimeout(400);
  await p1.locator("#howBtn").click(); await p1.waitForTimeout(400);
  const obGo = (await p1.locator("#obGo").textContent() || "");
  ok(/Already filled/.test(obGo), "onboarding says 'already filled' when filled (" + obGo.trim() + ")");
  // codes copy+redeem
  const cp = await (await b.newContext({ viewport: { width: 390, height: 900 }, locale: "en-US" })).newPage();
  await cp.goto("https://kingshoter.com/codes.html"); await cp.waitForLoadState("networkidle"); await cp.waitForTimeout(1200);
  const btn = (await cp.locator("#list .code button").first().textContent() || "");
  ok(/redeem/i.test(btn), "codes button = copy & redeem (" + btn.trim() + ")");
  const [popup] = await Promise.all([cp.waitForEvent("popup", { timeout: 5000 }).catch(() => null), cp.locator("#list .code button").first().click()]);
  ok(popup && /centurygame/.test(popup.url()), "codes click opens redeem tab (" + (popup ? popup.url() : "none") + ")");
  ok(errs.length === 0, "no page errors" + (errs.length ? " → " + errs.join(" | ") : ""));
  await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
