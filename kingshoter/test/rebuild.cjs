const { chromium } = require("playwright");
const secs = s => { s=(s||"").trim(); if(/^\d+$/.test(s))return+s; const m=s.match(/(\d+):(\d+)/); return m?+m[1]*60+ +m[2]:999; };
(async () => {
  const RM="rb"+Date.now(), base="https://kingshoter.com/kvk.html?k=test&room="+RM+"&notour=1";
  const b=await chromium.launch({headless:true,channel:"chrome",args:["--autoplay-policy=no-user-gesture-required"]});
  let pass=0,fail=0; const ok=(c,l)=>{(c?pass++:fail++);console.log((c?"✓":"✗ FAIL")+" "+l);};
  const errs=[];
  const dis=async p=>{try{await p.keyboard.press("Escape");}catch(e){}try{if(await p.locator("#obGo").isVisible())await p.locator("#obGo").click();}catch(e){}};
  const mk=async(fid,m)=>{const p=await(await b.newContext({viewport:{width:390,height:1100},locale:"en-US"})).newPage();p.on("pageerror",e=>errs.push(fid+":"+e.message));await p.goto(base);await p.waitForLoadState("networkidle");await dis(p);await p.locator("#soundGate").click().catch(()=>{});await p.waitForTimeout(150);await p.locator("#pid").fill(fid);await p.waitForTimeout(1700);await p.locator("#marchRange").fill(String(m));await p.locator("#saveBtn").click();await p.waitForTimeout(700);return p;};
  const hold=async(p,sel)=>{await p.locator(sel).click();await p.waitForTimeout(220);await p.locator(sel).click();await p.waitForTimeout(150);};
  // commander
  const cmd=await(await b.newContext({viewport:{width:390,height:1100},locale:"en-US"})).newPage();
  cmd.on("pageerror",e=>errs.push("cmd:"+e.message));
  await cmd.goto(base);await cmd.waitForLoadState("networkidle");await dis(cmd);
  ok(await cmd.locator("#roomView").evaluate(e=>e.classList.contains("presound")),"page is locked until sound is enabled (presound)");
  ok(await cmd.locator("#phero").evaluate(e=>e.classList.contains("hide")),"hero stays hidden (never a false Ready) until sound+march are done");
  await cmd.locator("#soundGate").click().catch(()=>{});await cmd.waitForTimeout(150);await cmd.locator("#cmdUnlock").click();await cmd.locator("#pwInput").fill("pw");await cmd.locator("#pwGo").click();await cmd.waitForTimeout(1600);
  ok(await cmd.locator("#console").isVisible(),"commander console opens (roomy)");
  ok(await cmd.locator("#chrome").evaluate(e=>e.classList.contains("cmd")),"chrome tints to commander mode");
  ok(await cmd.locator("#cancelBtn").isDisabled(),"cancel disabled when no command");
  const p1=await mk("207573838","95"), p2=await mk("999999999","70"), p3=await mk("123456789","50");
  await cmd.waitForTimeout(900);
  ok(await cmd.locator("#roster .rp").count()===3,"roster shows 3 players");
  await cmd.locator("#roster .rp").nth(0).click();await cmd.locator("#roster .rp").nth(1).click();
  ok((await cmd.locator("#pickCnt").textContent()||"")==="2/2","pick counter shows 2/2");
  await hold(cmd,"#fireDouble"); await p1.waitForTimeout(1200);
  ok(await cmd.locator("#cancelBtn").isDisabled()===false,"cancel enabled after fire");
  // players: two captains different countdown, all < 90s (click time, not 5min)
  const reads=[]; for(const p of [p1,p2,p3]) reads.push({t:(await p.locator("#pheroTitle").textContent()||"").trim(),cd:secs(await p.locator("#pheroNum").textContent())});
  reads.forEach((r,i)=>console.log("  p"+(i+1),JSON.stringify(r)));
  const caps=reads.filter(r=>/YOU/.test(r.t)), non=reads.filter(r=>/Whales|🐋/.test(r.t));
  ok(reads.every(r=>r.cd<200),"all countdowns are click-times (<200s, no 5min bug)");
  ok(caps.length===2 && caps[0].cd!==caps[1].cd,"two captains staggered");
  ok(non.length===1,"non-captain sees 'Whales launch'");
  ok((await p1.locator("#lanes .lane").count())>0 && (await p1.locator("#radar circle").count())>0,"map renders radar + timeline lanes");
  ok(errs.length===0,"no page errors"+(errs.length?" → "+errs.join(" | "):""));
  await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{console.error("ERR",e.message);process.exit(2);});
