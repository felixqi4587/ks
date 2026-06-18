/**
 * 1406rocks plan store + cloud gift-code auto-redeem — Cloudflare Worker + KV
 *
 * Plan (unchanged):
 *   GET  /plan    -> public read: { plan, updatedAt, updatedBy }
 *   POST /plan    -> admin write { password, name, plan, baseUpdatedAt } (optimistic lock)
 *
 * Gift-code auto-redeem (cloud, runs from Cloudflare IP; official support confirmed
 * auto-redemption of legitimately-sourced codes is allowed and not penalized):
 *   GET  /codes   -> current active gift codes (auto-collected from kingshot.net)
 *   POST /roster  -> admin { password, [roster:[{name,fid}]] }; returns current roster
 *   POST /redeem  -> admin { password }; redeem all active codes for every roster FID;
 *                    returns a per-fid×code result log
 *   scheduled()   -> same redeem, runs automatically on the cron in wrangler.toml
 *
 * Official redeem API: https://kingshot-giftcode.centurygame.com/api
 *   POST /player    {fid,time,sign}        sign=MD5(sorted "k=v&..." + SALT)
 *   POST /gift_code {fid,cdk,time,sign}    form-urlencoded; no captcha for Kingshot
 */

const KEY = "plan", ROSTER_KEY = "roster", LAST_KEY = "lastRedeem", CODEDB_KEY = "codeDB", DONE_KEY = "done";
const API = "https://kingshot-giftcode.centurygame.com/api";
const SALT = "mN4!pQs6JrYwV9";
const SRC_KINGSHOTNET = "https://kingshot.net/api/gift-codes"; // has expiresAt -> drives cleanup
const SRC_FORGE = "https://kingshotforge.com/api/gift-codes";  // independent infra, active-only
const MAX_FETCH = 45; // stay under the Workers subrequest cap

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors } });
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* ---------- MD5 (Paul Johnston, public domain) ---------- */
function md5(str) {
  function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
  function add(x, y) { var l = (x & 0xFFFF) + (y & 0xFFFF); var m = (x >> 16) + (y >> 16) + (l >> 16); return (m << 16) | (l & 0xFFFF); }
  function cmn(q, a, b, x, s, t) { return add(rl(add(add(a, q), add(x, t)), s), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
  function sb(s) { var bin = [], i; for (i = 0; i < s.length * 8; i += 8) bin[i >> 5] |= (s.charCodeAt(i / 8) & 0xFF) << (i % 32); return bin; }
  function bh(bin) { var h = "0123456789abcdef", s = "", i; for (i = 0; i < bin.length * 4; i++) s += h.charAt((bin[i >> 2] >> ((i % 4) * 8 + 4)) & 0xF) + h.charAt((bin[i >> 2] >> ((i % 4) * 8)) & 0xF); return s; }
  var x = sb(str), len = str.length * 8;
  x[len >> 5] |= 0x80 << (len % 32); x[(((len + 64) >>> 9) << 4) + 14] = len;
  var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878, i;
  for (i = 0; i < x.length; i += 16) {
    var oa = a, ob = b, oc = c, od = d;
    a = ff(a, b, c, d, x[i], 7, -680876936); d = ff(d, a, b, c, x[i + 1], 12, -389564586); c = ff(c, d, a, b, x[i + 2], 17, 606105819); b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, x[i + 4], 7, -176418897); d = ff(d, a, b, c, x[i + 5], 12, 1200080426); c = ff(c, d, a, b, x[i + 6], 17, -1473231341); b = ff(b, c, d, a, x[i + 7], 22, -45705983);
    a = ff(a, b, c, d, x[i + 8], 7, 1770035416); d = ff(d, a, b, c, x[i + 9], 12, -1958414417); c = ff(c, d, a, b, x[i + 10], 17, -42063); b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, x[i + 12], 7, 1804603682); d = ff(d, a, b, c, x[i + 13], 12, -40341101); c = ff(c, d, a, b, x[i + 14], 17, -1502002290); b = ff(b, c, d, a, x[i + 15], 22, 1236535329);
    a = gg(a, b, c, d, x[i + 1], 5, -165796510); d = gg(d, a, b, c, x[i + 6], 9, -1069501632); c = gg(c, d, a, b, x[i + 11], 14, 643717713); b = gg(b, c, d, a, x[i], 20, -373897302);
    a = gg(a, b, c, d, x[i + 5], 5, -701558691); d = gg(d, a, b, c, x[i + 10], 9, 38016083); c = gg(c, d, a, b, x[i + 15], 14, -660478335); b = gg(b, c, d, a, x[i + 4], 20, -405537848);
    a = gg(a, b, c, d, x[i + 9], 5, 568446438); d = gg(d, a, b, c, x[i + 14], 9, -1019803690); c = gg(c, d, a, b, x[i + 3], 14, -187363961); b = gg(b, c, d, a, x[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, x[i + 13], 5, -1444681467); d = gg(d, a, b, c, x[i + 2], 9, -51403784); c = gg(c, d, a, b, x[i + 7], 14, 1735328473); b = gg(b, c, d, a, x[i + 12], 20, -1926607734);
    a = hh(a, b, c, d, x[i + 5], 4, -378558); d = hh(d, a, b, c, x[i + 8], 11, -2022574463); c = hh(c, d, a, b, x[i + 11], 16, 1839030562); b = hh(b, c, d, a, x[i + 14], 23, -35309556);
    a = hh(a, b, c, d, x[i + 1], 4, -1530992060); d = hh(d, a, b, c, x[i + 4], 11, 1272893353); c = hh(c, d, a, b, x[i + 7], 16, -155497632); b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, x[i + 13], 4, 681279174); d = hh(d, a, b, c, x[i], 11, -358537222); c = hh(c, d, a, b, x[i + 3], 16, -722521979); b = hh(b, c, d, a, x[i + 6], 23, 76029189);
    a = hh(a, b, c, d, x[i + 9], 4, -640364487); d = hh(d, a, b, c, x[i + 12], 11, -421815835); c = hh(c, d, a, b, x[i + 15], 16, 530742520); b = hh(b, c, d, a, x[i + 2], 23, -995338651);
    a = ii(a, b, c, d, x[i], 6, -198630844); d = ii(d, a, b, c, x[i + 7], 10, 1126891415); c = ii(c, d, a, b, x[i + 14], 15, -1416354905); b = ii(b, c, d, a, x[i + 5], 21, -57434055);
    a = ii(a, b, c, d, x[i + 12], 6, 1700485571); d = ii(d, a, b, c, x[i + 3], 10, -1894986606); c = ii(c, d, a, b, x[i + 10], 15, -1051523); b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, x[i + 8], 6, 1873313359); d = ii(d, a, b, c, x[i + 15], 10, -30611744); c = ii(c, d, a, b, x[i + 6], 15, -1560198380); b = ii(b, c, d, a, x[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, x[i + 4], 6, -145523070); d = ii(d, a, b, c, x[i + 11], 10, -1120210379); c = ii(c, d, a, b, x[i + 2], 15, 718787259); b = ii(b, c, d, a, x[i + 9], 21, -343485551);
    a = add(a, oa); b = add(b, ob); c = add(c, oc); d = add(d, od);
  }
  return bh([a, b, c, d]);
}
function signParams(params) {
  var base = Object.keys(params).sort().map(function (k) { return k + "=" + params[k]; }).join("&");
  return md5(base + SALT);
}

/* ---------- official API helpers ---------- */
function ksPost(path, params) {
  var signed = Object.assign({}, params, { sign: signParams(params) });
  var body = Object.keys(signed).map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(signed[k]); }).join("&");
  return fetch(API + path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body })
    .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }).catch(function () { return { status: r.status, j: null }; }); });
}
function classify(res) {
  var j = res.j || {}, ec = j.err_code, msg = (j.msg || "").toString();
  if (msg === "SUCCESS" || ec === 20000) return { status: "ok", msg: "成功" };
  if (ec === 40008 || ec === 40011 || msg === "RECEIVED" || msg === "SAME TYPE EXCHANGE") return { status: "already", msg: "已领过" };
  if (ec === 40007 || msg === "TIME ERROR") return { status: "expired", msg: "码已过期" };
  if (ec === 40014 || msg === "CDK NOT FOUND") return { status: "invalid", msg: "码无效" };
  if (ec === 40005 || msg === "USED") return { status: "usedup", msg: "码已用尽" };
  if (ec === 40001 || msg === "role not exist.") return { status: "bad_fid", msg: "FID不存在" };
  if (res.status === 429) return { status: "rate", msg: "限流，请稍后" };
  return { status: "err", msg: msg || ("err_code " + ec) };
}

/* ---------- gift-code collection + redeem ---------- */
async function getJSON(env, key, def) { var r = await env.PLAN_KV.get(key); if (!r) return def; try { return JSON.parse(r); } catch (e) { return def; } }
function fetchJSON(url, cb) {
  return fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }, cf: { cacheTtl: 120 } })
    .then(function (r) { var ct = r.headers.get("content-type") || ""; if (r.status !== 200 || ct.indexOf("application/json") < 0) return; return r.json().then(function (j) { try { cb(j); } catch (e) {} }).catch(function () {}); })
    .catch(function () {});
}
// collect codes from all sources into a persisted codeDB { code:{status,firstSeen,lastSeenAlive,deadHits,expiredAt} }
async function collectCodes(env) {
  var db = await getJSON(env, CODEDB_KEY, {}), now = Date.now();
  function seeActive(code) { code = String(code || "").trim(); if (!code) return; if (!db[code]) db[code] = { status: "active", firstSeen: now, lastSeenAlive: now, deadHits: 0 }; else if (db[code].status !== "expired") { db[code].status = "active"; db[code].lastSeenAlive = now; } }
  function seeExpired(code) { code = String(code || "").trim(); if (!code) return; if (!db[code]) db[code] = { status: "expired", firstSeen: now, deadHits: 0, expiredAt: now }; else { db[code].status = "expired"; if (!db[code].expiredAt) db[code].expiredAt = now; } }
  // source 1: kingshot.net (authoritative expiry)
  await fetchJSON(SRC_KINGSHOTNET, function (j) { var list = (j && j.data && j.data.giftCodes) || []; list.forEach(function (g) { if (!g || !g.code) return; if (g.expiresAt) seeExpired(g.code); else seeActive(g.code); }); });
  // source 2: kingshotforge (active-only, independent infra)
  await fetchJSON(SRC_FORGE, function (j) { var list = (j && j.codes) || []; list.forEach(function (c) { if (c && c.code) seeActive(c.code); }); });
  // source 3: admin-published plan codes (best-effort)
  try { var pr = await env.PLAN_KV.get(KEY); if (pr) { var p = JSON.parse(pr).plan; ((p && p.giftCodes) || []).forEach(function (g) { if (g && g.code) seeActive(g.code); }); } } catch (e) {}
  // drop codes expired for > 30 days
  Object.keys(db).forEach(function (c) { if (db[c].status === "expired" && db[c].expiredAt && now - db[c].expiredAt > 2592000000) delete db[c]; });
  await env.PLAN_KV.put(CODEDB_KEY, JSON.stringify(db));
  return db;
}
async function activeCodes(env) { var db = await collectCodes(env); return Object.keys(db).filter(function (c) { return db[c].status !== "expired"; }); }

// redeem run. force=true -> full pass (manual). force=false -> incremental: only (fid,code) pairs not in the ledger (cron / auto on new code).
async function redeemRun(env, force) {
  var roster = await getJSON(env, ROSTER_KEY, []);
  var db = await collectCodes(env);
  var codes = Object.keys(db).filter(function (c) { return db[c].status !== "expired"; });
  var done = await getJSON(env, DONE_KEY, {});
  var results = [], fetches = 2, doneChanged = false, dbChanged = false, newSuccess = 0;
  for (var a = 0; a < roster.length; a++) {
    var m = roster[a], fid = String(m.fid || "").trim(), name = m.name || fid;
    if (!fid) continue;
    var todo = codes.filter(function (c) { return force || !done[fid + ":" + c]; });
    if (!todo.length) continue;
    if (fetches >= MAX_FETCH) { results.push({ fid: fid, name: name, code: "-", status: "capped", msg: "超出单次上限，下次继续" }); break; }
    var pi = await ksPost("/player", { fid: fid, time: Date.now() }); fetches++;
    if (pi.j && pi.j.data && pi.j.data.nickname) name = pi.j.data.nickname;
    if (classify(pi).status === "bad_fid") { results.push({ fid: fid, name: name, code: "-", status: "bad_fid", msg: "FID不存在" }); continue; }
    await sleep(400);
    for (var b = 0; b < todo.length; b++) {
      var code = todo[b];
      if (fetches >= MAX_FETCH) { results.push({ fid: fid, name: name, code: code, status: "capped", msg: "超出单次上限" }); break; }
      var res = await ksPost("/gift_code", { fid: fid, cdk: code, time: Date.now() }); fetches++;
      if (res.status === 429 && fetches < MAX_FETCH) { await sleep(11000); res = await ksPost("/gift_code", { fid: fid, cdk: code, time: Date.now() }); fetches++; }
      var cl = classify(res);
      results.push({ fid: fid, name: name, code: code, status: cl.status, msg: cl.msg });
      if (cl.status === "ok" || cl.status === "already") { done[fid + ":" + code] = Date.now(); doneChanged = true; if (cl.status === "ok") newSuccess++; }
      else if (cl.status === "expired" || cl.status === "invalid" || cl.status === "usedup") { db[code] = db[code] || { firstSeen: Date.now(), deadHits: 0 }; db[code].status = "expired"; db[code].expiredAt = Date.now(); dbChanged = true; }
      await sleep(500);
    }
  }
  if (doneChanged) { try { await env.PLAN_KV.put(DONE_KEY, JSON.stringify(done)); } catch (e) {} }
  if (dbChanged) { try { await env.PLAN_KV.put(CODEDB_KEY, JSON.stringify(db)); } catch (e) {} }
  var rec = { ranAt: new Date().toISOString(), mode: force ? "manual" : "auto", codes: codes, count: roster.length, newSuccess: newSuccess, results: results };
  if (force || results.length) { try { await env.PLAN_KV.put(LAST_KEY, JSON.stringify(rec)); } catch (e) {} }
  return rec;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (url.pathname === "/plan" && request.method === "GET") {
      const raw = await env.PLAN_KV.get(KEY);
      if (!raw) return json({ plan: null, updatedAt: null, updatedBy: null });
      try { return json(JSON.parse(raw)); } catch { return json({ plan: null, updatedAt: null, updatedBy: null }); }
    }
    if (url.pathname === "/plan" && request.method === "POST") {
      let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      if (!body || body.password !== env.ADMIN_PASS) return json({ error: "wrong password" }, 403);
      if (body.plan == null || typeof body.plan !== "object") return json({ error: "missing plan" }, 400);
      const raw = await env.PLAN_KV.get(KEY);
      const current = raw ? JSON.parse(raw) : null;
      if (current && body.baseUpdatedAt !== undefined && current.updatedAt !== body.baseUpdatedAt) return json({ error: "conflict", current }, 409);
      const record = { plan: body.plan, updatedAt: new Date().toISOString(), updatedBy: (body.name || "").toString().slice(0, 24) };
      await env.PLAN_KV.put(KEY, JSON.stringify(record));
      return json({ ok: true, updatedAt: record.updatedAt, updatedBy: record.updatedBy });
    }

    // ---- gift code: current active codes (public) ----
    if (url.pathname === "/codes" && request.method === "GET") {
      const codes = await activeCodes(env);
      return json({ codes: codes });
    }
    // ---- roster: admin read/write ----
    if (url.pathname === "/roster" && request.method === "POST") {
      let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      if (!body || body.password !== env.ADMIN_PASS) return json({ error: "wrong password" }, 403);
      if (Array.isArray(body.roster)) {
        const clean = body.roster.map(function (m) { return { name: (m.name || "").toString().slice(0, 24), fid: (m.fid || "").toString().replace(/\D/g, "").slice(0, 16) }; }).filter(function (m) { return m.fid; });
        await env.PLAN_KV.put(ROSTER_KEY, JSON.stringify(clean));
        return json({ ok: true, roster: clean });
      }
      const rr = await env.PLAN_KV.get(ROSTER_KEY);
      return json({ ok: true, roster: rr ? JSON.parse(rr) : [] });
    }
    // ---- redeem: admin trigger (cloud, runs from CF IP) ----
    if (url.pathname === "/redeem" && request.method === "POST") {
      let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      if (!body || body.password !== env.ADMIN_PASS) return json({ error: "wrong password" }, 403);
      const rec = await redeemRun(env, true);
      return json({ ok: true, result: rec });
    }
    // ---- last redeem log (public-ish; admin UI shows it) ----
    if (url.pathname === "/lastredeem" && request.method === "GET") {
      const lr = await env.PLAN_KV.get(LAST_KEY);
      return json(lr ? JSON.parse(lr) : { ranAt: null, results: [] });
    }

    if (url.pathname === "/" || url.pathname === "") return json({ ok: true, service: "1406rocks-plan-store" });
    return json({ error: "not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(redeemRun(env, false)); // incremental: auto-redeem newly-detected codes / new members
  },
};
