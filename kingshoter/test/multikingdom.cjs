// concurrent multi-kingdom: firing K2 must NOT wipe K1's live rally (audit blocker #1)
const { chromium } = require("playwright");
(async () => {
  const HOST=process.argv[2]||"https://kingshoter.com";
  const RM="mk"+Date.now(), base=HOST+"/kvk.html?k=test&room="+RM+"&notour=1";
  const b=await chromium.launch({headless:true,channel:"chrome",args:["--autoplay-policy=no-user-gesture-required"]});
  let pass=0,fail=0; const ok=(c,l)=>{(c?pass++:fail++);console.log((c?"✓":"✗ FAIL")+" "+l);};
  const errs=[];
  const dis=async p=>{try{await p.keyboard.press("Escape");}catch(e){}try{if(await p.locator("#obGo").isVisible())await p.locator("#obGo").click();}catch(e){}};
  const mk=async(fid,m)=>{const p=await(await b.newContext({viewport:{width:390,height:1300},locale:"en-US"})).newPage();p.on("pageerror",e=>errs.push(fid+":"+e.message));await p.goto(base);await p.waitForLoadState("networkidle");await dis(p);await p.locator("#soundGate").click().catch(()=>{});await p.waitForTimeout(150);await p.locator("#pid").fill(fid);await p.waitForTimeout(1700);await p.locator("#marchRange").fill(String(m));await p.locator("#saveBtn").click();await p.waitForTimeout(600);return p;};
  const fire2=async(p,sel)=>{await p.locator(sel).click();await p.waitForTimeout(240);await p.locator(sel).click();await p.waitForTimeout(250);};
  const pick=async(cmd,kd,ids)=>{await cmd.locator(`#kingdomPick button[data-k="${kd}"]`).click();await cmd.waitForTimeout(350);for(const id of ids){await cmd.locator(`#roster .rp:has-text("${id}")`).first().click();await cmd.waitForTimeout(180);}};
  const p1=await mk("900000001","60"),p2=await mk("900000002","60"),p3=await mk("900000003","60"),p4=await mk("900000004","60");
  const cmd=await(await b.newContext({viewport:{width:390,height:1300},locale:"en-US"})).newPage();
  cmd.on("pageerror",e=>errs.push("cmd:"+e.message));
  await cmd.goto(base);await cmd.waitForLoadState("networkidle");await dis(cmd);
  await cmd.locator("#soundGate").click().catch(()=>{});await cmd.waitForTimeout(150);await cmd.locator("#cmdUnlock").click();await cmd.locator("#pwInput").fill("666");await cmd.locator("#pwGo").click();await cmd.waitForTimeout(2500);
  await pick(cmd,1,["900000001","900000002"]);await fire2(cmd,"#fireDouble");await cmd.waitForTimeout(600);
  await pick(cmd,2,["900000003","900000004"]);await fire2(cmd,"#fireDouble");await cmd.waitForTimeout(1300);
  const t1=(await p1.locator("#pheroTitle").textContent()||"").trim();
  const t3=(await p3.locator("#pheroTitle").textContent()||"").trim();
  ok(/YOU|🚗/i.test(t1)&&!/Whales|🐋|Ready ·|waiting/i.test(t1),"K1 captain STILL has a personal countdown after K2 fired ("+t1+")");
  ok(/YOU|🚗/i.test(t3)&&!/Whales|🐋|Ready ·|waiting/i.test(t3),"K2 captain has its own personal countdown ("+t3+")");
  ok(errs.length===0,"no page errors"+(errs.length?" → "+errs.join(" | "):""));
  await Promise.race([b.close(),new Promise(resolve=>setTimeout(resolve,3000))]);
  console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
})().catch(e=>{console.error("ERR",e.message);process.exit(2);});
