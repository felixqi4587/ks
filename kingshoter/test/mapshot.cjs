require('./support/legacy-kvk-script-guard.cjs')(__filename);
const { chromium } = require("playwright");
(async () => {
  const RM="ms"+Date.now(), base="https://kingshoter.com/kvk.html?k=test&room="+RM+"&notour=1";
  const b=await chromium.launch({headless:true,channel:"chrome",args:["--autoplay-policy=no-user-gesture-required"]});
  const mk=async(fid,m)=>{const p=await(await b.newContext({viewport:{width:390,height:1400},deviceScaleFactor:2,locale:"zh-CN"})).newPage();await p.goto(base);await p.waitForLoadState("networkidle");await p.keyboard.press("Escape").catch(()=>{});await p.locator("#soundGate").click({force:true});await p.waitForTimeout(200);await p.locator("#pid").fill(fid);await p.waitForTimeout(1500);await p.locator("#marchRange").fill(String(m));await p.locator("#saveBtn").click();await p.waitForTimeout(500);return p;};
  await mk("900000002","75"); await mk("900000003","150");   // a slow 2:30 marcher (outer ring) to test clipping
  const p=await mk("900000001","30");
  await p.waitForTimeout(900);
  const box=await p.locator(".pond").boundingBox();
  await p.screenshot({path:"test/journey/mapfix.png",clip:{x:0,y:box.y-2,width:390,height:box.height+150}});
  console.log("radar dots:",await p.locator("#radar circle").count(),"lanes:",await p.locator("#lanes .lane").count());
  await b.close();console.log("saved");
})().catch(e=>{console.error("ERR",e.message);process.exit(2);});
