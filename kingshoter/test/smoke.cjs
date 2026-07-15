require('./support/legacy-kvk-script-guard.cjs')(__filename);
const { chromium } = require("playwright");
(async () => {
  const b=await chromium.launch({headless:true,channel:"chrome"});
  const errs=[];
  for(const pg of ["index","codes","guide","kvk"]){
    const p=await(await b.newContext({viewport:{width:390,height:900},locale:"en-US"})).newPage();
    p.on("pageerror",e=>errs.push(pg+":"+e.message));
    await p.goto("https://kingshoter.com/"+pg+".html"+(pg==="kvk"?"?k=test&room=sm"+Date.now():""));
    await p.waitForLoadState("networkidle");await p.waitForTimeout(1000);
    if(pg==="index") console.log("index primary card:", await p.locator(".entry.primary").count(), "| live dot:", await p.locator(".live .d").count());
    await p.close();
  }
  console.log("errors:", errs.length?errs.join(" | "):"none");
  await b.close();
})().catch(e=>{console.error("ERR",e.message);process.exit(2);});
