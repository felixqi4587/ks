const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch({ headless: true, channel: "chrome" });
  const p = await (await b.newContext({ viewport: { width: 390, height: 1400 }, locale: "en-US" })).newPage();
  const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.goto("https://kingshoter.com/guide.html"); await p.waitForLoadState("networkidle"); await p.waitForTimeout(1500);
  const h2a = (await p.locator(".term h2").first().textContent()||"").trim();
  await p.locator("#langtoggle button").first().click(); await p.waitForTimeout(1200);
  const h2b = (await p.locator(".term h2").first().textContent()||"").trim();
  console.log("before toggle term1:", h2a);
  console.log("after  toggle term1:", h2b);
  console.log("terms after toggle:", await p.locator(".term").count(), "| actors:", await p.locator(".term circle, .term polygon").count(), "| legend:", await p.locator("#legend circle, #legend polygon").count());
  console.log("pageerrors:", errs.length ? errs.join(" | ") : "none");
  await b.close();
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
