require('./support/legacy-kvk-script-guard.cjs')(__filename);
const { chromium } = require("playwright");
(async () => {
  const RM = "f" + Date.now(); const base = "https://kingshoter.com/kvk.html?k=test&room=" + RM;
  const b = await chromium.launch({ headless: true, channel: "chrome" });
  let pass = 0, fail = 0; const ok = (c, l) => { (c ? pass++ : fail++); console.log((c ? "✓" : "✗ FAIL") + " " + l); };
  const dis = async p => { try { if (await p.locator("#obGo").isVisible()) await p.locator("#obGo").click(); } catch (e) {} };
  const mk = async (fid, preset) => {
    const p = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await p.goto(base); await p.waitForLoadState("networkidle"); await dis(p);
    await p.locator("#pid").fill(fid); await p.waitForTimeout(1700);
    await p.locator('#marchPresets button[data-v="' + preset + '"]').click();
    await p.locator("#saveBtn").click(); await p.waitForTimeout(900);
    return p;
  };
  // commander
  const cmd = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await cmd.goto(base); await cmd.waitForLoadState("networkidle"); await dis(cmd);
  await cmd.locator("#cmdFold > summary").click();
  await cmd.locator("#cmdUnlock").click(); await cmd.locator("#pwInput").fill("pw"); await cmd.locator("#pwGo").click(); await cmd.waitForTimeout(1200);
  ok(await cmd.locator("#cmdBody").isVisible(), "commander unlocked");
  // players via slider presets (NO typing of march)
  const p1 = await mk("207573838", "90"), p2 = await mk("999999999", "75");
  ok((await p1.locator("#marchLbl").textContent()).trim() === "1:30", "march slider/preset sets time (no typing)");
  await cmd.waitForTimeout(800);
  ok(await cmd.locator("#roster .rp").count() >= 2, "roster shows 2 players");
  // double rally per-captain
  await cmd.locator("#roster .rp").nth(0).click(); await cmd.locator("#roster .rp").nth(1).click();
  await cmd.locator("#fireDouble").click(); await p1.waitForTimeout(1200);
  ok(await p1.locator("#banner").evaluate(e => e.classList.contains("mine")), "captain sees personal double-rally banner");
  const c1 = (await p1.locator("#bCd").textContent() || "").trim(), c2 = (await p2.locator("#bCd").textContent() || "").trim();
  ok(c1 !== c2, "captains' launch times differ (1s-offset, p1=" + c1 + " p2=" + c2 + ")");
  await cmd.locator('[data-cmd="cancel"]').click(); await p1.waitForTimeout(600);
  // simulator
  await cmd.locator("#simStart").click(); await p1.waitForTimeout(7000);
  ok(await p1.locator("#banner").evaluate(e => e.classList.contains("show")), "simulator broadcasts a banner to players");
  await cmd.locator("#simStop").click();
  // Driver.js guided tour
  await p2.locator("#howBtn").click(); await p2.waitForTimeout(400);
  await p2.locator("#obTour").click(); await p2.waitForTimeout(800);
  ok(await p2.locator(".driver-popover").count() > 0, "Driver.js spotlight tour launches");
  await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
