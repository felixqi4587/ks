require('./support/legacy-kvk-script-guard.cjs')(__filename);
const { chromium } = require("playwright");
(async () => {
  const RM="v8"+Date.now(), base="https://kingshoter.com/kvk.html?k=test&room="+RM+"&notour=1";
  const b=await chromium.launch({headless:true,channel:"chrome",args:["--autoplay-policy=no-user-gesture-required"]});
  let pass=0,fail=0; const ok=(c,l)=>{(c?pass++:fail++);console.log((c?"✓":"✗ FAIL")+" "+l);};
  const errs=[];
  const dis=async p=>{try{await p.keyboard.press("Escape");}catch(e){}try{if(await p.locator("#obGo").isVisible())await p.locator("#obGo").click();}catch(e){}};
  const mk=async(fid,m)=>{const p=await(await b.newContext({viewport:{width:390,height:1200},locale:"en-US"})).newPage();p.on("pageerror",e=>errs.push(fid+":"+e.message));await p.goto(base);await p.waitForLoadState("networkidle");await dis(p);await p.locator("#soundGate").click().catch(()=>{});await p.waitForTimeout(150);await p.locator("#pid").fill(fid);await p.waitForTimeout(1700);await p.locator("#marchRange").fill(String(m));await p.locator("#saveBtn").click();await p.waitForTimeout(700);return p;};
  const hold=async(p,sel)=>{await p.locator(sel).click();await p.waitForTimeout(220);await p.locator(sel).click();await p.waitForTimeout(150);};
  const cmd=await(await b.newContext({viewport:{width:390,height:1200},locale:"en-US"})).newPage();
  cmd.on("pageerror",e=>errs.push("cmd:"+e.message));
  await cmd.goto(base);await cmd.waitForLoadState("networkidle");await dis(cmd);
  await cmd.locator("#soundGate").click().catch(()=>{});await cmd.waitForTimeout(150);await cmd.locator("#cmdUnlock").click();await cmd.locator("#pwInput").fill("pw");await cmd.locator("#pwGo").click();await cmd.waitForTimeout(1600);
  const p1=await mk("207573838","95"), p2=await mk("999999999","70");await cmd.waitForTimeout(900);
  // march shown in roster
  ok(/1:35/.test(await cmd.locator("#roster").textContent()||""),"roster shows each captain's march (1:35)");
  // pick 2 → staged pre-warning reaches a picked captain (p1) while idle
  await cmd.locator("#roster .rp").nth(0).click();await cmd.locator("#roster .rp").nth(1).click();await p1.waitForTimeout(900);
  const pt=(await p1.locator("#stagedLine").textContent()||"");
  ok(/stand by/i.test(pt) && !(await p1.locator("#stagedLine").evaluate(e=>e.classList.contains("hide"))),"picked captain gets the sticky one-line stand-by notice ("+pt.trim()+")");
  // fire → success toast
  await hold(cmd,"#fireDouble");await cmd.waitForTimeout(300);
  ok(/Fired/i.test(await cmd.locator("#toast").textContent()||""),"fire shows 'Fired ✓' confirmation");
  // cancel = two-tap
  await cmd.locator("#cancelBtn").click();await cmd.waitForTimeout(200);
  ok(/again/i.test(await cmd.locator("#toast").textContent()||""),"cancel 1st tap = 'tap again' (no accidental wipe)");
  await cmd.locator("#cancelBtn").click();await cmd.waitForTimeout(500);
  ok(await cmd.locator("#cancelBtn").isDisabled(),"cancel 2nd tap actually cancels (cancel now disabled)");
  ok(await p1.locator("#phero").evaluate(e=>e.classList.contains("hide")),"after cancel, players return to idle (hero hides, no stale banner)");
  ok(errs.length===0,"no page errors"+(errs.length?" → "+errs.join(" | "):""));
  await b.close();console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
})().catch(e=>{console.error("ERR",e.message);process.exit(2);});
