require('./support/legacy-kvk-script-guard.cjs')(__filename);
const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch({ headless: true, channel: "chrome" });
  const p = await (await b.newContext({ viewport: { width: 390, height: 900 }, locale: "en-US" })).newPage();
  await p.goto("https://kingshoter.com/kvk.html?k=test&room=d" + Date.now()); await p.waitForLoadState("networkidle"); await p.waitForTimeout(1200);
  try { if (await p.locator("#obGo").isVisible()) await p.locator("#obGo").click(); } catch (e) {}
  await p.waitForTimeout(400);
  const r = await p.evaluate(() => {
    var on = [...document.querySelectorAll("#alertMode button")].map(b => b.textContent.trim() + (b.classList.contains("on") ? "[ON]" : ""));
    var sel = document.getElementById("voiceLang");
    return { mode: localStorage.getItem("kingshoter_alertMode"), buttons: on, selDisplay: sel ? getComputedStyle(sel).display : "none", selValue: sel ? sel.value : null, selW: sel ? sel.offsetWidth : 0, selOpts: sel ? sel.options.length : 0 };
  });
  console.log(JSON.stringify(r));
  await b.close();
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
