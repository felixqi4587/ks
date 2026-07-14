// ready-check: staged captain taps Ready → commander roster shows a green dot
const { chromium } = require("playwright");
(async () => {
  const RM="rd"+Date.now(), base="https://kingshoter.com/kvk.html?k=test&room="+RM+"&notour=1";
  const b=await chromium.launch({headless:true,channel:"chrome",args:["--autoplay-policy=no-user-gesture-required"]});
  let pass=0,fail=0; const ok=(c,l)=>{(c?pass++:fail++);console.log((c?"✓":"✗ FAIL")+" "+l);};
  const errs=[];
  const dis=async p=>{try{await p.keyboard.press("Escape");}catch(e){}try{if(await p.locator("#obGo").isVisible())await p.locator("#obGo").click();}catch(e){}};
  const mk=async(fid,m)=>{const p=await(await b.newContext({viewport:{width:390,height:1300},locale:"en-US"})).newPage();p.on("pageerror",e=>errs.push(fid+":"+e.message));await p.goto(base);await p.waitForLoadState("networkidle");await dis(p);await p.locator("#soundGate").click().catch(()=>{});await p.waitForTimeout(150);await p.locator("#pid").fill(fid);await p.waitForTimeout(1700);await p.locator("#marchRange").fill(String(m));await p.locator("#saveBtn").click();await p.waitForTimeout(600);return p;};
  const p1=await mk("900000001","60"),p2=await mk("900000002","60");
  const cmd=await(await b.newContext({viewport:{width:390,height:1300},locale:"en-US"})).newPage();
  cmd.on("pageerror",e=>errs.push("cmd:"+e.message));
  await cmd.goto(base);await cmd.waitForLoadState("networkidle");await dis(cmd);
  await cmd.locator("#soundGate").click().catch(()=>{});await cmd.waitForTimeout(150);await cmd.locator("#cmdUnlock").click();await cmd.locator("#pwInput").fill("666");await cmd.locator("#pwGo").click();await cmd.waitForTimeout(2200);
  ok(await cmd.locator("#readyBtn").count()===0,"no manual Ready button anywhere (auto-ready)");
  await cmd.locator('#roster .rp:has-text("900000001")').first().click();await cmd.locator('#roster .rp:has-text("900000002")').first().click();await cmd.waitForTimeout(900);
  ok(/🟢/.test(await cmd.locator("#roster").textContent()||""),"present+filled captains auto-show the green ready dot");
  ok(/2\/2/.test(await cmd.locator("#syncPill").textContent()||""),"sync pill auto-reads 2/2 synced & present (no tap)");
  ok(errs.length===0,"no page errors"+(errs.length?" → "+errs.join(" | "):""));
  await b.close();console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
})().catch(e=>{console.error("ERR",e.message);process.exit(2);});
