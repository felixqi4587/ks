require('./support/legacy-kvk-script-guard.cjs')(__filename);
const { chromium } = require("playwright");
(async () => {
  const RM="mn"+Date.now(), base="https://kingshoter.com/kvk.html?k=test&room="+RM;
  const b=await chromium.launch({headless:true,channel:"chrome",args:["--autoplay-policy=no-user-gesture-required"]});
  const dis=async p=>{try{if(await p.locator("#obGo").isVisible())await p.locator("#obGo").click();}catch(e){}};
  const mk=async(fid,m)=>{const p=await(await b.newContext({viewport:{width:390,height:1500},deviceScaleFactor:2,locale:"zh-CN"})).newPage();await p.goto(base);await p.waitForLoadState("networkidle");await dis(p);await p.locator("#pid").fill(fid);await p.waitForTimeout(1600);await p.locator("#marchRange").fill(String(m));await p.locator("#saveBtn").click();await p.waitForTimeout(500);return p;};
  await mk("900000001","30");await mk("900000002","85");
  const v=await mk("900000003","130");await v.waitForTimeout(900);
  // capture the pond + the caption line under it
  const box=await v.locator(".pond").boundingBox();
  await v.screenshot({path:"test/journey/mapnote.png",clip:{x:0,y:box.y-4,width:390,height:box.height+40}});
  console.log("note visible:", await v.locator("#mapNote").isVisible(), "| text:", (await v.locator("#mapNote").textContent()||"").trim());
  await b.close();
})().catch(e=>{console.error("ERR",e.message);process.exit(2);});
