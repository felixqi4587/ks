require('./support/legacy-kvk-script-guard.cjs')(__filename);
const { chromium } = require("playwright");
(async () => {
  const RM="s"+Date.now(), base="https://kingshoter.com/kvk.html?k=test&room="+RM;
  const b=await chromium.launch({headless:true,channel:"chrome",args:["--autoplay-policy=no-user-gesture-required"]});
  const dis=async p=>{try{if(await p.locator("#obGo").isVisible())await p.locator("#obGo").click();}catch(e){}};
  const mk=async(fid,m)=>{const p=await(await b.newContext({viewport:{width:390,height:1300},deviceScaleFactor:2,locale:"en-US"})).newPage();await p.goto(base);await p.waitForLoadState("networkidle");await dis(p);await p.locator("#pid").fill(fid);await p.waitForTimeout(1700);await p.locator("#marchRange").fill(String(m));await p.locator("#saveBtn").click();await p.waitForTimeout(700);return p;};
  const hold=async(p,sel)=>{const el=p.locator(sel);await el.dispatchEvent("pointerdown");await p.waitForTimeout(1300);await el.dispatchEvent("pointerup");};
  // fresh commander page: capture fill+idle
  const cmd=await(await b.newContext({viewport:{width:390,height:1300},deviceScaleFactor:2,locale:"en-US"})).newPage();
  await cmd.goto(base);await cmd.waitForLoadState("networkidle");await dis(cmd);await cmd.waitForTimeout(400);
  await cmd.screenshot({path:"test/journey/rb-idle.png"});
  // unlock + players + console
  await cmd.locator("#cmdUnlock").click();await cmd.locator("#pwInput").fill("pw");await cmd.locator("#pwGo").click();await cmd.waitForTimeout(800);
  const p1=await mk("207573838","95"), p2=await mk("999999999","70");await cmd.waitForTimeout(800);
  await cmd.locator("#roster .rp").nth(0).click();await cmd.locator("#roster .rp").nth(1).click();await cmd.waitForTimeout(200);
  await cmd.locator("#console").screenshot({path:"test/journey/rb-console.png"});
  // fire → capture a captain's launch hero mid-countdown
  await hold(cmd,"#fireDouble"); await p1.waitForTimeout(1500);
  await p1.locator("#phero").screenshot({path:"test/journey/rb-launch.png"});
  await b.close();console.log("shots saved");
})().catch(e=>{console.error("ERR",e.message);process.exit(2);});
