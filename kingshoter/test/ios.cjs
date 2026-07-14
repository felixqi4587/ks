const { chromium } = require("playwright");
const IUA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
(async () => {
  const b = await chromium.launch({ headless: true, channel: "chrome" });
  let pass = 0, fail = 0; const ok = (c, l) => { (c ? pass++ : fail++); console.log((c ? "✓" : "✗ FAIL") + " " + l); };
  const errs = [];
  const load = async (ua) => {
    const ctx = await b.newContext(ua ? { userAgent: ua, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 390, height: 900 } });
    const p = await ctx.newPage(); p.on("pageerror", e => errs.push((ua ? "ios:" : "desk:") + e.message));
    await p.goto("https://kingshoter.com/kvk.html?k=test&room=ios" + Date.now()); await p.waitForLoadState("networkidle"); await p.waitForTimeout(800);
    try { if (await p.locator("#obGo").isVisible()) await p.locator("#obGo").click(); } catch (e) {}
    await p.waitForTimeout(300); return p;
  };
  const ip = await load(IUA);
  ok(await ip.locator("#pipHint").evaluate(e => getComputedStyle(e).display !== "none"), "iPhone: float-timer hint shown");
  ok(/iPhone/.test(await ip.locator("#pipHint").textContent() || ""), "iPhone: hint mentions iPhone backgrounding");
  ok(await ip.locator("#pipBtn").evaluate(e => e.classList.contains("rec")), "iPhone: float-timer button highlighted (pulse)");
  ok(/iPhone|推荐|★/.test(await ip.locator("#pipBtn").textContent() || ""), "iPhone: button relabeled as recommended");
  // tapping pip stops the nag
  await ip.locator("#pipBtn").click(); await ip.waitForTimeout(300);
  ok(await ip.locator("#pipHint").evaluate(e => getComputedStyle(e).display === "none"), "iPhone: hint hides after using float timer");
  const dk = await load(null);
  ok(await dk.locator("#pipHint").evaluate(e => getComputedStyle(e).display === "none"), "Desktop: no iPhone hint");
  ok(await dk.locator("#pipBtn").evaluate(e => !e.classList.contains("rec")), "Desktop: float-timer not force-highlighted");
  ok(errs.length === 0, "no page errors" + (errs.length ? " → " + errs.join(" | ") : ""));
  await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
