require('./support/legacy-kvk-script-guard.cjs')(__filename);
const { chromium } = require("playwright");
(async () => {
  const b=await chromium.launch({headless:true,channel:"chrome",args:["--autoplay-policy=no-user-gesture-required"]});
  let pass=0,fail=0; const ok=(c,l)=>{(c?pass++:fail++);console.log((c?"✓":"✗ FAIL")+" "+l);};
  const errs=[];
  const dis=async p=>{try{await p.keyboard.press("Escape");}catch(e){}try{if(await p.locator("#obGo").isVisible())await p.locator("#obGo").click();}catch(e){}};
  const RM="f"+Date.now(), base="https://kingshoter.com/kvk.html?k=test&room="+RM+"&notour=1";
  const mk=async(fid,m)=>{const p=await(await b.newContext({viewport:{width:390,height:1100},locale:"en-US"})).newPage();p.on("pageerror",e=>errs.push(fid+":"+e.message));await p.goto(base);await p.waitForLoadState("networkidle");await dis(p);await p.locator("#soundGate").click({force:true}).catch(()=>{});await p.waitForTimeout(150);await p.locator("#pid").fill(fid);await p.waitForTimeout(1700);await p.locator("#marchRange").fill(String(m));await p.locator("#saveBtn").click();await p.waitForTimeout(700);return p;};
  // lang toggle on kvk
  const p=await(await b.newContext({viewport:{width:390,height:1100},locale:"en-US"})).newPage();
  p.on("pageerror",e=>errs.push("kvk:"+e.message));
  await p.goto(base);await p.waitForLoadState("networkidle");await dis(p);
  const enFill=(await p.locator("#t_fill").textContent()||"");
  await p.locator("#langtoggle button").first().click();await p.waitForTimeout(500);
  const zhFill=(await p.locator("#t_fill").textContent()||"");
  ok(/your info/i.test(enFill)&&/填你的信息/.test(zhFill),"kvk language toggle re-renders (en→zh)");
  // per-kingdom lock
  const cmd=await(await b.newContext({viewport:{width:390,height:1100},locale:"en-US"})).newPage();
  cmd.on("pageerror",e=>errs.push("cmd:"+e.message));
  await cmd.goto(base);await cmd.waitForLoadState("networkidle");await dis(cmd);
  await cmd.locator("#soundGate").click({force:true}).catch(()=>{});await cmd.waitForTimeout(150);await cmd.locator("#cmdUnlock").click();await cmd.locator("#pwInput").fill("pw");await cmd.locator("#pwGo").click();await cmd.waitForTimeout(1500);
  await mk("207573838","95");await mk("999999999","70");await cmd.waitForTimeout(1200);
  await cmd.locator("#roster .rp").first().waitFor({timeout:10000});
  await cmd.locator("#roster .rp").nth(0).click();await cmd.locator("#roster .rp").nth(1).click();
  await cmd.locator('#kingdomPick button[data-k="2"]').click();await cmd.waitForTimeout(200);
  ok(await cmd.locator("#roster .rp.sel").count()===0 && await cmd.locator("#roster .rp.otherk").count()===2,"per-kingdom: K1 picks locked on K2");
  // other pages smoke
  for(const pg of ["index","codes","guide"]){
    const pp=await(await b.newContext({viewport:{width:390,height:900},locale:"en-US"})).newPage();
    pp.on("pageerror",e=>errs.push(pg+":"+e.message));
    await pp.goto("https://kingshoter.com/"+pg+".html");await pp.waitForLoadState("networkidle");await pp.waitForTimeout(1200);
    ok(await pp.locator('a[href="kvk.html"], a.on').count()>0 || pg==="index","page "+pg+" loads");
    await pp.close();
  }
  ok(errs.length===0,"no page errors across all pages"+(errs.length?" → "+errs.join(" | "):""));
  await b.close();console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
})().catch(e=>{console.error("ERR",e.message);process.exit(2);});
