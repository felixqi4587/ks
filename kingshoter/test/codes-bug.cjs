const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch({ headless: true, channel: "chrome" });
  const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, locale: "en-US" })).newPage();
  const errs = []; p.on("console", m => { if (m.type() === "error") errs.push(m.text()); }); p.on("pageerror", e => errs.push("PAGEERR " + e.message));
  await p.goto("https://kingshoter.com/codes.html"); 
  await p.waitForTimeout(700); const t1 = (await p.locator("#list").textContent()||"").slice(0,80); const n1 = await p.locator("#list .code").count();
  await p.waitForTimeout(2500); const t2 = (await p.locator("#list").textContent()||"").slice(0,80); const n2 = await p.locator("#list .code").count();
  console.log("@0.7s: codeRows=" + n1 + " text=\"" + t1 + "\"");
  console.log("@3.2s: codeRows=" + n2 + " text=\"" + t2 + "\"");
  console.log("errors:", errs.length ? errs.join(" | ") : "none");
  await b.close();
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
