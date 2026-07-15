require('./support/legacy-kvk-script-guard.cjs')(__filename);
const { chromium } = require("playwright");
(async () => {
  const RM = "t" + Date.now(), base = "https://kingshoter.com/kvk.html?k=test&room=" + RM;
  const b = await chromium.launch({ headless: true, channel: "chrome" });
  const dis = async p => { try { if (await p.locator("#obGo").isVisible()) await p.locator("#obGo").click(); } catch (e) {} };
  const mk = async (fid, m) => { const p = await (await b.newContext({ viewport: { width: 390, height: 1000 }, locale: "en-US" })).newPage(); await p.goto(base); await p.waitForLoadState("networkidle"); await dis(p); await p.locator("#pid").fill(fid); await p.waitForTimeout(1700); await p.locator("#marchRange").fill(String(m)); await p.locator("#saveBtn").click(); await p.waitForTimeout(800); return p; };
  const cmd = await (await b.newContext({ viewport: { width: 390, height: 1000 }, locale: "en-US" })).newPage();
  await cmd.goto(base); await cmd.waitForLoadState("networkidle"); await dis(cmd);
  await cmd.locator("#cmdFold > summary").click();
  await cmd.locator("#cmdUnlock").click(); await cmd.locator("#pwInput").fill("pw"); await cmd.locator("#pwGo").click(); await cmd.waitForTimeout(1000);
  const p1 = await mk("207573838", "95"), p2 = await mk("999999999", "70"), p3 = await mk("123456789", "50"); await cmd.waitForTimeout(900);
  await cmd.locator('#lead button[data-v="15"]').click();
  await cmd.locator("#roster .rp").nth(1).click(); await cmd.locator("#roster .rp").nth(0).click();
  await cmd.locator("#fireDouble").click(); await p1.waitForTimeout(1000);
  const dump = async (p, name) => { const r = await p.evaluate(() => { var rm = window.__room; return null; }); console.log(name, "bTitle=", JSON.stringify((await p.locator("#bTitle").textContent() || "").trim()), "bText=", JSON.stringify((await p.locator("#bText").textContent() || "").trim()), "bCd=", JSON.stringify((await p.locator("#bCd").textContent() || "").trim())); };
  await dump(p1, "p1"); await dump(p2, "p2"); await dump(p3, "p3");
  // pull the actual command payload from the cmd page's socket state via a fresh fetch is not possible; instead read it off p1
  const pl = await p1.evaluate(() => { try { return JSON.stringify((window.__lastCmd || {})); } catch (e) { return "n/a"; } });
  console.log("payload(p1.__lastCmd):", pl);
  await b.close();
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
