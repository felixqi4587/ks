const { chromium } = require("playwright");
const secs = s => { s = (s || "").trim(); if (/^\d+$/.test(s)) return +s; const m = s.match(/(\d+):(\d+)/); return m ? +m[1] * 60 + +m[2] : 999; };
(async () => {
  const RM = "t" + Date.now(), base = "https://kingshoter.com/kvk.html?k=test&room=" + RM;
  const b = await chromium.launch({ headless: true, channel: "chrome" });
  let pass = 0, fail = 0; const ok = (c, l) => { (c ? pass++ : fail++); console.log((c ? "✓" : "✗ FAIL") + " " + l); };
  const errs = [];
  const dis = async p => { try { if (await p.locator("#obGo").isVisible()) await p.locator("#obGo").click(); } catch (e) {} };
  const mk = async (fid, m) => { const p = await (await b.newContext({ viewport: { width: 390, height: 1000 }, locale: "en-US" })).newPage(); p.on("pageerror", e => errs.push(fid + ":" + e.message)); await p.goto(base); await p.waitForLoadState("networkidle"); await dis(p); await p.locator("#pid").fill(fid); await p.waitForTimeout(1700); await p.locator("#marchRange").fill(String(m)); await p.locator("#saveBtn").click(); await p.waitForTimeout(800); return p; };
  const cmd = await (await b.newContext({ viewport: { width: 390, height: 1000 }, locale: "en-US" })).newPage();
  cmd.on("pageerror", e => errs.push("cmd:" + e.message));
  await cmd.goto(base); await cmd.waitForLoadState("networkidle"); await dis(cmd);
  await cmd.locator("#cmdFold > summary").click();
  await cmd.locator("#cmdUnlock").click(); await cmd.locator("#pwInput").fill("pw"); await cmd.locator("#pwGo").click(); await cmd.waitForTimeout(1000);
  const p1 = await mk("207573838", "95"), p2 = await mk("999999999", "70"), p3 = await mk("123456789", "50"); await cmd.waitForTimeout(900);
  await cmd.locator('#lead button[data-v="15"]').click();
  await cmd.locator("#roster .rp").nth(0).click(); await cmd.locator("#roster .rp").nth(1).click(); // any two captains
  await cmd.locator("#fireDouble").click(); await p1.waitForTimeout(1200);
  const read = async p => ({ title: (await p.locator("#bTitle").textContent() || "").trim(), text: (await p.locator("#bText").textContent() || "").trim(), cd: secs(await p.locator("#bCd").textContent()) });
  const data = []; for (const p of [p1, p2, p3]) data.push(await read(p));
  data.forEach((d, i) => console.log("page" + (i + 1), JSON.stringify(d)));
  const caps = data.filter(d => /YOU/.test(d.title)), non = data.filter(d => !/YOU/.test(d.title));
  ok(data.every(d => d.cd < 240), "NO countdown is the 5-min gather — all are click-times (max " + Math.max.apply(null, data.map(d => d.cd)) + "s)");
  ok(caps.length === 2, "exactly two whale captains have a personal click countdown");
  ok(caps.length === 2 && caps[0].cd !== caps[1].cd, "the two whales are staggered (1s + march offset)");
  ok(non.length === 1 && /whales click|鲸鱼/i.test(non[0].text), "non-captain sees '🐋 whales click rally' (not a 5-min land time)");
  ok(errs.length === 0, "no page errors" + (errs.length ? " → " + errs.join(" | ") : ""));
  await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
