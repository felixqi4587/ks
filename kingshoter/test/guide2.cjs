const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch({ headless: true, channel: "chrome" });
  const p = await (await b.newContext({ viewport: { width: 390, height: 1400 }, deviceScaleFactor: 2 })).newPage();
  const errs = []; p.on("console", m => { if (m.type() === "error") errs.push(m.text()); }); p.on("pageerror", e => errs.push("PAGEERR " + e.message));
  await p.goto("https://kingshoter.com/guide.html"); await p.waitForLoadState("networkidle"); await p.waitForTimeout(2000);
  console.log("legend circles+polys:", await p.locator("#legend circle, #legend polygon").count());
  console.log("term cards:", await p.locator(".term").count(), "| svg actors:", await p.locator(".term circle, .term polygon").count());
  console.log("errors:", errs.filter(e=>!/favicon|vibrate/.test(e)).join(" | ") || "none");
  // legend card
  await p.locator("#legend").screenshot({ path: "test/journey/g2-legend.png" });
  // double-rally mid-flight
  await p.locator(".term").nth(2).scrollIntoViewIfNeeded(); await p.waitForTimeout(900);
  await p.locator(".term").nth(2).screenshot({ path: "test/journey/g2-double.png" });
  // counter
  await p.locator(".term").nth(3).scrollIntoViewIfNeeded(); await p.waitForTimeout(700);
  await p.locator(".term").nth(3).screenshot({ path: "test/journey/g2-counter.png" });
  await b.close(); console.log("shots saved");
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
