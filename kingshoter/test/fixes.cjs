// review-fix verification: pick-role invariant (no double-main), cancel kills pre-booked beeps + room-wide cue
const { chromium } = require("playwright");
const { assertQaRoomName, makeQaRoom, qaRoomUrl, installQaWebSocketGuard } = require('./support/qa-kvk.cjs');
(async () => {
  const HOST = process.argv[2] || "https://kingshoter.com";
  const RM = makeQaRoom('fixes'), base = qaRoomUrl(HOST, RM, { notour: 1 });
  const b = await chromium.launch({ headless: true, channel: "chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
  let pass = 0, fail = 0; const ok = (c, l) => { (c ? pass++ : fail++); console.log((c ? "✓" : "✗ FAIL") + " " + l); };
  const errs = [];
  const mk = async (fid, m) => { const context = await b.newContext({ viewport: { width: 390, height: 1400 }, locale: "en-US" }); await installQaWebSocketGuard(context, RM); const p = await context.newPage(); p.on("pageerror", e => errs.push(fid + ":" + e.message)); await p.goto(base); await p.waitForLoadState("networkidle"); await p.locator("#soundGate").click().catch(() => {}); await p.waitForTimeout(150); await p.locator("#pid").fill(fid); await p.waitForTimeout(1700); await p.locator("#marchRange").fill(String(m)); await p.locator("#saveBtn").click(); await p.waitForTimeout(600); return p; };
  const fire2 = async (p, sel) => { await p.locator(sel).click(); await p.waitForTimeout(240); await p.locator(sel).click(); await p.waitForTimeout(300); };

  const p1 = await mk("900000001", "60"), p2 = await mk("900000002", "70"), p3 = await mk("900000003", "80");
  const cmdContext = await b.newContext({ viewport: { width: 390, height: 1400 }, locale: "en-US" }); await installQaWebSocketGuard(cmdContext, RM);
  const cmd = await cmdContext.newPage();
  cmd.on("pageerror", e => errs.push("cmd:" + e.message));
  await cmd.goto(base); await cmd.waitForLoadState("networkidle");
  await cmd.locator("#soundGate").click().catch(() => {}); await cmd.waitForTimeout(150);
  await cmd.locator("#cmdUnlock").click(); await cmd.locator("#pwInput").fill("666"); await cmd.locator("#pwGo").click(); await cmd.waitForTimeout(2200);

  // 1) pick A,B then explicitly replace the sacrifice slot with C — a full selection never shifts silently
  const tap = async (id) => { await cmd.locator(`#roster .rp:has-text("${id}")`).first().click(); await cmd.waitForTimeout(250); };
  await tap("900000001"); await tap("900000002"); await tap("900000003");
  await cmd.locator('#replaceOvl.show').waitFor({ state: 'visible' });
  await cmd.locator('#replaceWeak').click(); await cmd.waitForTimeout(300);
  const slots = await cmd.evaluate(() => ({ weak: document.querySelector("#pickSlots .slot.weak .sv").textContent, main: document.querySelector("#pickSlots .slot.main .sv").textContent }));
  ok(!/—/.test(slots.weak) && !/—/.test(slots.main), "after replacing a captain both role slots stay filled (" + slots.weak.trim() + " / " + slots.main.trim() + ")");
  ok(slots.weak.trim() !== slots.main.trim(), "weak ≠ main (no same-player double role)");

  // 2) fire with 10s lead → arm cancel early → confirm inside the last 300ms → even the imminent GO must die
  await cmd.locator('#lead button[data-v="10"]').click(); await cmd.waitForTimeout(150);
  await fire2(cmd, "#fireDouble"); await p3.waitForTimeout(900);
  const before = await p3.evaluate(() => window.__beeps || 0);
  ok(before > 0, "CAPTAIN pre-booked countdown cues at fire time (" + before + ")");
  const futureBefore = await p3.evaluate(() => Object.values(window.__cues || {}).filter((cue) => cue.t > window.serverNow() + 300 && cue.nodes.length).length);
  ok(futureBefore > 0, "captain has live future audio nodes before cancellation (" + futureBefore + ")");
  ok(await p1.evaluate(() => Object.keys(window.__cues || {}).some((key) => key.includes("-join:"))), "evicted non-captain receives one generic JOIN countdown, not a vehicle assignment");
  await p3.waitForFunction(() => {
    const go = Object.entries(window.__cues || {}).find(([key]) => key.endsWith("-me:0"));
    if (!go) return false;
    const remaining = go[1].t - window.serverNow();
    return remaining >= 2300 && remaining <= 2600;
  }, null, { timeout: 12000 });
  await cmd.locator("#cancelBtn").click();
  await p3.waitForFunction(() => {
    const go = Object.entries(window.__cues || {}).find(([key]) => key.endsWith("-me:0"));
    if (!go) return false;
    const remaining = go[1].t - window.serverNow();
    return remaining >= 170 && remaining <= 260;
  }, null, { timeout: 15000 });
  await cmd.locator("#cancelBtn").click();
  await p3.waitForFunction(() => document.getElementById("phero").classList.contains("hide"), null, { timeout: 1500 });
  await p3.waitForTimeout(30);
  const st = await p3.evaluate(() => ({
    toast: document.getElementById("toast").textContent,
    hero: document.getElementById("phero").className,
    futureCues: Object.values(window.__cues || {}).filter((cue) => cue.t > window.serverNow() && cue.nodes.length).length,
    lingeringGo: Object.entries(window.__cues || {}).filter(([key, cue]) => key.endsWith("-me:0") && cue.nodes.length).length
  }));
  ok(/cancelled/i.test(st.toast), "the CAPTAIN gets the 'Order cancelled' cue (" + st.toast + ")");
  ok(/hide/.test(st.hero), "hero cleared after cancel");
  ok(st.futureCues === 0, "cancellation removes every future personal audio node");
  ok(st.lingeringGo === 0, "cancellation inside the final 300ms also stops and removes the scheduled GO");
  ok(errs.length === 0, "no page errors" + (errs.length ? " → " + errs.join(" | ") : ""));
  assertQaRoomName(RM);
  await Promise.race([b.close(), new Promise(resolve => setTimeout(resolve, 3000))]);
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
