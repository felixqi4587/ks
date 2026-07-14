// the onboarding-clarity redesign: forced flow, honest hero, unset march, dual map, quiet commander link + read-only auth, room-wide confirm
const { chromium } = require("playwright");
(async () => {
  const RM="rdx"+Date.now(), base="https://kingshoter.com/kvk.html?k=test&room="+RM+"&notour=1";
  const b=await chromium.launch({headless:true,channel:"chrome",args:["--autoplay-policy=no-user-gesture-required"]});
  let pass=0,fail=0; const ok=(c,l)=>{(c?pass++:fail++);console.log((c?"✓":"✗ FAIL")+" "+l);};
  const errs=[];
  const dis=async p=>{try{await p.keyboard.press("Escape");}catch(e){}};
  const mk=async(fid,m)=>{const p=await(await b.newContext({viewport:{width:390,height:1500},locale:"en-US"})).newPage();p.on("pageerror",e=>errs.push(fid+":"+e.message));await p.goto(base);await p.waitForLoadState("networkidle");await dis(p);await p.locator("#soundGate").click({force:true});await p.waitForTimeout(250);await p.locator("#pid").fill(fid);await p.waitForTimeout(1500);await p.locator("#marchRange").fill(String(m));await p.locator("#saveBtn").click();await p.waitForTimeout(500);return p;};
  // teammates for the map
  await mk("900000002","75"); await mk("900000003","45");
  // main: fresh, locked
  const p=await(await b.newContext({viewport:{width:390,height:1500},locale:"en-US"})).newPage();
  p.on("pageerror",e=>errs.push("p:"+e.message));
  await p.goto(base);await p.waitForLoadState("networkidle");await dis(p);
  ok(await p.locator("#roomView").evaluate(e=>e.classList.contains("presound")),"fresh load: page locked (presound) until sound");
  ok(await p.locator("#phero").evaluate(e=>e.classList.contains("hide")),"hero stays hidden, not a false Ready");
  ok((await p.locator("#marchBig").textContent())==="—:—","march default is unset (—:—)");
  ok(await p.locator("#saveBtn").evaluate(e=>e.classList.contains("dim")),"submit dimmed until march is touched (tap now explains instead of dying)");
  ok(await p.locator("#cmdUnlock").evaluate(e=>e.classList.contains("cmdlink")),"commander entry is a quiet link, not an amber wall");
  // enable sound → unlock the page
  await p.locator("#soundGate").click({force:true}); await p.waitForTimeout(300);
  ok(!(await p.locator("#roomView").evaluate(e=>e.classList.contains("presound"))),"enabling sound unlocks the page");
  await p.locator("#pid").fill("900000001"); await p.waitForTimeout(1500); await p.locator("#marchRange").fill("30"); 
  ok((await p.locator("#marchBig").textContent())!=="—:—" && !(await p.locator("#saveBtn").evaluate(e=>e.classList.contains("dim"))),"touching the slider shows the value + enables submit");
  await p.locator("#saveBtn").click(); await p.waitForTimeout(800);
  ok(await p.locator("#phero").evaluate(e=>e.classList.contains("hide")) && /900000001/.test(await p.locator("#youChip").textContent()||""),"after filling: no idle hero card — #youChip carries the reassurance instead");
  // dual map: radar dots + timeline lanes, 30 vs 45 distinct
  ok((await p.locator("#radar circle").count())>=3,"radar renders dots");
  const lanes=await p.locator("#lanes .lane").count(); ok(lanes>=3,"timeline lanes render ("+lanes+" rows)");
  const lefts=await p.locator("#lanes .ldot").evaluateAll(els=>els.map(e=>parseFloat(e.style.left)));
  ok(new Set(lefts.map(x=>Math.round(x))).size===lefts.length,"each march sits at a distinct lane position (30 vs 45 distinguishable)");
  // settings folded
  ok(!(await p.locator("#settings").evaluate(e=>e.open)),"alert settings folded by default");
  // wrong password: modal stays, inline error, console NOT open, no config write
  await p.locator("#cmdUnlock").click(); await p.waitForTimeout(200);
  await p.locator("#pwInput").fill("000"); await p.locator("#pwGo").click(); await p.waitForTimeout(1800);
  // a teammate already set the password? no — first unlock here sets it; so use a 2nd page to test wrong pw
  await b.close();
  // wrong-password test in its own room (seed pw first)
  const b2=await chromium.launch({headless:true,channel:"chrome"});
  const RM2="rdw"+Date.now(), base2="https://kingshoter.com/kvk.html?k=test&room="+RM2+"&notour=1";
  const owner=await(await b2.newContext({locale:"en-US"})).newPage(); await owner.goto(base2); await owner.waitForLoadState("networkidle"); await owner.keyboard.press("Escape").catch(()=>{});
  await owner.locator("#soundGate").click({force:true}); await owner.waitForTimeout(200);
  await owner.locator("#cmdUnlock").click(); await owner.locator("#pwInput").fill("realpw"); await owner.locator("#pwGo").click(); await owner.waitForTimeout(1600);
  const guess=await(await b2.newContext({locale:"en-US"})).newPage(); await guess.goto(base2); await guess.waitForLoadState("networkidle"); await guess.keyboard.press("Escape").catch(()=>{});
  await guess.locator("#soundGate").click({force:true}); await guess.waitForTimeout(200);
  await guess.locator("#cmdUnlock").click(); await guess.locator("#pwInput").fill("wrong"); await guess.locator("#pwGo").click(); await guess.waitForTimeout(1600);
  ok(await guess.locator("#pwOvl").evaluate(e=>e.classList.contains("show")),"wrong password keeps the modal open");
  ok(/wrong|错误/i.test(await guess.locator("#pwMsg").textContent()||""),"wrong password shows inline error");
  ok(!(await guess.locator("#console").isVisible()),"wrong password does NOT open the console");
  ok(errs.length===0,"no page errors"+(errs.length?" → "+errs.join(" | "):""));
  await b2.close();console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
})().catch(e=>{console.error("ERR",e.message);process.exit(2);});
