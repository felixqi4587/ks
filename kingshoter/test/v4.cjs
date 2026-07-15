require('./support/legacy-kvk-script-guard.cjs')(__filename);
const { chromium } = require("playwright");
(async () => {
  const RM = "w" + Date.now(), base = "https://kingshoter.com/kvk.html?k=test&room=" + RM;
  const b = await chromium.launch({ headless: true, channel: "chrome" });
  let pass = 0, fail = 0; const ok = (c, l) => { (c ? pass++ : fail++); console.log((c ? "✓" : "✗ FAIL") + " " + l); };
  const errs = [];
  const dis = async p => { try { if (await p.locator("#obGo").isVisible()) await p.locator("#obGo").click(); } catch (e) {} };
  const mk = async (fid, secs) => { const p = await (await b.newContext({ viewport: { width: 390, height: 1000 }, locale: "en-US" })).newPage(); p.on("pageerror", e => errs.push(fid + ":" + e.message)); await p.goto(base); await p.waitForLoadState("networkidle"); await dis(p); await p.locator("#pid").fill(fid); await p.waitForTimeout(1700); await p.locator("#marchRange").fill(String(secs)); await p.locator("#saveBtn").click(); await p.waitForTimeout(900); return p; };
  const cmd = await (await b.newContext({ viewport: { width: 390, height: 1000 }, locale: "en-US" })).newPage();
  cmd.on("pageerror", e => errs.push("cmd:" + e.message));
  await cmd.goto(base); await cmd.waitForLoadState("networkidle"); await dis(cmd);
  // defaults
  ok((await cmd.locator("#alertMode button.on").first().textContent() || "").includes("Voice"), "alerts default = Voice (highlighted)");
  ok(await cmd.locator("#voicePickRow").isVisible() && await cmd.locator("#voiceGender button").count() === 2, "voice: 2 choices (female/male) shown");
  ok(await cmd.locator("#voiceTest").count() === 1, "voice test button present");
  ok(await cmd.locator("#marchPresets").count() === 0 && await cmd.locator("#marchMinus").count() === 1 && await cmd.locator("#marchPlus").count() === 1, "march: presets removed, ± buttons present");
  ok(await cmd.locator("#marchRange").getAttribute("max") === "120" && await cmd.locator("#marchRange").getAttribute("step") === "1", "march slider: max 120, step 1");
  ok(await cmd.locator("#simStart").count() === 0, "Start-sim removed");
  // ± fine tune
  await cmd.locator("#marchRange").fill("90"); await cmd.waitForTimeout(100);
  await cmd.locator("#marchPlus").click(); 
  ok((await cmd.locator("#marchLbl").textContent()).trim() === "1:31", "± : +1s gives 1:31 (" + (await cmd.locator("#marchLbl").textContent()).trim() + ")");
  // players + roster list
  const p1 = await mk("207573838", "95"), p2 = await mk("999999999", "70"); await cmd.waitForTimeout(800);
  const rl = (await p1.locator("#rosterList").textContent() || "");
  ok(/207573838/.test(rl) && /1:35/.test(rl), "war-room roster lists ID + march (1:35)");
  // commander double rally for K2
  await cmd.locator("#cmdFold > summary").click();
  await cmd.locator("#cmdUnlock").click(); await cmd.locator("#pwInput").fill("pw"); await cmd.locator("#pwGo").click(); await cmd.waitForTimeout(1000);
  // per-kingdom lock: pick both on K1, switch to K2
  await cmd.locator("#roster .rp").nth(0).click(); await cmd.locator("#roster .rp").nth(1).click();
  await cmd.locator('#kingdomPick button[data-k="2"]').click(); await cmd.waitForTimeout(200);
  ok(await cmd.locator("#roster .rp.sel").count() === 0 && await cmd.locator("#roster .rp.otherk").count() === 2, "per-kingdom: K1 picks locked (otherk) on K2");
  // fire on K1 (switch back) 
  await cmd.locator('#kingdomPick button[data-k="1"]').click(); await cmd.waitForTimeout(200);
  await cmd.locator("#fireDouble").click(); await p1.waitForTimeout(1500);
  const bt = (await p1.locator("#bTitle").textContent() || ""), mapTxt = (await p1.locator("#map").textContent() || "");
  ok(/🌍/.test(bt), "banner shows kingdom tag");
  ok(/Kingdom 1/.test(mapTxt) && /YOU/.test(mapTxt), "live map: kingdom label + YOU");
  const c1 = (await p1.locator("#bCd").textContent() || "").trim(), c2 = (await p2.locator("#bCd").textContent() || "").trim();
  ok(c1 !== c2, "per-captain countdowns differ (" + c1 + " / " + c2 + ")");
  ok(errs.length === 0, "no page errors" + (errs.length ? " → " + errs.join(" | ") : ""));
  await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
