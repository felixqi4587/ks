const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch({ headless: true, channel: "chrome" });
  const p = await (await b.newContext({ viewport: { width: 390, height: 1400 }, deviceScaleFactor: 2 })).newPage();
  const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.goto("https://kingshoter.com/guide.html"); await p.waitForLoadState("networkidle"); await p.waitForTimeout(1800);
  console.log("terms:", await p.locator(".term").count(), "| pageerrors:", errs.length ? errs.join(" | ") : "none");
  await p.locator(".term").nth(3).scrollIntoViewIfNeeded(); await p.waitForTimeout(900);
  await p.locator(".term").nth(3).screenshot({ path: "test/journey/g3-counter.png" });
  await p.locator(".term").nth(4).scrollIntoViewIfNeeded(); await p.waitForTimeout(2200);
  await p.locator(".term").nth(4).screenshot({ path: "test/journey/g3-enemycounter.png" });
  await b.close(); console.log("shots saved");
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
