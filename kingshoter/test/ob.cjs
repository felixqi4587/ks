require('./support/legacy-kvk-script-guard.cjs')(__filename);
const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  const errs = []; p.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
  await p.goto("https://kingshoter.com/kvk.html?k=1406&room=demo"); await p.waitForLoadState("networkidle");
  await p.waitForTimeout(2600); // into beat 2 (unit marching, timer visible)
  await p.screenshot({ path: "test/journey/3-onboarding.png" });
  const cap = await p.locator("#obCap").textContent();
  const unitTf = await p.locator("#obUnit").getAttribute("transform");
  const timerOp = await p.locator("#obTimer").getAttribute("opacity");
  console.log("caption:", (cap||"").trim());
  console.log("unit transform:", unitTf, "| timer opacity:", timerOp);
  console.log("console errors:", errs.length ? errs.join(" | ") : "none");
  await browser.close();
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
