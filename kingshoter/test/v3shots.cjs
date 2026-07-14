const { chromium } = require("playwright");
(async () => {
  const RM = "ks" + Date.now(), base = "https://kingshoter.com/kvk.html?k=test&room=" + RM;
  const b = await chromium.launch({ headless: true, channel: "chrome" });
  const dis = async p => { try { if (await p.locator("#obGo").isVisible()) await p.locator("#obGo").click(); } catch (e) {} };
  const mk = async (fid, preset) => { const p = await (await b.newContext({ viewport: { width: 390, height: 900 }, locale: "en-US" })).newPage(); await p.goto(base); await p.waitForLoadState("networkidle"); await dis(p); await p.locator("#pid").fill(fid); await p.waitForTimeout(1600); await p.locator('#marchPresets button[data-v="' + preset + '"]').click(); await p.locator("#saveBtn").click(); await p.waitForTimeout(700); return p; };
  const cmd = await (await b.newContext({ viewport: { width: 390, height: 1100 }, deviceScaleFactor: 2, locale: "en-US" })).newPage();
  await cmd.goto(base); await cmd.waitForLoadState("networkidle"); await dis(cmd);
  await cmd.locator("#cmdFold > summary").click();
  await cmd.locator("#cmdUnlock").click(); await cmd.locator("#pwInput").fill("pw"); await cmd.locator("#pwGo").click(); await cmd.waitForTimeout(1000);
  await mk("207573838", "90"); await mk("999999999", "75"); await mk("123456789", "60"); await cmd.waitForTimeout(800);
  // K1: pick first two, then switch to K2 to show them locked
  await cmd.locator("#roster .rp").nth(0).click(); await cmd.locator("#roster .rp").nth(1).click();
  await cmd.locator('#kingdomPick button[data-k="2"]').click(); await cmd.waitForTimeout(300);
  await cmd.locator("#cmdBody").screenshot({ path: "test/journey/v3-kingdom2.png" });
  await b.close(); console.log("shot saved");
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
