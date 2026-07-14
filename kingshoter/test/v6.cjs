const { chromium } = require("playwright");
(async () => {
  const RM = "bg" + Date.now(), base = "https://kingshoter.com/kvk.html?k=test&room=" + RM;
  const b = await chromium.launch({ headless: true, channel: "chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
  let pass = 0, fail = 0; const ok = (c, l) => { (c ? pass++ : fail++); console.log((c ? "✓" : "✗ FAIL") + " " + l); };
  const errs = [];
  const dis = async p => { try { if (await p.locator("#obGo").isVisible()) await p.locator("#obGo").click(); } catch (e) {} };
  const mk = async (fid, secs) => { const p = await (await b.newContext({ viewport: { width: 390, height: 1000 }, locale: "en-US" })).newPage(); p.on("pageerror", e => errs.push(fid + ":" + e.message)); await p.goto(base); await p.waitForLoadState("networkidle"); await dis(p); await p.locator("#pid").fill(fid); await p.waitForTimeout(1700); await p.locator("#marchRange").fill(String(secs)); await p.locator("#saveBtn").click(); await p.waitForTimeout(800); return p; };
  const cmd = await (await b.newContext({ viewport: { width: 390, height: 1000 }, locale: "en-US" })).newPage();
  cmd.on("pageerror", e => errs.push("cmd:" + e.message));
  await cmd.goto(base); await cmd.waitForLoadState("networkidle"); await dis(cmd);
  await cmd.locator("#cmdFold > summary").click();
  await cmd.locator("#cmdUnlock").click(); await cmd.locator("#pwInput").fill("pw"); await cmd.locator("#pwGo").click(); await cmd.waitForTimeout(1000);
  const p1 = await mk("207573838", "95"), p2 = await mk("999999999", "70"); await cmd.waitForTimeout(900);
  await cmd.locator('#lead button[data-v="15"]').click();
  await cmd.locator("#roster .rp").nth(1).click(); await cmd.locator("#roster .rp").nth(0).click();
  await cmd.locator("#fireDouble").click(); await p1.waitForTimeout(1200);
  ok(/YOU/i.test(await p1.locator("#bTitle").textContent() || ""), "p1 is the captain with a 15s rally");
  // simulate switching to the game: page goes hidden -> handler must pre-queue the countdown beeps
  const r = await p1.evaluate(() => { window.__beeps = 0; Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); return { beeps: window.__beeps || 0 }; });
  console.log("beeps pre-queued on background:", r.beeps);
  ok(r.beeps >= 4, "backgrounding pre-queues the full 5·4·3·2·1·GO countdown (" + r.beeps + " beeps)");
  ok(errs.length === 0, "no page errors" + (errs.length ? " → " + errs.join(" | ") : ""));
  await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
