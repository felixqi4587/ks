const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch({ headless: true, channel: "chrome" });
  const p = await (await b.newContext({ locale: "en-US" })).newPage();
  await p.goto("https://kingshoter.com/codes.html"); await p.waitForLoadState("networkidle"); await p.waitForTimeout(1500);
  console.log("note:", (await p.locator("#redeemNote").textContent() || "").trim());
  console.log("first code btn:", (await p.locator("#list .code button").first().textContent() || "").trim());
  console.log("code count:", await p.locator("#list .code").count());
  console.log("events link in nav:", await p.locator('a[href="events.html"]').count());
  await b.close();
})().catch(e => console.error("ERR", e.message));
