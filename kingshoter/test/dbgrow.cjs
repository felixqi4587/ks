const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch({ headless: true, channel: "chrome" });
  const p = await (await b.newContext({ viewport: { width: 390, height: 1000 }, locale: "en-US" })).newPage();
  await p.goto("https://kingshoter.com/kvk.html?k=test&room=dbg" + Date.now()); await p.waitForLoadState("networkidle"); await p.waitForTimeout(900);
  try { if (await p.locator("#obGo").isVisible()) await p.locator("#obGo").click(); } catch (e) {}
  await p.waitForTimeout(400);
  const r = await p.evaluate(() => {
    var g = document.getElementById("voiceGender"), s = document.getElementById("voiceLang");
    var gb = g.getBoundingClientRect(), sb = s.getBoundingClientRect();
    return { genderHTML: g.innerHTML.slice(0,120), gW: Math.round(gb.width), gH: Math.round(gb.height), sW: Math.round(sb.width), genderBtnCount: g.children.length, segDisplay: getComputedStyle(g).display };
  });
  console.log(JSON.stringify(r, null, 1));
  await b.close();
})().catch(e => console.error("ERR", e.message));
