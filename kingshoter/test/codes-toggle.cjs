const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch({ headless: true, channel: "chrome" });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, locale: "en-US" });
  const p = await ctx.newPage();
  await p.goto("https://kingshoter.com/codes.html"); await p.waitForTimeout(1200);
  console.log("fresh load:        codeRows=" + await p.locator("#list .code").count());
  // toggle language
  await p.locator("#langtoggle button").first().click(); await p.waitForTimeout(800);
  console.log("after lang toggle: codeRows=" + await p.locator("#list .code").count() + "  text=\"" + ((await p.locator("#list").textContent()||"").slice(0,40)) + "\"");
  // reload in SAME context (keeps localStorage lang + http cache)
  await p.reload(); await p.waitForTimeout(1500);
  console.log("after reload:      codeRows=" + await p.locator("#list .code").count());
  await b.close();
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
