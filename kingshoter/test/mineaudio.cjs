// Captains book their personal launch cue; everyone else books one shared JOIN cue. Radar dots move on the linear press→land clock.
const { chromium } = require("playwright");
(async () => {
  const HOST = process.argv[2] || "http://localhost:8788";
  const RM = "ma" + Date.now(), base = HOST + "/kvk.html?room=" + RM + "&notour=1";
  const b = await chromium.launch({ headless: true, channel: "chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
  let pass = 0, fail = 0; const ok = (c, l) => { (c ? pass++ : fail++); console.log((c ? "✓" : "✗ FAIL") + " " + l); };
  const errs = [];
  const mk = async (fid, m) => { const p = await (await b.newContext({ viewport: { width: 390, height: 1200 }, locale: "en-US" })).newPage(); p.on("pageerror", e => errs.push(fid + ":" + e.message)); await p.goto(base); await p.waitForLoadState("networkidle"); await p.locator("#soundGate").click({ force: true }).catch(() => {}); await p.waitForTimeout(150); await p.locator("#pid").fill(fid); await p.waitForTimeout(1700); await p.locator("#marchRange").fill(String(m)); await p.locator("#saveBtn").click(); await p.waitForTimeout(500); return p; };
  const p1 = await mk("900000001", "60"), p2 = await mk("900000002", "70"), p3 = await mk("900000003", "80");
  const cmd = await (await b.newContext({ viewport: { width: 390, height: 1200 }, locale: "en-US" })).newPage();
  cmd.on("pageerror", e => errs.push("cmd:" + e.message));
  await cmd.goto(base); await cmd.waitForLoadState("networkidle");
  await cmd.locator("#soundGate").click({ force: true }).catch(() => {}); await cmd.waitForTimeout(150);
  await cmd.locator("#cmdUnlock").click(); await cmd.locator("#pwInput").fill("666"); await cmd.locator("#pwGo").click(); await cmd.waitForTimeout(2200);
  await cmd.locator('#roster .rp:has-text("900000001")').first().click(); await cmd.waitForTimeout(200);
  await cmd.locator('#roster .rp:has-text("900000002")').first().click(); await cmd.waitForTimeout(300);
  await cmd.locator('#lead button[data-v="10"]').click(); await cmd.waitForTimeout(150);
  await cmd.locator("#fireDouble").click(); await cmd.waitForTimeout(250); await cmd.locator("#fireDouble").click(); await p1.waitForTimeout(1500);
  const b1 = await p1.evaluate(() => window.__beeps || 0), b3 = await p3.evaluate(() => window.__beeps || 0), bc = await cmd.evaluate(() => window.__beeps || 0);
  ok(b1 > 0, "captain books his countdown cues (" + b1 + ")");
  ok(b3 > 0, "joiner books the shared JOIN countdown (" + b3 + ")");
  ok(bc > 0, "commander (not a captain) also books the shared JOIN countdown (" + bc + ")");
  ok(/Whales|🐋/i.test(await p3.locator("#pheroTitle").textContent() || ""), "joiner sees the matching whale countdown");
  // radar motion during GATHER: dot must creep toward the castle on the linear clock (used to be frozen for 5 min)
  const dist = async () => p3.evaluate(() => { const tr = [...document.querySelectorAll("#radar g")].map(g => g.getAttribute("transform")).filter(t => t && t.includes("translate")); const m = /translate\(([\d.]+),([\d.]+)\)/.exec(tr[0]); const dx = +m[1] - 180, dy = +m[2] - 66; return Math.hypot(dx, dy); });
  await p3.waitForTimeout(11000);   // past the press moment (lead 10s) — gather is running now
  const d0 = await dist(); await p3.waitForTimeout(8000); const d1 = await dist();
  ok(d1 < d0 - 0.2, "radar dot moves inward DURING the gather phase (" + d0.toFixed(1) + " → " + d1.toFixed(1) + ")");
  ok(errs.length === 0, "no page errors" + (errs.length ? " → " + errs.join(" | ") : ""));
  await Promise.race([b.close(), new Promise(resolve => setTimeout(resolve, 3000))]);
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
