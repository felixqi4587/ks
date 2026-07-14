const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch({ headless: true, channel: "chrome" });
  const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
  await p.goto("https://kingshoter.com/kvk.html?k=test&room=shot" + Date.now()); await p.waitForLoadState("networkidle"); await p.waitForTimeout(1200);
  try { if (await p.locator("#obGo").isVisible()) await p.locator("#obGo").click(); } catch (e) {}
  await p.locator("#pid").fill("207573838"); await p.waitForTimeout(1600);
  await p.locator('#marchPresets button[data-v="120"]').click(); await p.waitForTimeout(300);
  await p.locator("#fillCard").screenshot({ path: "test/journey/march-slider.png" });
  // tour spotlight
  await p.locator("#howBtn").click(); await p.waitForTimeout(400); await p.locator("#obTour").click(); await p.waitForTimeout(900);
  await p.screenshot({ path: "test/journey/tour.png" });
  await b.close(); console.log("shots saved");
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
