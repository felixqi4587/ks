const { chromium } = require("playwright");
(async () => {
  const RM="shot"+Date.now(), base="https://kingshoter.com/kvk.html?k=test&room="+RM;
  const b=await chromium.launch({headless:true,channel:"chrome",args:["--autoplay-policy=no-user-gesture-required"]});
  const dis=async p=>{try{if(await p.locator("#obGo").isVisible())await p.locator("#obGo").click();}catch(e){}};
  // player with sound enabled → status chip visible
  const p=await(await b.newContext({viewport:{width:390,height:1500},deviceScaleFactor:2,locale:"zh-CN"})).newPage();
  await p.goto(base);await p.waitForLoadState("networkidle");await dis(p);
  await p.locator("#soundGate").click().catch(()=>{});await p.waitForTimeout(400);
  await p.locator("#pid").fill("900000001");await p.waitForTimeout(1600);await p.locator("#saveBtn").click();await p.waitForTimeout(700);
  await p.screenshot({path:"test/journey/bg-player.png"});
  // commander console
  const c=await(await b.newContext({viewport:{width:390,height:1700},deviceScaleFactor:2,locale:"zh-CN"})).newPage();
  await c.goto(base);await c.waitForLoadState("networkidle");await dis(c);
  const p2=await(await b.newContext({viewport:{width:390,height:1200},locale:"zh-CN"})).newPage();await p2.goto(base);await p2.waitForLoadState("networkidle");await dis(p2);await p2.locator("#pid").fill("900000002");await p2.waitForTimeout(1600);await p2.locator("#saveBtn").click();await p2.waitForTimeout(500);
  await c.locator("#cmdUnlock").click();await c.locator("#pwInput").fill("666");await c.locator("#pwGo").click();await c.waitForTimeout(1800);
  await c.locator('#roster .rp:has-text("900000001")').first().click().catch(()=>{});await c.locator('#roster .rp:has-text("900000002")').first().click().catch(()=>{});await c.waitForTimeout(500);
  await c.locator("#console").scrollIntoViewIfNeeded();await c.waitForTimeout(300);
  await c.screenshot({path:"test/journey/bg-commander.png"});
  await b.close();console.log("shots saved");
})().catch(e=>{console.error("ERR",e.message);process.exit(2);});
