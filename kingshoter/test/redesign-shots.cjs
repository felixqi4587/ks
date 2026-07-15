const { chromium } = require("playwright");
(async () => {
  const RM="rd"+Date.now(), base="https://kingshoter.com/kvk.html?k=test&room="+RM;
  const b=await chromium.launch({headless:true,channel:"chrome",args:["--autoplay-policy=no-user-gesture-required"]});
  const newp=async()=>{const p=await(await b.newContext({viewport:{width:390,height:1700},deviceScaleFactor:2,locale:"zh-CN"})).newPage();await p.goto(base);await p.waitForLoadState("networkidle");await p.keyboard.press("Escape").catch(()=>{});await p.waitForTimeout(400);return p;};
  // a teammate so radar/lanes have rows
  const mate=await newp(); await mate.locator("#soundGate").click().catch(()=>{}); await mate.waitForTimeout(200); await mate.locator("#pid").fill("900000002"); await mate.waitForTimeout(1500); await mate.locator("#marchRange").fill("75"); await mate.locator("#saveBtn").click(); await mate.waitForTimeout(500);
  // main page
  const p=await newp();
  await p.screenshot({path:"test/journey/rd1-locked.png"});
  console.log("presound?", await p.evaluate(()=>document.getElementById("roomView").classList.contains("presound")));
  console.log("hero1:", (await p.locator("#pheroTitle").textContent()||"").trim(), "|", (await p.locator("#pheroSub").textContent()||"").trim());
  await p.locator("#soundGate").click(); await p.waitForTimeout(300);
  await p.locator("#pid").fill("900000001"); await p.waitForTimeout(1500); await p.locator("#marchRange").fill("35"); await p.locator("#saveBtn").click(); await p.waitForTimeout(800);
  console.log("hero2:", (await p.locator("#pheroTitle").textContent()||"").trim());
  console.log("radar dots:", await p.locator("#radar circle").count(), "| lanes:", await p.locator("#lanes .lane").count());
  await p.screenshot({path:"test/journey/rd2-ready.png"});
  // commander
  await p.locator("#cmdUnlock").click(); await p.waitForTimeout(300); await p.locator("#pwInput").fill("666"); await p.locator("#pwGo").click(); await p.waitForTimeout(1600);
  await p.keyboard.press("Escape").catch(()=>{}); await p.waitForTimeout(300);
  await p.locator('#roster .rp:has-text("900000001")').first().click().catch(()=>{}); await p.locator('#roster .rp:has-text("900000002")').first().click().catch(()=>{}); await p.waitForTimeout(500);
  console.log("console visible:", await p.locator("#console").isVisible(), "| cstep1:", (await p.locator("#cstep1").textContent()||"").trim());
  await p.locator("#console").scrollIntoViewIfNeeded(); await p.waitForTimeout(300);
  await p.screenshot({path:"test/journey/rd3-console.png"});
  const errs=[]; p.on("pageerror",e=>errs.push(e.message));
  console.log("done");
  await b.close();
})().catch(e=>{console.error("ERR",e.message);process.exit(2);});
