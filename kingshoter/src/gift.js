/* kingshoter hidden gift-code auto-redeem — ported from the private 1406rocks worker.
 *
 * NOT linked anywhere public. Serves the small-team hidden page (g666.html) under /api/g/*:
 *   POST /auth          { password }                    -> gate check (against env.MASTER)
 *   GET  /codes         active codes + dead history (collected live)
 *   POST /roster        { password, [roster] }          -> read/write team roster
 *   POST /redeem        { password }                    -> redeem all active codes for the whole roster
 *   POST /ingest        { password, code|text }         -> seed a hand-fed code, redeem immediately
 *   POST /lastredeem    { password }                    -> last run log
 *   POST /notifytoken   { password, url }               -> Discord webhook for success pings
 *   POST /notifystatus  { password }
 *   POST /discordtoken  { password, token }             -> official-channel watch bot token
 *   POST /discordstatus { password }
 *   POST /discordpoll   { password }                    -> manual poll (same as 1-min cron)
 *   POST /testcode      { password, fid, code }         -> one real probe, raw verdict
 *   POST /statedump     { password }                    -> done ledger + codeDB diagnostic
 *   POST /srcdebug      { password }                    -> per-source reachability diagnostic
 *   giftScheduled()     cron: 1-min Discord watch, 5-min source sweep + auto-redeem
 *
 * KV: env.GIFT_KV — the SAME namespace the old worker used (PLAN_KV, id 16ffe9…), so the
 * roster / codeDB / done-ledger / tokens carry over with zero migration.
 *
 * Official redeem API: https://kingshot-giftcode.centurygame.com/api
 *   POST /player    {fid,time,sign}        sign=MD5(sorted "k=v&..." + SALT)
 *   POST /gift_code {fid,cdk,time,sign}    form-urlencoded; no captcha for Kingshot
 */

const ROSTER_KEY = "roster", LAST_KEY = "lastRedeem", CODEDB_KEY = "codeDB", DONE_KEY = "done", NOTIFY_KEY = "notifyHook", PLAN_KEY = "plan";
const CANARY_FID = "207573838"; // probe new/unconfirmed codes on this single account first; only fan out to the team if it's live
const DTOKEN_KEY = "discordToken", DSTATE_KEY = "discordState"; // direct official Discord channel watch
const DISCORD_API = "https://discord.com/api/v10";
const API = "https://kingshot-giftcode.centurygame.com/api";
const SALT = "mN4!pQs6JrYwV9";
const SRC_KINGSHOTNET = "https://kingshot.net/api/gift-codes"; // has expiresAt -> authoritative expiry
const SRC_FORGE = "https://kingshotforge.com/api/gift-codes";  // independent infra, active-only
const SRC_KSREDEEM = "https://ksredeem.com/api/codes";         // ~1-min refresh, carries exclusive limited/random-string codes
const SRC_KSWIKI = "https://kingshotwiki.com/giftcodes/";       // community wiki (HTML page); codes in <span class="code">…</span>
const MAX_FETCH = 45; // stay under the Workers subrequest cap

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
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
  // limited code whose global redemption cap is exhausted (e.g. livestream/influencer codes)
  if (/claim\s*limit|limit\s*reached|claimed\s*out|max(imum)?\s*(claim|redeem)/i.test(msg)) return { status: "limited", msg: "限量已抢光" };
  if (res.status === 429) return { status: "rate", msg: "限流，请稍后" };
  return { status: "err", msg: msg || ("err_code " + ec) };
}

// extract candidate gift codes from free-form text (e.g. a pasted/forwarded official Discord post)
var CODE_NOISE = { REDEEM: 1, REWARD: 1, REWARDS: 1, GIFT: 1, GIFTCODE: 1, GIFTCODES: 1, CODE: 1, CODES: 1, CLAIM: 1, CLICK: 1, HTTPS: 1, PLAYER: 1, ENTER: 1, KINGSHOT: 1, EXPIRES: 1, INSIDE: 1, LIMITED: 1, OFFICIAL: 1, REDEEMED: 1, REWARDED: 1, INGAME: 1,
  CENTER: 1, WEBSITE: 1, VALID: 1, UNTIL: 1, BELOW: 1, HERE: 1, GOVERNORS: 1, BOOKMARK: 1, ACCESS: 1, UPDATED: 1, ACTIVE: 1, CONCIERGE: 1, MEMBER: 1, NOTE: 1,
  JANUARY: 1, FEBRUARY: 1, MARCH: 1, APRIL: 1, JUNE: 1, JULY: 1, AUGUST: 1, SEPTEMBER: 1, OCTOBER: 1, NOVEMBER: 1, DECEMBER: 1 };
function extractCodes(text) {
  text = String(text || ""); var found = {}, m;
  // PRIORITY 1: backtick/bold-wrapped tokens. Official posts wrap the real code (`BESTDAD0621`); if any
  // wrapped token exists, trust ONLY those — avoids grabbing "Gift Code Center", "June", URL hashes, etc.
  var reWrap = /[`*]{1,3}([A-Za-z0-9]{4,20})[`*]{1,3}/g;
  while ((m = reWrap.exec(text))) { if (!CODE_NOISE[m[1].toUpperCase()]) found[m[1]] = 1; }
  if (Object.keys(found).length) return Object.keys(found);
  // PRIORITY 2: explicit "code: XXXX" / "兑换码：XXXX" (needs a : ： = separator, not a bare space)
  var reKey = /(?:gift\s*code|cdk|兑换码|礼包码|\bcode)[\s]*[:：=][\s]*[`*"'“”]*([A-Za-z0-9]{4,20})/gi;
  while ((m = reKey.exec(text))) { if (!CODE_NOISE[m[1].toUpperCase()]) found[m[1]] = 1; }
  if (Object.keys(found).length) return Object.keys(found);
  // PRIORITY 3: fallback — digit-bearing or all-caps tokens
  var reTok = /\b([A-Za-z0-9]{5,20})\b/g;
  while ((m = reTok.exec(text))) { var t = m[1]; if ((/\d/.test(t) || t === t.toUpperCase()) && !CODE_NOISE[t.toUpperCase()]) found[t] = 1; }
  return Object.keys(found);
}

/* ---------- gift-code collection + redeem ---------- */
async function getJSON(env, key, def) { var r = await env.GIFT_KV.get(key); if (!r) return def; try { return JSON.parse(r); } catch (e) { return def; } }
function fetchJSON(url, cb) {
  return fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }, cf: { cacheTtl: 120 } })
    .then(function (r) { var ct = r.headers.get("content-type") || ""; if (r.status !== 200 || ct.indexOf("application/json") < 0) return; return r.json().then(function (j) { try { cb(j); } catch (e) {} }).catch(function () {}); })
    .catch(function () {});
}
// fetch an HTML page and hand the raw text to cb (for community pages with no JSON API, e.g. kingshotwiki)
function fetchText(url, cb) {
  return fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html" }, cf: { cacheTtl: 120 } })
    .then(function (r) { if (r.status !== 200) return; return r.text().then(function (t) { try { cb(t); } catch (e) {} }).catch(function () {}); })
    .catch(function () {});
}
// pull gift codes out of the kingshotwiki HTML (each code sits in <span class="code">CODE</span>)
function parseKswiki(html, cb) { var re = /<span class="code">([^<]{2,24})<\/span>/g, m; while ((m = re.exec(html))) { var c = m[1].trim(); if (/^[A-Za-z0-9]{4,20}$/.test(c)) cb(c); } }
// collect codes from all sources into a persisted codeDB { code:{status,firstSeen,lastSeenAlive,deadHits,expiredAt} }
async function collectCodes(env) {
  var db = await getJSON(env, CODEDB_KEY, {}), now = Date.now(), before = JSON.stringify(db), seen = {};
  // Gather VOTES from every source, then apply. The official API (in redeemRun) is the ONLY authority that
  // permanently kills a code (db[code].apiDead). A third-party "expired" flag is only a HINT and must NOT kill a
  // code another source still lists active.
  var activeVote = {}, expHint = {}, srcOf = {};
  function active(code, src) { code = String(code || "").trim(); if (!code) return; seen[code] = 1; activeVote[code] = 1; if (!srcOf[code]) srcOf[code] = src; }
  function expHintFn(code, src) { code = String(code || "").trim(); if (!code) return; seen[code] = 1; expHint[code] = 1; if (!srcOf[code]) srcOf[code] = src; }
  // source 1: kingshot.net (carries expiresAt — treated as an expiry HINT, not gospel)
  await fetchJSON(SRC_KINGSHOTNET, function (j) { var list = (j && j.data && j.data.giftCodes) || []; list.forEach(function (g) { if (!g || !g.code) return; if (g.expiresAt) expHintFn(g.code, "kingshot.net"); else active(g.code, "kingshot.net"); }); });
  // source 2: kingshotforge (active-only, independent infra)
  await fetchJSON(SRC_FORGE, function (j) { var list = (j && j.codes) || []; list.forEach(function (c) { if (c && c.code) active(c.code, "forge"); }); });
  // source 3: ksredeem (~1-min refresh, exclusive limited codes); trust only RECENT entries
  var ksFresh = now - 1814400000; // 21 days
  await fetchJSON(SRC_KSREDEEM, function (j) {
    var list = (j && j.codes) || [];
    list.forEach(function (c) {
      if (!c || !c.code || c.status === "expired") return;
      var t = c.discovered_at ? Date.parse(c.discovered_at) : NaN;
      if (isNaN(t) || t >= ksFresh) active(c.code, "ksredeem"); // keep if recent or undated
    });
  });
  // source 4: kingshotwiki community page (HTML scrape)
  await fetchText(SRC_KSWIKI, function (html) { parseKswiki(html, function (code) { active(code, "kingshotwiki"); }); });
  // source 5: admin-published plan codes from the legacy saltyfish site (same KV; best-effort)
  try { var pr = await env.GIFT_KV.get(PLAN_KEY); if (pr) { var p = JSON.parse(pr).plan; ((p && p.giftCodes) || []).forEach(function (g) { if (g && g.code) active(g.code, "plan"); }); } } catch (e) {}
  // apply votes: ANY live source => active; an expiry hint only wins when NO source lists it active. apiDead is sticky.
  Object.keys(seen).forEach(function (code) {
    var d = db[code] || (db[code] = { firstSeen: now, deadHits: 0 });
    if (!d.src && srcOf[code]) d.src = srcOf[code];
    if (d.apiDead) return;
    if (activeVote[code]) { d.status = "active"; if (d.expiredAt) delete d.expiredAt; }
    else if (expHint[code]) { d.status = "expired"; if (!d.expiredAt) d.expiredAt = now; }
  });
  // cleanup (self-bounding): invalid -> delete on sight; dead tombstones pruned once every source drops them (+7d grace)
  Object.keys(db).forEach(function (c) {
    var d = db[c];
    if (d.status === "invalid") { delete db[c]; return; }
    if (d.status === "expired" || d.status === "usedup") {
      var dead = d.deadAt || d.expiredAt || 0;
      var recent = dead && (now - dead < 604800000); // 7-day grace
      if (!seen[c] && !recent) delete db[c];
    }
  });
  if (JSON.stringify(db) !== before) { try { await env.GIFT_KV.put(CODEDB_KEY, JSON.stringify(db)); } catch (e) {} }
  return db;
}

// redeem run — incremental for API CALLS (only attempt fid:code not yet confirmed), but the
// returned `results` is a FULL MATRIX: every roster member × every active code. Confirmed pairs are
// never re-attempted (auto OR manual). Canary-first: unproven codes probe one account before fan-out.
async function redeemRun(env, trigger, skipCollect) {
  var roster = await getJSON(env, ROSTER_KEY, []);
  var db = skipCollect ? await getJSON(env, CODEDB_KEY, {}) : await collectCodes(env);
  // newest-first: time-sensitive / limited codes get attempted before the MAX_FETCH budget runs out
  var codes = Object.keys(db).filter(function (c) { return db[c].status === "active"; })
    .sort(function (x, y) { return (db[y].firstSeen || 0) - (db[x].firstSeen || 0); });
  var done = await getJSON(env, DONE_KEY, {});
  var ordered = roster.slice().sort(function (a, b) { return ((String(a.fid).trim() === CANARY_FID) ? 0 : 1) - ((String(b.fid).trim() === CANARY_FID) ? 0 : 1); });
  var probeFid = ordered.length ? String(ordered[0].fid || "").trim() : ""; // canary if present, else first member
  var goodCodes = {}; Object.keys(done).forEach(function (k) { var i = k.indexOf(":"); if (i > 0) goodCodes[k.slice(i + 1)] = 1; }); // codes already confirmed live for someone
  var deadThisRun = {};
  var results = [], fetches = 0, doneChanged = false, dbChanged = false, newSuccess = 0, skipped = 0, newCodes = {};
  for (var a = 0; a < ordered.length; a++) {
    var m = ordered[a], fid = String(m.fid || "").trim(), name = m.name || fid;
    if (!fid) continue;
    var isProbe = (fid === probeFid);
    // only the probe attempts unconfirmed codes; others attempt only codes already proven live (goodCodes)
    var attemptable = codes.filter(function (c) { return !done[fid + ":" + c] && !deadThisRun[c] && (isProbe || goodCodes[c]); });
    // /player FIRST establishes the login session — official /gift_code returns "NOT LOGIN" without it.
    if (attemptable.length && fetches < MAX_FETCH) {
      var pi = await ksPost("/player", { fid: fid, time: Date.now() }); fetches++;
      if (pi.j && pi.j.data && pi.j.data.nickname) name = pi.j.data.nickname;
      if (classify(pi).status === "bad_fid") { results.push({ fid: fid, name: name, code: "-", status: "bad_fid", msg: "FID不存在" }); continue; }
      await sleep(300);
    }
    for (var b = 0; b < codes.length; b++) {
      var code = codes[b];
      if (done[fid + ":" + code]) { results.push({ fid: fid, name: name, code: code, status: "already", msg: "已兑换" }); skipped++; continue; }
      if (deadThisRun[code]) { results.push({ fid: fid, name: name, code: code, status: (db[code] && db[code].status) || "expired", msg: "已失效" }); continue; }
      if (!isProbe && !goodCodes[code]) { results.push({ fid: fid, name: name, code: code, status: "pending", msg: "待验证" }); continue; } // not proven live yet — leave for the probe
      if (fetches >= MAX_FETCH) { results.push({ fid: fid, name: name, code: code, status: "capped", msg: "超上限,下次" }); continue; }
      var res = await ksPost("/gift_code", { fid: fid, cdk: code, time: Date.now() }); fetches++;
      if (res.status === 429 && fetches < MAX_FETCH) { await sleep(11000); res = await ksPost("/gift_code", { fid: fid, cdk: code, time: Date.now() }); fetches++; }
      var cl = classify(res);
      results.push({ fid: fid, name: name, code: code, status: cl.status, msg: cl.msg });
      if (cl.status === "ok" || cl.status === "already") { done[fid + ":" + code] = Date.now(); doneChanged = true; goodCodes[code] = 1; db[code] = db[code] || { firstSeen: Date.now(), deadHits: 0 }; if (db[code].status !== "active" || db[code].apiDead) { db[code].status = "active"; delete db[code].apiDead; delete db[code].deadAt; delete db[code].expiredAt; dbChanged = true; } if (cl.status === "ok") { newSuccess++; newCodes[code] = (newCodes[code] || 0) + 1; } }
      else if (cl.status === "expired" || cl.status === "invalid" || cl.status === "usedup" || cl.status === "limited") { deadThisRun[code] = 1; db[code] = db[code] || { firstSeen: Date.now(), deadHits: 0 }; db[code].status = (cl.status === "limited" ? "usedup" : cl.status); db[code].deadAt = Date.now(); db[code].apiDead = true; dbChanged = true; }
      await sleep(400);
    }
  }
  // prune the done ledger: drop entries whose code is no longer ACTIVE — keeps `done` bounded to active×members
  Object.keys(done).forEach(function (k) { var i = k.indexOf(":"); var code = i > 0 ? k.slice(i + 1) : ""; if (!db[code] || db[code].status !== "active") { delete done[k]; doneChanged = true; } });
  if (doneChanged) { try { await env.GIFT_KV.put(DONE_KEY, JSON.stringify(done)); } catch (e) {} }
  if (dbChanged) { try { await env.GIFT_KV.put(CODEDB_KEY, JSON.stringify(db)); } catch (e) {} }
  // notify on real new redemptions via an optional Discord webhook
  if (newSuccess > 0) { try { var hook = await env.GIFT_KV.get(NOTIFY_KEY); if (hook) { var parts = Object.keys(newCodes).map(function (c) { return c + "×" + newCodes[c]; }); await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "🎁 自动兑换：本次新增 " + newSuccess + " 笔（" + parts.join("，") + "）" }) }); } } catch (e) {} }
  var rec = { ranAt: new Date().toISOString(), mode: trigger, codes: codes, count: roster.length, newSuccess: newSuccess, skipped: skipped, results: results };
  if (trigger === "manual" || trigger === "ingest" || newSuccess > 0 || dbChanged) { try { await env.GIFT_KV.put(LAST_KEY, JSON.stringify(rec)); } catch (e) {} }
  return rec;
}

// seed candidate codes into codeDB (skip ones already known); returns the newly-seeded list
async function seedCodes(env, cand, src) {
  var db = await getJSON(env, CODEDB_KEY, {}), now = Date.now(), seeded = [];
  cand.forEach(function (c) { c = String(c || "").trim(); if (c && db[c] == null) { db[c] = { status: "active", firstSeen: now, deadHits: 0, src: src || "ingest" }; seeded.push(c); } });
  if (seeded.length) { try { await env.GIFT_KV.put(CODEDB_KEY, JSON.stringify(db)); } catch (e) {} }
  return seeded;
}

/* ---------- direct official Discord channel watch (1-min cron poll via bot REST) ---------- */
function dHeaders(token) { return { "Authorization": "Bot " + token, "User-Agent": "kingshoter (https://kingshoter.com, v1)", "Content-Type": "application/json" }; }
function dGet(token, path) {
  return fetch(DISCORD_API + path, { headers: dHeaders(token) })
    .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }).catch(function () { return { status: r.status, j: null }; }); })
    .catch(function () { return { status: 0, j: null }; });
}
// pull every bit of text out of a Discord message (plain content + cross-posted/announcement embeds)
function msgText(m) {
  var parts = [m.content || ""];
  (m.embeds || []).forEach(function (e) {
    if (!e) return; parts.push(e.title || ""); parts.push(e.description || "");
    (e.fields || []).forEach(function (f) { parts.push((f && f.name) || ""); parts.push((f && f.value) || ""); });
    if (e.footer && e.footer.text) parts.push(e.footer.text);
  });
  return parts.join("\n");
}
// list the text/announcement channels the bot can see, across all its guilds
async function discordChannels(token) {
  var out = [];
  var g = await dGet(token, "/users/@me/guilds");
  if (!Array.isArray(g.j)) return { error: g.j && g.j.message ? g.j.message : ("guilds http " + g.status), channels: [], guilds: [] };
  var guilds = g.j.map(function (x) { return { id: x.id, name: x.name }; });
  for (var i = 0; i < g.j.length; i++) {
    var ch = await dGet(token, "/guilds/" + g.j[i].id + "/channels");
    if (Array.isArray(ch.j)) ch.j.forEach(function (c) { if (c.type === 0 || c.type === 5) out.push({ id: c.id, name: c.name, guild: g.j[i].name }); });
  }
  return { channels: out, guilds: guilds };
}
// get the bot's channel list, cached in KV for 30 min to avoid Discord rate limits on every 1-min poll
async function getDiscordChannels(env, token, state, force) {
  var now = Date.now();
  if (!force && state.channels && state.discoveredAt && now - state.discoveredAt < 1800000) return { channels: state.channels, cached: true };
  var info = await discordChannels(token);
  if (info.error) return { channels: state.channels || [], error: info.error };
  state.channels = info.channels; state.guilds = info.guilds; state.discoveredAt = now; state._dirty = true;
  return { channels: info.channels, guilds: info.guilds };
}
// poll the watched channels for new messages, extract codes, seed + redeem immediately
async function pollDiscord(env) {
  var token = await env.GIFT_KV.get(DTOKEN_KEY);
  if (!token) return { ok: false, reason: "no token" };
  var state = await getJSON(env, DSTATE_KEY, { lastSeen: {} });
  if (!state.lastSeen) state.lastSeen = {};
  var disc = await getDiscordChannels(env, token, state);
  if (!disc.channels.length) return { ok: false, reason: disc.error || "no channels" };
  var channels = disc.channels, found = [], stateChanged = !!state._dirty; state._dirty = undefined;
  for (var i = 0; i < channels.length; i++) {
    var c = channels[i], last = state.lastSeen[c.id];
    var q = last ? ("?limit=15&after=" + last) : "?limit=5";
    var res = await dGet(token, "/channels/" + c.id + "/messages" + q);
    if (!Array.isArray(res.j) || !res.j.length) continue;
    // newest first; remember newest id; on the very first sight just baseline (don't redeem history)
    state.lastSeen[c.id] = res.j[0].id; stateChanged = true;
    if (!last) continue; // baseline only — skip back-mining old messages
    res.j.forEach(function (m) { extractCodes(msgText(m)).forEach(function (code) { if (found.indexOf(code) < 0) found.push(code); }); });
  }
  var seeded = [];
  if (found.length) seeded = await seedCodes(env, found, "discord");
  if (stateChanged) { try { await env.GIFT_KV.put(DSTATE_KEY, JSON.stringify(state)); } catch (e) {} }
  if (seeded.length) { var rec = await redeemRun(env, "discord", true); return { ok: true, found: found, seeded: seeded, redeemed: rec.newSuccess }; }
  return { ok: true, found: found, seeded: [], channels: channels.length };
}

/* ---------- HTTP router (mounted at /api/g/* by worker.js) ---------- */
export async function handleGift(path, request, env, ctx) {
  const PASS = env.MASTER;
  const authorized = body => !!PASS && !!body && typeof body.password === "string" && body.password === PASS;

  if (path === "/auth" && request.method === "POST") {
    let body; try { body = await request.json(); } catch { return json({ ok: false }, 400); }
    if (!authorized(body)) return json({ ok: false }, 403);
    return json({ ok: true });
  }
  if (path === "/codes" && request.method === "GET") {
    const db = await collectCodes(env);
    const codes = Object.keys(db).filter(function (c) { return db[c].status === "active"; })
      .sort(function (a, b) { return (db[b].firstSeen || 0) - (db[a].firstSeen || 0); });
    const history = Object.keys(db).filter(function (c) { return db[c].status === "expired" || db[c].status === "usedup"; })
      .map(function (c) { return { code: c, status: db[c].status, firstSeen: db[c].firstSeen || null, deadAt: db[c].deadAt || db[c].expiredAt || null }; })
      .sort(function (a, b) { return (b.deadAt || 0) - (a.deadAt || 0); }).slice(0, 60);
    return json({ codes: codes, history: history });
  }
  if (path === "/roster" && request.method === "POST") {
    let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    if (!authorized(body)) return json({ error: "wrong password" }, 403);
    if (Array.isArray(body.roster)) {
      const clean = body.roster.map(function (m) { return { name: (m.name || "").toString().slice(0, 24), fid: (m.fid || "").toString().replace(/\D/g, "").slice(0, 16) }; }).filter(function (m) { return m.fid; });
      await env.GIFT_KV.put(ROSTER_KEY, JSON.stringify(clean));
      return json({ ok: true, roster: clean });
    }
    const rr = await env.GIFT_KV.get(ROSTER_KEY);
    return json({ ok: true, roster: rr ? JSON.parse(rr) : [] });
  }
  if (path === "/redeem" && request.method === "POST") {
    let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    if (!authorized(body)) return json({ error: "wrong password" }, 403);
    const rec = await redeemRun(env, "manual");
    return json({ ok: true, result: rec });
  }
  if (path === "/ingest" && request.method === "POST") {
    let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    if (!authorized(body)) return json({ error: "wrong password" }, 403);
    const cand = body.code ? [String(body.code).trim()] : extractCodes(body.text || "");
    if (!cand.length) return json({ ok: true, seeded: [], candidates: [], note: "no code found" });
    const seeded = await seedCodes(env, cand);
    ctx.waitUntil(redeemRun(env, "ingest")); // redeem in background so the request returns instantly
    return json({ ok: true, seeded: seeded, candidates: cand });
  }
  if (path === "/lastredeem" && request.method === "POST") {
    let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    if (!authorized(body)) return json({ error: "wrong password" }, 403);
    const lr = await env.GIFT_KV.get(LAST_KEY);
    return json(lr ? JSON.parse(lr) : { ranAt: null, results: [] });
  }
  if (path === "/notifytoken" && request.method === "POST") {
    let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    if (!authorized(body)) return json({ error: "wrong password" }, 403);
    const u = (body.url || "").toString().trim();
    if (!u) { await env.GIFT_KV.delete(NOTIFY_KEY); return json({ ok: true, cleared: true }); }
    if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(u)) return json({ ok: false, error: "需要 Discord webhook URL" });
    await env.GIFT_KV.put(NOTIFY_KEY, u);
    try { await fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "✅ 礼包码通知已连接，新码自动兑换会在这里播报。" }) }); } catch (e) {}
    return json({ ok: true, set: true });
  }
  if (path === "/notifystatus" && request.method === "POST") {
    let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    if (!authorized(body)) return json({ error: "wrong password" }, 403);
    const h = await env.GIFT_KV.get(NOTIFY_KEY);
    return json({ ok: true, connected: !!h });
  }
  if (path === "/discordtoken" && request.method === "POST") {
    let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    if (!authorized(body)) return json({ error: "wrong password" }, 403);
    const tok = (body.token || "").toString().trim();
    if (!tok) { await env.GIFT_KV.delete(DTOKEN_KEY); await env.GIFT_KV.delete(DSTATE_KEY); return json({ ok: true, cleared: true }); }
    await env.GIFT_KV.put(DTOKEN_KEY, tok);
    const info = await discordChannels(tok); // verify the token + report what it sees
    if (!info.error) { try { await env.GIFT_KV.put(DSTATE_KEY, JSON.stringify({ lastSeen: {}, channels: info.channels, guilds: info.guilds, discoveredAt: Date.now() })); } catch (e) {} }
    return json({ ok: true, set: true, error: info.error || null, guilds: info.guilds || [], channels: info.channels || [] });
  }
  if (path === "/discordstatus" && request.method === "POST") {
    let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    if (!authorized(body)) return json({ error: "wrong password" }, 403);
    const tok = await env.GIFT_KV.get(DTOKEN_KEY);
    if (!tok) return json({ ok: true, connected: false });
    const st = await getJSON(env, DSTATE_KEY, { lastSeen: {} });
    if (st.channels && st.channels.length) return json({ ok: true, connected: true, guilds: st.guilds || [], channels: st.channels, watching: Object.keys(st.lastSeen || {}).length });
    const info = await discordChannels(tok); // no cache yet -> best-effort live
    return json({ ok: true, connected: !info.error, error: info.error || null, guilds: info.guilds || [], channels: info.channels || [], watching: 0 });
  }
  if (path === "/discordpoll" && request.method === "POST") {
    let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    if (!authorized(body)) return json({ error: "wrong password" }, 403);
    const r = await pollDiscord(env);
    return json(r);
  }
  if (path === "/testcode" && request.method === "POST") {
    let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    if (!authorized(body)) return json({ error: "wrong password" }, 403);
    const fid = String(body.fid || "").replace(/\D/g, "").slice(0, 16);
    const code = String(body.code || "").trim();
    if (!fid || !code) return json({ ok: false, error: "need fid+code" });
    await ksPost("/player", { fid: fid, time: Date.now() }); // login first (else NOT LOGIN)
    const res = await ksPost("/gift_code", { fid: fid, cdk: code, time: Date.now() });
    const cl = classify(res);
    return json({ ok: true, fid: fid, code: code, official_http: res.status, official_raw: res.j, verdict: cl.status, verdict_msg: cl.msg });
  }
  if (path === "/statedump" && request.method === "POST") {
    let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    if (!authorized(body)) return json({ error: "wrong password" }, 403);
    const done = await getJSON(env, DONE_KEY, {});
    const codeDB = await getJSON(env, CODEDB_KEY, {});
    const entries = Object.keys(done).map(function (k) { return { key: k, ts: done[k], iso: new Date(done[k]).toISOString() }; }).sort(function (a, b) { return b.ts - a.ts; });
    return json({ ok: true, doneCount: entries.length, recent: entries.slice(0, 60), codeDB: codeDB });
  }
  if (path === "/srcdebug" && request.method === "POST") {
    let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    if (!authorized(body)) return json({ error: "wrong password" }, 403);
    const out = { kingshotnet: [], forge: [], ksredeem: [], kswiki: [] };
    await fetchJSON(SRC_KINGSHOTNET, function (j) { ((j && j.data && j.data.giftCodes) || []).forEach(function (g) { if (g && g.code) out.kingshotnet.push(g.code + (g.expiresAt ? "(exp)" : "")); }); });
    await fetchJSON(SRC_FORGE, function (j) { ((j && j.codes) || []).forEach(function (c) { if (c && c.code) out.forge.push(c.code); }); });
    await fetchJSON(SRC_KSREDEEM, function (j) { ((j && j.codes) || []).forEach(function (c) { if (c && c.code) out.ksredeem.push(c.code + ":" + c.status); }); });
    await fetchText(SRC_KSWIKI, function (h) { parseKswiki(h, function (c) { out.kswiki.push(c); }); });
    return json({ ok: true, sources: out });
  }
  return json({ error: "not found" }, 404);
}

/* ---------- cron (wired in worker.js scheduled()) ---------- */
export async function giftScheduled(event, env, ctx) {
  if (event.cron === "* * * * *") {
    // every 1 min: read the official Discord channel directly (fast path for limited codes)
    ctx.waitUntil(pollDiscord(env).catch(function () {}));
  } else {
    // every 5 min: sweep the third-party code sources + redeem newly-detected codes / new members
    ctx.waitUntil(redeemRun(env, "auto"));
  }
}
