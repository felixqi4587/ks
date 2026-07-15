const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch({ headless: true, channel: "chrome" });
  const p = await (await b.newContext({ viewport: { width: 390, height: 900 }, locale: "en-US" })).newPage();
  const errs = []; p.on("pageerror", e => errs.push("PAGEERR " + e.message)); p.on("console", m => { if (m.type() === "error") errs.push("CONSOLE " + m.text()); });
  await p.goto("https://kingshoter.com/kvk.html?k=test&room=z" + Date.now()); await p.waitForLoadState("networkidle"); await p.waitForTimeout(1500);
  try { if (await p.locator("#obGo").isVisible()) await p.locator("#obGo").click(); } catch (e) {}
  await p.waitForTimeout(500);
  console.log("marchPresets buttons:", await p.locator("#marchPresets button").count());
  console.log("voicePickRow exists:", await p.locator("#voicePickRow").count());
  console.log("errors:", errs.length ? errs.join(" || ") : "none");
  await b.close();
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
