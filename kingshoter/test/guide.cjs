const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch({ headless: true, channel: "chrome" });
  const p = await (await b.newContext({ viewport: { width: 390, height: 900 }, deviceScaleFactor: 2 })).newPage();
  const errs = []; p.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
  await p.goto("https://kingshoter.com/guide.html"); await p.waitForLoadState("networkidle"); await p.waitForTimeout(2500);
  const terms = await p.locator(".term").count();
  const svgs = await p.locator(".term svg circle").count();
  console.log("terms:", terms, "| animated dots total:", svgs);
  console.log("console errors:", errs.filter(e=>!/vibrate|404/.test(e)).join(" | ") || "none");
  // scroll to double-rally term + capture mid-anim
  await p.locator(".term").nth(2).scrollIntoViewIfNeeded(); await p.waitForTimeout(1200);
  await p.screenshot({ path: "test/journey/guide.png" });
  await b.close();
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
