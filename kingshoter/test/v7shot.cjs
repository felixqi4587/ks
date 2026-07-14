// v7 layout visual check: player mode + commander mode at 390x844, local dev
const { chromium } = require("playwright");
(async () => {
  const HOST = process.argv[2] || "http://localhost:8788";
  const RM = "v7s" + Date.now(), base = HOST + "/kvk.html?room=" + RM + "&notour=1";
  const b = await chromium.launch({ headless: true, channel: "chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.goto(base); await p.waitForLoadState("networkidle");
  await p.locator("#soundGate").click({ force: true }); await p.waitForTimeout(300);
  await p.locator("#pid").fill("900000123"); await p.waitForTimeout(1500);
  await p.locator("#marchRange").fill("50"); await p.locator("#saveBtn").click(); await p.waitForTimeout(500);
  // seed 2nd player over a raw WS
  await p.evaluate((room) => new Promise(res => { const ws = new WebSocket("ws://" + location.host + "/api/ws?room=" + room); ws.onopen = () => { ws.send(JSON.stringify({ t: "setMarch", pid: "900000456", name: "Bravo", march: 80, alliance: "" })); setTimeout(() => { ws.close(); res(1); }, 400); }; }), RM);
  await p.waitForTimeout(600);
  await p.screenshot({ path: "test/journey/v7-player.png", fullPage: false });
  // commander unlock + pick both + check metrics
  await p.locator("#cmdUnlock").click(); await p.locator("#pwInput").fill("666"); await p.locator("#pwGo").click(); await p.waitForTimeout(2200);
  await p.locator('#roster .rp:has-text("900000123")').first().click(); await p.waitForTimeout(200);
  await p.locator('#roster .rp:has-text("Bravo")').first().click(); await p.waitForTimeout(400);
  const m = await p.evaluate(() => { const s = document.getElementById("situation").getBoundingClientRect(); const f = document.getElementById("fireDouble").getBoundingClientRect(); return { cmdmode: document.body.classList.contains("cmdmode"), topHidden: getComputedStyle(document.querySelector(".top")).display === "none", sitTop: Math.round(s.top + scrollY), sitH: Math.round(s.height), fireVisibleAtTop: f.top > 0 && f.bottom <= innerHeight, whaleFolded: !document.getElementById("cdefense").open };
  });
  console.log("metrics", JSON.stringify(m));
  await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(300);
  await p.screenshot({ path: "test/journey/v7-cmd-top.png", fullPage: false });
  await p.screenshot({ path: "test/journey/v7-cmd-full.png", fullPage: true });
  console.log("errors:", errs.length ? errs.join("|") : "none");
  await b.close();
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
