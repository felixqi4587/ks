require('./support/legacy-kvk-script-guard.cjs')(__filename);
const { chromium } = require("playwright");
(async () => {
  const RM = "k" + Date.now(), base = "https://kingshoter.com/kvk.html?k=test&room=" + RM;
  const b = await chromium.launch({ headless: true, channel: "chrome" });
  let pass = 0, fail = 0; const ok = (c, l) => { (c ? pass++ : fail++); console.log((c ? "✓" : "✗ FAIL") + " " + l); };
  const errs = [];
  const dis = async p => { try { if (await p.locator("#obGo").isVisible()) await p.locator("#obGo").click(); } catch (e) {} };
  const mk = async (fid, preset) => { const p = await (await b.newContext({ viewport: { width: 390, height: 900 }, locale: "en-US" })).newPage(); p.on("pageerror", e => errs.push(fid + ":" + e.message)); await p.goto(base); await p.waitForLoadState("networkidle"); await dis(p); await p.locator("#pid").fill(fid); await p.waitForTimeout(1700); await p.locator('#marchPresets button[data-v="' + preset + '"]').click(); await p.locator("#saveBtn").click(); await p.waitForTimeout(800); return p; };
  const cmd = await (await b.newContext({ viewport: { width: 390, height: 900 }, locale: "en-US" })).newPage();
  cmd.on("pageerror", e => errs.push("cmd:" + e.message));
  await cmd.goto(base); await cmd.waitForLoadState("networkidle"); await dis(cmd);
  await cmd.locator("#cmdFold > summary").click();
  await cmd.locator("#cmdUnlock").click(); await cmd.locator("#pwInput").fill("pw"); await cmd.locator("#pwGo").click(); await cmd.waitForTimeout(1000);
  // voice controls
  ok(await cmd.locator("#voicePickRow").isVisible(), "voice picker row visible (voice mode default)");
  ok(await cmd.locator("#voiceTest").count() === 1, "voice test button present");
  await mk("207573838", "90"); await mk("999999999", "75"); await cmd.waitForTimeout(700);
  // K1: pick both
  await cmd.locator("#roster .rp").nth(0).click(); await cmd.locator("#roster .rp").nth(1).click(); await cmd.waitForTimeout(200);
  ok(await cmd.locator("#roster .rp.sel").count() === 2, "K1: two captains selected");
  // switch to K2
  await cmd.locator('#kingdomPick button[data-k="2"]').click(); await cmd.waitForTimeout(200);
  ok(await cmd.locator("#roster .rp.sel").count() === 0, "K2: no carryover selection");
  ok(await cmd.locator("#roster .rp.otherk").count() === 2, "K2: both marked 'in other kingdom' (color)");
  // clicking a locked one is blocked
  await cmd.locator("#roster .rp.otherk").first().click(); await cmd.waitForTimeout(200);
  ok(await cmd.locator("#roster .rp.sel").count() === 0, "K2: clicking other-kingdom member does NOT select it");
  // back to K1 restores
  await cmd.locator('#kingdomPick button[data-k="1"]').click(); await cmd.waitForTimeout(200);
  ok(await cmd.locator("#roster .rp.sel").count() === 2, "back to K1: original picks restored");
  ok(errs.length === 0, "no page errors" + (errs.length ? " → " + errs.join(" | ") : ""));
  await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
