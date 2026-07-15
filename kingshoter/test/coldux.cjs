require('./support/legacy-kvk-script-guard.cjs')(__filename);
// cold-user audit fixes: first-unlock=set-password copy, copy-link empty state, ID-lookup fail copy,
// dead-submit feedback, idle "then what" line, labeled lead/kingdom chips, defense cold state, join note, defense-tab pull-once
const { chromium } = require("playwright");
(async () => {
  const HOST = process.argv[2] || "https://kingshoter.com";
  const RM = "cx" + Date.now(), base = HOST + "/kvk.html?room=" + RM;
  const b = await chromium.launch({ headless: true, channel: "chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
  let pass = 0, fail = 0; const ok = (c, l) => { (c ? pass++ : fail++); console.log((c ? "✓" : "✗ FAIL") + " " + l); };
  const errs = [];
  const ctxOpts = { viewport: { width: 390, height: 1400 }, locale: "en-US", permissions: ["clipboard-write", "clipboard-read"] };
  const mk = async (fid, m) => { const p = await (await b.newContext(ctxOpts)).newPage(); p.on("pageerror", e => errs.push(fid + ":" + e.message)); await p.goto(base); await p.waitForLoadState("networkidle"); await p.locator("#soundGate").click().catch(() => {}); await p.waitForTimeout(150); await p.locator("#pid").fill(fid); await p.waitForTimeout(1700); await p.locator("#marchRange").fill(String(m)); await p.locator("#saveBtn").click(); await p.waitForTimeout(600); return p; };

  // ---- cold player page: empty-state + fill-flow guidance ----
  const p = await (await b.newContext(ctxOpts)).newPage();
  p.on("pageerror", e => errs.push("cold:" + e.message));
  await p.goto(base); await p.waitForLoadState("networkidle");
  await p.locator("#soundGate").click().catch(() => {}); await p.waitForTimeout(400);
  ok(await p.locator("#radar #copyLinkT").count() === 1, "empty radar offers a tappable 'copy room link'");
  const emptyY = await p.locator("#radar text").first().evaluate(e => +e.getAttribute("y"));
  ok(emptyY > 90, "empty-state text sits below the castle (y=" + emptyY + "), no icon overlap");
  await p.locator("#radar #copyLinkT").click(); await p.waitForTimeout(300);
  ok(/Copied/i.test(await p.locator("#toast").textContent() || ""), "tapping it copies + toasts");
  ok((await p.locator("#pid").getAttribute("placeholder") || "").length > 5, "Player ID field explains where to find the ID");
  await p.locator("#pid").fill("999999999999"); await p.waitForTimeout(1900);
  ok(/not found/i.test(await p.locator("#nameOut").textContent() || ""), "failed lookup explains itself (no bare ✕)");
  await p.locator("#pid").fill("900000077"); await p.waitForTimeout(1900);
  await p.locator("#saveBtn").click(); await p.waitForTimeout(300);   // slider untouched → must explain, not swallow
  ok(/drag the slider/i.test(await p.locator("#toast").textContent() || ""), "dead-submit tap explains the invisible rule");
  await p.locator("#marchRange").fill("75"); await p.locator("#saveBtn").click(); await p.waitForTimeout(500);
  const tt = await p.locator("#toast").textContent() || "";
  ok(/Submitted/.test(tt) && !/（/.test(tt), "submit toast is clean EN punctuation (" + tt.trim() + ")");
  ok(await p.locator("#idleWait").evaluate(e => !e.classList.contains("hide")), "idle 'wait for the commander…' line is persistent after submit");
  ok(/big countdown/i.test(await p.locator("#idleWait").textContent() || ""), "…and says what will happen");
  ok(/each dot/.test(await p.locator("#lanes .lanenote").textContent() || ""), "idle timeline strip has a legend");

  // ---- first unlock on a FRESH room = SET password (copy must say so) ----
  await p.locator("#cmdUnlock").click(); await p.waitForTimeout(200);
  ok(/First unlock/i.test(await p.locator("#t_pwtitle").textContent() || ""), "fresh room: modal says you're SETTING the commander password");
  ok(/becomes this room's password/i.test(await p.locator("#pwHint").textContent() || ""), "…with the explainer line");
  await p.locator("#pwInput").fill("666"); await p.locator("#pwGo").click(); await p.waitForTimeout(2200);
  ok(!(await p.locator("#console").evaluate(e => e.classList.contains("hide"))), "first password unlocks commander mode");
  ok((await p.locator("#t_kdhint").textContent() || "").length > 3, "kingdom ①/② chips are labeled");
  ok((await p.locator("#t_leadhint").textContent() || "").length > 3, "lead chips are labeled");
  ok(!/④/.test(await p.locator("#t_firedbl").textContent() || ""), "fire button dropped the dangling ④");
  ok(!/②/.test(await p.locator("#t_march").textContent() || ""), "march label dropped the duplicate ②");
  await p.locator("#cstep_def").click(); await p.waitForTimeout(150);
  ok(/march time to the castle/i.test(await p.locator("#t_defsethint").textContent() || ""), "enemy-whale m:s inputs are explained");

  // second visitor now sees the normal "enter password" copy
  const p2 = await (await b.newContext(ctxOpts)).newPage(); p2.on("pageerror", e => errs.push("p2:" + e.message));
  await p2.goto(base); await p2.waitForLoadState("networkidle"); await p2.locator("#soundGate").click().catch(() => {}); await p2.waitForTimeout(600);
  await p2.locator("#cmdUnlock").click(); await p2.waitForTimeout(200);
  ok(/^Room password$/.test((await p2.locator("#t_pwtitle").textContent() || "").trim()), "claimed room: modal says 'Room password'");
  await p2.locator("#pwCancel").click();

  // ---- defense cold state: reason first, manual hidden ----
  await p2.locator("#tabDef").click(); await p2.waitForTimeout(400);
  ok(await p2.locator("#t_dpanelhint").evaluate(e => getComputedStyle(e).display === "none"), "no whales → long operating manual hidden");
  ok(/commander hasn't published/i.test(await p2.locator("#dstrips").textContent() || ""), "…only the why-empty line shows");
  await p2.locator("#tabAtk").click();

  // ---- live order: joiner gets a JOIN verb; defense tab pulls ONCE with a toast, then stays ----
  const c1 = await mk("900000071", "60"), c2 = await mk("900000072", "70");
  const tapPick = async (id) => { await p.locator(`#roster .rp:has-text("${id}")`).first().click(); await p.waitForTimeout(250); };
  await tapPick("900000071"); await tapPick("900000072");
  await p.locator('#lead button[data-v="10"]').click(); await p.waitForTimeout(150);
  await p.locator("#fireDouble").click(); await p.waitForTimeout(240); await p.locator("#fireDouble").click(); await p.waitForTimeout(400);
  // p2 (non-captain) on attack: during the lead window, defense tab pulls back once + explains
  await p2.waitForTimeout(600);
  await p2.locator("#tabDef").click(); await p2.waitForTimeout(600);
  ok(!(await p2.locator("#attackView").evaluate(e => e.classList.contains("hide"))), "defense tap during countdown pulls back to attack");
  ok(/switched to Attack/i.test(await p2.locator("#toast").textContent() || ""), "…and SAYS why (toast)");
  await p2.locator("#tabDef").click(); await p2.waitForTimeout(900);
  ok(!(await p2.locator("#defenseView").evaluate(e => e.classList.contains("hide"))), "second tap sticks — no 200ms dead-button loop");
  await p2.locator("#tabAtk").click();
  await p2.waitForTimeout(11000);   // past GO → mid-gather
  const jn = p2.locator("#lanes .lanenote.join");
  ok(await jn.count() === 1 && await jn.evaluate(e => getComputedStyle(e).display !== "none"), "mid-gather non-captain sees the persistent 'tap JOIN in-game' line");
  ok(/JOIN/i.test(await jn.textContent() || ""), "…with the verb spelled out");
  ok(/main.*sacrifice|sacrifice.*main/i.test(await p2.locator("#radar text").last().textContent() || ""), "live radar legend describes captains, not a missing 'you' dot");

  ok(errs.length === 0, "no page errors" + (errs.length ? " → " + errs.join(" | ") : ""));
  await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
