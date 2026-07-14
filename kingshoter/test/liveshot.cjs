const { chromium } = require("playwright");
(async () => {
  const RM="lv"+Date.now(), base="https://kingshoter.com/kvk.html?k=test&room="+RM+"&notour=1";
  const b=await chromium.launch({headless:true,channel:"chrome",args:["--autoplay-policy=no-user-gesture-required"]});
  const mk=async(fid,m,shot)=>{const p=await(await b.newContext({viewport:{width:390,height:1500},deviceScaleFactor:shot?2:1,locale:"zh-CN"})).newPage();await p.goto(base);await p.waitForLoadState("networkidle");await p.keyboard.press("Escape").catch(()=>{});await p.locator("#soundGate").click({force:true});await p.waitForTimeout(200);await p.locator("#pid").fill(fid);await p.waitForTimeout(1500);await p.locator("#marchRange").fill(String(m));await p.locator("#saveBtn").click();await p.waitForTimeout(400);return p;};
  const p1=await mk("900000001","45",true), p2=await mk("900000002","70");
  const cmd=await(await b.newContext({locale:"zh-CN"})).newPage(); await cmd.goto(base); await cmd.waitForLoadState("networkidle"); await cmd.keyboard.press("Escape").catch(()=>{});
  await cmd.locator("#soundGate").click({force:true}); await cmd.waitForTimeout(200);
  await cmd.locator("#cmdUnlock").click(); await cmd.locator("#pwInput").fill("666"); await cmd.locator("#pwGo").click(); await cmd.waitForTimeout(1600);
  await cmd.locator('#kingdomPick button[data-k="1"]').click(); await cmd.waitForTimeout(200);
  await cmd.locator('#roster .rp:has-text("900000001")').first().click(); await cmd.locator('#roster .rp:has-text("900000002")').first().click(); await cmd.waitForTimeout(300);
  await cmd.locator('#lead button[data-v="60"]').click().catch(()=>{}); await cmd.waitForTimeout(150);
  await cmd.locator("#fireDouble").click(); await cmd.waitForTimeout(250); await cmd.locator("#fireDouble").click(); // tap-twice
  await p1.waitForTimeout(2500);
  const t = await p1.locator("#lanes .ltime").allTextContents();
  console.log("lane time labels:", JSON.stringify(t));
  console.log("trav dots:", await p1.locator("#lanes .trav").count(), "| radar groups:", await p1.locator("#radar g").count());
  const box=await p1.locator(".pond").boundingBox();
  await p1.screenshot({path:"test/journey/live-map.png",clip:{x:0,y:box.y-2,width:390,height:box.height+150}});
  await b.close(); console.log("saved");
})().catch(e=>{console.error("ERR",e.message);process.exit(2);});
