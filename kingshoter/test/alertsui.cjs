const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch({ headless: true, channel: "chrome" });
  const p = await (await b.newContext({ viewport: { width: 390, height: 1000 }, deviceScaleFactor: 2, locale: "en-US" })).newPage();
  const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.goto("https://kingshoter.com/kvk.html?k=test&room=ui" + Date.now()); await p.waitForLoadState("networkidle"); await p.waitForTimeout(900);
  try { if (await p.locator("#obGo").isVisible()) await p.locator("#obGo").click(); } catch (e) {}
  await p.waitForTimeout(400);
  // voice mode (default)
  const r1 = await p.evaluate(() => {
    var a = document.querySelector(".alertrow"); var b = a.getBoundingClientRect();
    return { modeBtns: document.querySelectorAll("#alertMode button").length, gender: document.querySelectorAll("#voiceGender button").length, test: !!document.getElementById("voiceTest"), test_txt: document.getElementById("voiceTest").textContent.trim(), row2vis: getComputedStyle(document.getElementById("voicePickRow")).display !== "none", leftIcons: a.textContent.replace(/[^🔊🗣️]/g,"") };
  });
  console.log("VOICE mode:", JSON.stringify(r1));
  await p.evaluate(() => { var rows = document.querySelectorAll(".alertrow"); }); 
  // screenshot the two alert rows together
  await p.locator("#voicePickRow").screenshot({ path: "test/journey/ui-voice-row2.png" });
  await p.locator(".alertrow").first().screenshot({ path: "test/journey/ui-row1.png" });
  // switch to beep
  await p.locator('#alertMode button[data-m="beep"]').click(); await p.waitForTimeout(300);
  const r2 = await p.evaluate(() => ({ row2vis: getComputedStyle(document.getElementById("voicePickRow")).display !== "none", test: !!document.getElementById("voiceTest") }));
  console.log("BEEP mode:", JSON.stringify(r2));
  console.log("errors:", errs.length ? errs.join(" | ") : "none");
  await b.close();
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
