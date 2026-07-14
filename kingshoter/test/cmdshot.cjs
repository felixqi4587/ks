const { chromium } = require("playwright");
(async () => {
  const RM="cs"+Date.now(), base="https://kingshoter.com/kvk.html?k=test&room="+RM+"&notour=1";
  const b=await chromium.launch({headless:true,channel:"chrome",args:["--autoplay-policy=no-user-gesture-required"]});
  const mk=async(fid,m,big)=>{const p=await(await b.newContext({viewport:{width:390,height:big?1700:1200,deviceScaleFactor:big?2:1},locale:"zh-CN"})).newPage();await p.goto(base);await p.waitForLoadState("networkidle");await p.keyboard.press("Escape").catch(()=>{});await p.locator("#soundGate").click({force:true});await p.waitForTimeout(200);await p.locator("#pid").fill(fid);await p.waitForTimeout(1500);await p.locator("#marchRange").fill(String(m));await p.locator("#saveBtn").click();await p.waitForTimeout(400);return p;};
  await mk("900000002","75"); await mk("900000003","45");
  const cmd=await mk("900000001","30",true);   // commander is also a filled player
  await cmd.locator("#cmdUnlock").click(); await cmd.locator("#pwInput").fill("666"); await cmd.locator("#pwGo").click(); await cmd.waitForTimeout(1600);
  await cmd.locator('#kingdomPick button[data-k="1"]').click(); await cmd.waitForTimeout(150);
  await cmd.locator('#roster .rp:has-text("900000002")').first().click(); await cmd.locator('#roster .rp:has-text("900000003")').first().click(); await cmd.waitForTimeout(400);
  await cmd.screenshot({path:"test/journey/cmd-idle.png", fullPage:true});
  await cmd.locator('#lead button[data-v="60"]').click().catch(()=>{}); await cmd.waitForTimeout(150);
  await cmd.locator("#fireDouble").click(); await cmd.waitForTimeout(250); await cmd.locator("#fireDouble").click(); await cmd.waitForTimeout(2000);
  console.log("syncPill:", (await cmd.locator("#syncPill").textContent()||"").trim());
  console.log("lane land times:", JSON.stringify(await cmd.locator("#lanes .ltimev").allTextContents()));
  console.log("nowHead present:", await cmd.locator("#nowHead").count(), "| radar folded:", !(await cmd.locator("#radarFold").evaluate(e=>e.open)));
  await cmd.screenshot({path:"test/journey/cmd-live.png", fullPage:true});
  await b.close(); console.log("saved");
})().catch(e=>{console.error("ERR",e.message);process.exit(2);});
