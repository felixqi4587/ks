require('./support/legacy-kvk-script-guard.cjs')(__filename);
const { chromium } = require("playwright");
(async () => {
  const RM = "p" + Date.now(), base = "https://kingshoter.com/kvk.html?k=test&room=" + RM;
  const b = await chromium.launch({ headless: true, channel: "chrome" });
  let pass = 0, fail = 0; const ok = (c, l) => { (c ? pass++ : fail++); console.log((c ? "✓" : "✗ FAIL") + " " + l); };
  const errs = [];
  const dis = async p => { try { if (await p.locator("#obGo").isVisible()) await p.locator("#obGo").click(); } catch (e) {} };
  const mk = async (fid, secs) => { const p = await (await b.newContext({ viewport: { width: 390, height: 1000 }, locale: "en-US" })).newPage(); p.on("pageerror", e => errs.push(fid + ":" + e.message)); await p.goto(base); await p.waitForLoadState("networkidle"); await dis(p); await p.locator("#pid").fill(fid); await p.waitForTimeout(1700); await p.locator("#marchRange").fill(String(secs)); await p.locator("#saveBtn").click(); await p.waitForTimeout(800); return p; };
  // sound gate: visible before tap, hidden after a tap
  const sg = await (await b.newContext({ viewport: { width: 390, height: 1000 }, locale: "en-US" })).newPage();
  sg.on("pageerror", e => errs.push("sg:" + e.message));
  await sg.goto(base); await sg.waitForLoadState("networkidle"); await sg.waitForTimeout(800);
  ok(await sg.locator("#soundGate").evaluate(e => getComputedStyle(e).display !== "none"), "sound gate shown on load (before any tap)");
  ok(/enable sound/i.test(await sg.locator("#soundGate").textContent() || ""), "sound gate label = enable sound");
  await dis(sg); await sg.waitForTimeout(300);
  ok(await sg.locator("#soundGate").evaluate(e => getComputedStyle(e).display === "none"), "sound gate hides after a tap (audio unlocked)");
  await sg.waitForTimeout(2200);
  ok(/synced|已同步/.test(await sg.locator("#syncbadge").textContent() || ""), "netbar shows synced badge (" + (await sg.locator("#syncbadge").textContent() || "").trim() + ")");
  // commander
  const cmd = await (await b.newContext({ viewport: { width: 390, height: 1000 }, locale: "en-US" })).newPage();
  cmd.on("pageerror", e => errs.push("cmd:" + e.message));
  await cmd.goto(base); await cmd.waitForLoadState("networkidle"); await dis(cmd);
  await cmd.locator("#cmdFold > summary").click();
  await cmd.locator("#cmdUnlock").click(); await cmd.locator("#pwInput").fill("pw"); await cmd.locator("#pwGo").click(); await cmd.waitForTimeout(1000);
  ok(await cmd.locator('[data-cmd="cancel"]').isDisabled(), "cancel DISABLED when no active command");
  ok(await cmd.locator("#soundCheck").count() === 1, "sound-check button present");
  const p1 = await mk("207573838", "95"), p2 = await mk("999999999", "70"); await cmd.waitForTimeout(700);
  // sound check → p2 sees ping banner
  await cmd.locator("#soundCheck").click(); await p2.waitForTimeout(900);
  ok(/Sound check/i.test(await p2.locator("#bTitle").textContent() || ""), "sound-check broadcasts ping → others see 'Sound check'");
  await p2.waitForTimeout(4500); // let ping auto-cancel
  // double rally, lead 10, p1 = main (press = now+lead) → countdown from 5
  await cmd.locator('#lead button[data-v="10"]').click();
  await cmd.locator("#roster .rp").nth(1).click(); await cmd.locator("#roster .rp").nth(0).click(); // weak=p2, main=p1
  await cmd.locator("#fireDouble").click(); await cmd.waitForTimeout(300);
  ok(await cmd.locator('[data-cmd="cancel"]').isDisabled() === false, "cancel ENABLED once a command is live");
  const seen = {}; for (let i = 0; i < 26; i++) { const v = (await p1.locator("#bCd").textContent() || "").trim(); if (v) seen[v] = 1; await p1.waitForTimeout(450); }
  console.log("p1 countdown values:", Object.keys(seen).join(" "));
  ok(seen["5"] && seen["4"] && seen["3"] && seen["2"] && seen["1"], "countdown shows 5·4·3·2·1 (big numerals)");
  ok(Object.keys(seen).some(v => /GO|上/.test(v)), "GO shown at zero");
  ok(await cmd.locator("#voiceGender button").count() === 2, "voice still 2 choices (regression)");
  ok(errs.length === 0, "no page errors" + (errs.length ? " → " + errs.join(" | ") : ""));
  await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
