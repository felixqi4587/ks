const { chromium } = require("playwright");
const IUA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
(async () => {
  const b = await chromium.launch({ headless: true, channel: "chrome" });
  const p = await (await b.newContext({ userAgent: IUA, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
  await p.goto("https://kingshoter.com/kvk.html?k=test&room=iosshot" + Date.now()); await p.waitForLoadState("networkidle"); await p.waitForTimeout(900);
  try { if (await p.locator("#obGo").isVisible()) await p.locator("#obGo").click(); } catch (e) {}
  await p.waitForTimeout(500);
  // capture the pip row + hint region
  const box = await p.locator("#pipHint").boundingBox();
  await p.screenshot({ path: "test/journey/ios-piphint.png", clip: { x: 0, y: Math.max(0, box.y - 60), width: 390, height: 150 } });
  await b.close(); console.log("shot saved");
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
