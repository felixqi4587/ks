require('./support/legacy-kvk-script-guard.cjs')(__filename);
const { chromium } = require("playwright");
(async () => {
  const RM = "e2e" + Date.now();
  const base = "https://kingshoter.kingshot1406.workers.dev/kvk.html?k=test&room=" + RM;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  let pass = 0, fail = 0; const ok = (c, l) => { (c ? pass++ : fail++); console.log((c ? "✓" : "✗ FAIL") + " " + l); };
  const dismiss = async p => { try { if (await p.locator("#obGo").isVisible()) await p.locator("#obGo").click(); } catch (e) {} };
  const mkPlayer = async (fid, mm, ss) => {
    const p = await (await browser.newContext()).newPage();
    await p.goto(base); await p.waitForLoadState("networkidle"); await dismiss(p);
    await p.locator("#pid").fill(fid); await p.waitForTimeout(1700);
    await p.locator("#mm").fill(mm); await p.locator("#ss").fill(ss);
    await p.locator("#saveBtn").click(); await p.waitForTimeout(1200);
    return p;
  };

  // commander
  const cmd = await (await browser.newContext()).newPage();
  await cmd.goto(base); await cmd.waitForLoadState("networkidle"); await dismiss(cmd);
  await cmd.locator("#cmdFold > summary").click();
  await cmd.locator("#cmdUnlock").click();
  await cmd.locator("#pwInput").fill("pw123"); await cmd.locator("#pwGo").click(); await cmd.waitForTimeout(1500);
  ok(await cmd.locator("#cmdBody").isVisible(), "commander unlocked via inline modal (no native prompt)");

  // two players
  const p1 = await mkPlayer("207573838", "1", "30");
  ok(await p1.locator("#inCard").isVisible(), "player sees compact 'you're in' card after submit");
  const p2 = await mkPlayer("999999999", "1", "10");
  await cmd.waitForTimeout(800);
  ok(await cmd.locator("#roster .rp").count() >= 2, "commander roster shows both players (" + await cmd.locator("#roster .rp").count() + ")");

  // pick both captains + fire double rally
  await cmd.locator("#roster .rp").nth(0).click();
  await cmd.locator("#roster .rp").nth(1).click();
  await cmd.locator("#fireDouble").click(); await p1.waitForTimeout(1300);
  ok(await p1.locator("#banner").evaluate(el => el.classList.contains("show") && el.classList.contains("mine")), "captain p1 sees PERSONAL double-rally banner (.mine)");
  const t1 = await p1.locator("#bTitle").textContent();
  ok(/YOU/i.test(t1 || ""), "p1 banner title = personal launch cue (got: " + t1 + ")");
  const c1 = await p1.locator("#bCd").textContent(), c2 = await p2.locator("#bCd").textContent();
  ok(/\d/.test(c1 || "") && /\d/.test(c2 || ""), "both captains get their own synced countdown (p1='" + (c1||"").trim() + "' p2='" + (c2||"").trim() + "')");
  ok((c1 || "").trim() !== (c2 || "").trim(), "the two captains' launch times DIFFER (1s-offset → different marches → different press times)");

  await cmd.screenshot({ path: "test/commander.png" });
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
