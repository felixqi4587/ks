require('./support/legacy-kvk-script-guard.cjs')(__filename);
const { chromium } = require("playwright");
(async () => {
  const RM = "s" + Date.now(), base = "https://kingshoter.com/kvk.html?k=test&room=" + RM;
  const b = await chromium.launch({ headless: true, channel: "chrome" });
  const dis = async p => { try { if (await p.locator("#obGo").isVisible()) await p.locator("#obGo").click(); } catch (e) {} };
  const mk = async (fid, preset) => { const p = await (await b.newContext({ viewport: { width: 390, height: 1000 }, deviceScaleFactor: 2, locale: "en-US" })).newPage(); await p.goto(base); await p.waitForLoadState("networkidle"); await dis(p); await p.locator("#pid").fill(fid); await p.waitForTimeout(1700); await p.locator('#marchPresets button[data-v="' + preset + '"]').click(); await p.locator("#saveBtn").click(); await p.waitForTimeout(800); return p; };
  const cmd = await (await b.newContext({ viewport: { width: 390, height: 1100 }, deviceScaleFactor: 2, locale: "en-US" })).newPage();
  await cmd.goto(base); await cmd.waitForLoadState("networkidle"); await dis(cmd);
  await cmd.locator("#cmdFold > summary").click();
  await cmd.locator("#cmdUnlock").click(); await cmd.locator("#pwInput").fill("pw"); await cmd.locator("#pwGo").click(); await cmd.waitForTimeout(1000);
  const p1 = await mk("207573838", "90"), p2 = await mk("999999999", "75"); await cmd.waitForTimeout(700);
  await cmd.locator('#kingdomPick button[data-k="2"]').click();
  await cmd.locator("#roster .rp").nth(0).click(); await cmd.locator("#roster .rp").nth(1).click();
  await cmd.locator("#cmdBody").screenshot({ path: "test/journey/v2-console.png" });
  // alerts bar (player view)
  await p1.locator(".alertrow").screenshot({ path: "test/journey/v2-alerts.png" });
  // marching map via sim (short timings)
  await cmd.locator("#simStart").click();
  await p1.waitForTimeout(14000);   // mid-march of sim step 1 (kingdom 1)
  await p1.locator(".pond").screenshot({ path: "test/journey/v2-map-march.png" });
  await cmd.locator("#simStop").click();
  await b.close(); console.log("shots saved");
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
