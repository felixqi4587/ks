const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch({ headless: true, channel: "chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
  const p = await (await b.newContext({ viewport: { width: 390, height: 900 }, locale: "en-US" })).newPage();
  const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.goto("https://kingshoter.com/kvk.html?k=test&room=bm" + Date.now()); await p.waitForLoadState("networkidle"); await p.waitForTimeout(1000);
  try { if (await p.locator("#obGo").isVisible()) await p.locator("#obGo").click(); } catch (e) {}
  await p.waitForTimeout(300);
  await p.locator('#alertMode button[data-m="beep"]').click(); await p.waitForTimeout(300);  // select beep -> beepConfirm()
  await p.locator("#voiceTest").click(); await p.waitForTimeout(400);                          // ▶ Test -> sampleBeep()
  const st = await p.evaluate(() => ({ acExists: !!(window.AudioContext||window.webkitAudioContext), hasAudioSession: !!navigator.audioSession }));
  console.log("beep mode on:", await p.locator('#alertMode button.on').first().textContent());
  console.log("env:", JSON.stringify(st));
  console.log("pageerrors:", errs.length ? errs.join(" | ") : "none");
  await b.close();
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
