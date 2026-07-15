const { chromium } = require("playwright");
(async () => {
  const b=await chromium.launch({headless:true,channel:"chrome"});
  const p=await(await b.newContext({locale:"en-US"})).newPage();
  await p.goto("https://kingshoter.com/kvk.html?k=test&room=ta"+Date.now());await p.waitForLoadState("networkidle");
  console.log("body touch-action:", await p.evaluate(()=>getComputedStyle(document.body).touchAction));
  await b.close();
})().catch(e=>console.error("ERR",e.message));
