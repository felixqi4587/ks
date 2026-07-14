// capture the defense radar exactly during the "他发车/They march" hold — dot, ring and label must be ON canvas
const { chromium } = require("playwright");
(async () => {
  const HOST = process.argv[2] || "http://localhost:8788";
  const RM = "dep" + Date.now(), base = HOST + "/kvk.html?room=" + RM + "&notour=1";
  const b = await chromium.launch({ headless: true, channel: "chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
  const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, locale: "en-US" })).newPage();
  const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.goto(base); await p.waitForLoadState("networkidle");
  await p.locator("#soundGate").click({ force: true }); await p.waitForTimeout(250);
  await p.locator("#pid").fill("900000123"); await p.waitForTimeout(1500);
  await p.locator("#marchRange").fill("80"); await p.locator("#saveBtn").click(); await p.waitForTimeout(400);
  await p.locator("#cmdUnlock").click(); await p.locator("#pwInput").fill("666"); await p.locator("#pwGo").click(); await p.waitForTimeout(2000);
  await p.locator("#cstep_def").click(); await p.waitForTimeout(150);
  await p.locator("#addEnemy").click(); await p.waitForTimeout(150);
  await p.locator('#enemyList input[data-k="mm"]').fill("1"); await p.locator('#enemyList input[data-k="ss"]').fill("10");
  await p.locator("#pubWhales").click(); await p.waitForTimeout(1000);
  await p.locator("#tabDef").click(); await p.waitForTimeout(300);
  await p.evaluate(() => document.querySelector("#defenseView .pond").scrollIntoView({ block: "center" }));
  // wait until the focused strip enters fx-depart (the hold), then freeze via the pause button and shoot
  await p.waitForFunction(() => { const L = document.querySelector("#dstrips .dlane.focused"); return L && L.classList.contains("fx-depart"); }, null, { timeout: 20000 });
  await p.locator("#dpp").click();   // pause playback mid-hold
  const geo = await p.evaluate(() => {
    const svg = document.getElementById("dsvg"), vb = svg.viewBox.baseVal;
    const dots = [...svg.querySelectorAll("circle")].map(c => ({ cy: +c.getAttribute("cy"), r: +(c.getAttribute("r") || 0), op: +(c.getAttribute("opacity") ?? 1) })).filter(c => c.op > 0.1);
    const texts = [...svg.querySelectorAll("text")].map(t => ({ y: +t.getAttribute("y"), txt: t.textContent, op: +(t.getAttribute("opacity") ?? 1) })).filter(t => t.op > 0.1 && t.txt);
    return { vbTop: vb.y, offCanvasDots: dots.filter(d => d.cy - d.r < vb.y).length, texts, phase: document.getElementById("dphaselab").textContent };
  });
  console.log("geo", JSON.stringify(geo));
  await p.screenshot({ path: "test/journey/depart-fix.png" });
  console.log("errors:", errs.length ? errs.join("|") : "none");
  await b.close();
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
