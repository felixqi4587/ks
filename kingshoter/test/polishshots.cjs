const { chromium } = require("playwright");
(async () => {
  const b=await chromium.launch({headless:true,channel:"chrome"});
  const idx=await(await b.newContext({viewport:{width:390,height:850},deviceScaleFactor:2,locale:"en-US"})).newPage();
  await idx.goto("https://kingshoter.com/index.html");await idx.waitForLoadState("networkidle");await idx.waitForTimeout(800);
  await idx.screenshot({path:"test/journey/polish-index.png",fullPage:true});
  const cd=await(await b.newContext({viewport:{width:390,height:850},deviceScaleFactor:2,locale:"en-US"})).newPage();
  await cd.goto("https://kingshoter.com/codes.html");await cd.waitForLoadState("networkidle");await cd.waitForTimeout(1500);
  await cd.screenshot({path:"test/journey/polish-codes.png",fullPage:true});
  await b.close();console.log("saved");
})().catch(e=>{console.error("ERR",e.message);process.exit(2);});
