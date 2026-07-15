require('./support/legacy-kvk-script-guard.cjs')(__filename);
const { chromium } = require("playwright");
(async () => {
  const RM="im"+Date.now(), base="https://kingshoter.com/kvk.html?k=test&room="+RM;
  const b=await chromium.launch({headless:true,channel:"chrome"});
  const dis=async p=>{try{if(await p.locator("#obGo").isVisible())await p.locator("#obGo").click();}catch(e){}};
  const mk=async(fid,m)=>{const p=await(await b.newContext({viewport:{width:390,height:1000},deviceScaleFactor:2,locale:"en-US"})).newPage();await p.goto(base);await p.waitForLoadState("networkidle");await dis(p);await p.locator("#pid").fill(fid);await p.waitForTimeout(1700);await p.locator("#marchRange").fill(String(m));await p.locator("#saveBtn").click();await p.waitForTimeout(600);return p;};
  // 4 players at very different marches → should sit on different distance rings
  await mk("207573838","20"); await mk("999999999","75"); await mk("123456789","130"); 
  const viewer=await mk("111222333","45"); await viewer.waitForTimeout(900);
  await viewer.locator(".pond").screenshot({path:"test/journey/idle-distance-map.png"});
  console.log("dots:", await viewer.locator("#map circle, #map polygon").count());
  await b.close();console.log("saved");
})().catch(e=>{console.error("ERR",e.message);process.exit(2);});
