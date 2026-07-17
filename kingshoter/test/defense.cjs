require('./support/legacy-kvk-script-guard.cjs')(__filename);
// defense merge: commander publishes enemy whales → every defender's 🛡️ tab computes refill timing (self-serve, static)
// Usage: node test/defense.cjs [baseURL]   (defaults to production; pass http://localhost:8788 to test a local wrangler dev)
const { chromium } = require("playwright");
const { makeQaRoom, qaRoomUrl, installQaWebSocketGuard } = require("./support/qa-coordination.cjs");
(async () => {
  const HOST = process.argv[2] || "https://kingshoter.com";
  const RM = makeQaRoom("defense"), base = qaRoomUrl(HOST, RM, { k: "test", notour: 1 });
  const b = await chromium.launch({ headless: true, channel: "chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
  let pass = 0, fail = 0; const ok = (c, l) => { (c ? pass++ : fail++); console.log((c ? "✓" : "✗ FAIL") + " " + l); };
  const errs = [];
  const dis = async p => { try { await p.keyboard.press("Escape"); } catch (e) {} try { if (await p.locator("#obGo").isVisible()) await p.locator("#obGo").click(); } catch (e) {} };
  const mk = async (fid, m) => { const context = await b.newContext({ viewport: { width: 390, height: 1400 }, locale: "en-US" }); await installQaWebSocketGuard(context, RM); const p = await context.newPage(); p.on("pageerror", e => errs.push(fid + ":" + e.message)); await p.goto(base); await p.waitForLoadState("networkidle"); await dis(p); await p.locator("#soundGate").click().catch(() => {}); await p.waitForTimeout(150); await p.locator("#pid").fill(fid); await p.waitForTimeout(1700); await p.locator("#marchRange").fill(String(m)); await p.locator("#saveBtn").click(); await p.waitForTimeout(600); return p; };

  // commander: unlock, add 2 enemy whales, publish
  const cmdContext = await b.newContext({ viewport: { width: 390, height: 1400 }, locale: "en-US" });
  await installQaWebSocketGuard(cmdContext, RM);
  const cmd = await cmdContext.newPage();
  cmd.on("pageerror", e => errs.push("cmd:" + e.message));
  await cmd.goto(base); await cmd.waitForLoadState("networkidle"); await dis(cmd);
  await cmd.locator("#soundGate").click().catch(() => {}); await cmd.waitForTimeout(150);
  await cmd.locator("#cmdUnlock").click(); await cmd.locator("#pwInput").fill("666"); await cmd.locator("#pwGo").click(); await cmd.waitForTimeout(2200);
  ok(await cmd.locator("#cdefense").count() === 1, "commander console has the defense (set enemy whales) block");
  await cmd.locator("#cstep_def").click(); await cmd.waitForTimeout(150);   // whale editor folds by default now — open it like a real commander
  await cmd.locator("#addEnemy").click(); await cmd.locator("#addEnemy").click(); await cmd.waitForTimeout(200);
  const rows = cmd.locator("#enemyList .foe");
  ok(await rows.count() === 2, "two enemy-whale rows added");
  await rows.nth(0).locator('input[data-k="name"]').fill("Kraken"); await rows.nth(0).locator('input[data-k="mm"]').fill("1"); await rows.nth(0).locator('input[data-k="ss"]').fill("10");
  await rows.nth(1).locator('input[data-k="name"]').fill("Leviathan"); await rows.nth(1).locator('input[data-k="mm"]').fill("0"); await rows.nth(1).locator('input[data-k="ss"]').fill("40");
  await cmd.waitForTimeout(150); await cmd.locator("#pubWhales").click(); await cmd.waitForTimeout(1200);
  ok(/published|发布/i.test(await cmd.locator("#pubMsg").textContent() || ""), "publish confirms '✓ Published to squad'");
  ok(/2/.test(await cmd.locator("#defBadge").textContent() || "") && !(await cmd.locator("#defBadge").evaluate(e => e.classList.contains("hide"))), "defense tab shows a badge of 2 published whales");

  // a separate defender joins, fills march 1:20, opens the 🛡️ tab
  const def = await mk("900000055", "80");
  await def.waitForTimeout(900);
  ok(/2/.test(await def.locator("#defBadge").textContent() || ""), "defender sees the published-whale badge live (broadcast)");
  await def.locator("#tabDef").click(); await def.waitForTimeout(400);
  ok(await def.locator("#defenseView").evaluate(e => !e.classList.contains("hide")) && await def.locator("#attackView").evaluate(e => e.classList.contains("hide")), "🛡️ toggle shows the defense view and hides the attack view");
  ok(await def.locator("#dstrips .dblk").count() === 2, "defender's defense tab renders 2 whale timing strips");
  ok(await def.locator("#whaleChips .wchip").count() === 2, "two whale-focus chips render");
  await def.locator("#whaleChips .wchip").first().click(); await def.waitForTimeout(80);
  ok(/^▶/.test((await def.locator("#dpp").textContent()) || ""), "choosing an incoming whale keeps the non-live rehearsal paused");
  ok(await def.locator("#dsvg circle").count() > 0, "defense pond radar renders");
  // math: my march 80s, Kraken march 70s → send when their gather shows 0:09 left  (R - em - DELTA = 80-70-1)
  const kraken = (await def.locator("#dstrips .dblk").first().textContent()) || "";
  ok(/0:09 left/.test(kraken), "Kraken cue math correct (gather: 0:09 left for 1:20 vs 1:10)");

  // switching back to Attack still renders the attack timeline (no .lane CSS collision)
  await def.locator("#tabAtk").click(); await def.waitForTimeout(300);
  ok(await def.locator("#attackView").evaluate(e => !e.classList.contains("hide")) && await def.locator("#situation .lanes .lane").count() > 0, "⚔️ toggle restores the attack timeline (attack .lane intact)");

  ok(errs.length === 0, "no page errors" + (errs.length ? " → " + errs.join(" | ") : ""));
  await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
