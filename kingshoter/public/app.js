/* kingshoter shared backbone: helpers, i18n (中/EN), live clock, BattleConnection compatibility. */

/* ---- helpers ---- */
window.$ = (i) => document.getElementById(i);
window.esc = (s) => (s == null ? "" : String(s)).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
window.pad = (n) => (n < 10 ? "0" : "") + n;
window.hhmmss = (sec) => { sec = ((Math.round(sec) % 86400) + 86400) % 86400; return pad(Math.floor(sec / 3600)) + ":" + pad(Math.floor(sec % 3600 / 60)) + ":" + pad(sec % 60); };
window.mmss = (s) => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ":" + pad(s % 60); };
window.nowUTCsec = () => { const d = new Date(); return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds(); };
window.toast = (t) => { const el = $("toast"); if (!el) return; el.textContent = t; el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 2200); };

/* ---- i18n ---- */
window.LANG_KEY = "kingshoter_lang";
window.lang = (() => { try { const s = localStorage.getItem(LANG_KEY); if (s === "zh" || s === "en") return s; } catch (e) {} return (String(navigator.language || "").toLowerCase().indexOf("zh") === 0) ? "zh" : "en"; })();
window.I18N = {
  zh: {
    nav_home: "🏠 首页", nav_kvk: "⚔️ KvK 指挥", nav_codes: "🎁 礼包码", nav_events: "📅 活动表", nav_guide: "📖 词汇", utc_local: "UTC · 本地",
    /* portal */
    site_tag: "每位车头只看自己的开车倒数 · Kingshot 玩家工具", soon: "敬请期待", sec_more: "更多工具",
    card_kvk: "KvK 实时指挥 / 模拟器", card_kvk_d: "指挥一处发令，两个车头收到各自的错峰开车倒数；普通成员收到一个通用加入提醒。",
    card_codes: "礼包码查询", card_codes_d: "当前有效礼包码，随时查、点一下复制。",
    card_events: "活动 / 事件时间表", card_events_d: "竞技场、火龙、熊突、KvK 节点时间，自动换算你的时区。",
    card_guide: "KvK 打法 & 词汇", card_guide_d: "看动画秒懂 集结 / 双集结 / 反集结 / refill", card_calc: "战力计算器",
    foot: "Kingshot 玩家自制工具 · 非官方、与 Century Games 无关 · 不使用任何游戏素材 ⚔️🐟",
    /* kvk shell */
    k_h1: "KvK 实时指挥", k_join: "进入房间", k_room: "房间名",
    k_join_hint: "填一个房间名就行（自己取，和队友约定同一个）。看公开，改要密码。",
    k_enter: "进入", k_net_off: "连接断开 · 重连中…", k_net_on: "● 已连接", k_presence: "{n} 人在线",
    /* role / onboarding */
    k_you_player: "我是普通玩家", k_you_cmd: "我是指挥",
    k_ob_title: "怎么用（看一眼就会）", k_ob_1: "① 游戏里对王城开一次集结，看一眼「行军时间」。",
    k_ob_2: "② 把那个时间填到下面 —— 就这一步。", k_ob_3: "③ 页面留着别关，指挥发令时你会收到横幅+声音提醒。",
    k_ob_go: "明白了，去填",
    /* player fill */
    k_fill_title: "填你的信息（只填这一次）", k_pid: "Player ID", k_pid_hint: "游戏内点左上角头像可看到",
    k_name_loading: "查名字中…", k_name_fail: "查不到，手填名字", k_march: "到王城行军",
    k_alliance: "联盟", k_save: "提交", k_saved: "✓ 已提交，等指挥发令", k_min: "分", k_sec: "秒",
    /* commander */
    k_cmd_title: "指挥台", k_cmd_unlock: "🔓 输入房间密码进指挥模式", k_pw: "房间密码：",
    k_cmd_double: "⚔️ 双集结", k_cmd_refill: "💧 refill 提醒", k_cmd_custom: "📢 自定义", k_cmd_cancel: "✖ 取消当前",
    k_lead: "下 {x} 秒", k_custom_ph: "自定义指令文字…", k_send: "发布",
    /* live banner */
    k_now_cmd: "当前指令", k_send_in: "{x} 后", k_go: "上！", k_in_pip: "📌 浮窗计时", k_pip_no: "此浏览器不支持浮窗，用分屏或盯着本页",
    /* sim */
    k_sim: "🎮 模拟演练", k_sim_start: "开始模拟", k_sim_stop: "停止", k_sim_hint: "演练完整 KvK 协调流程，不影响真实指挥。",
    k_map_castle: "王城", k_map_empty: "还没有玩家进来 · 让大家打开这个房间链接",
    k_last: "继续上次", k_or_new: "或进别的房间", k_change_room: "换房间",
    k_pw_title: "房间密码", k_pw_ph: "输入房间密码", k_pw_go: "进指挥模式", k_pw_cancel: "取消",
    k_in_card: "✓ 你已在场", k_edit: "改",
    k_roster: "在场玩家（{n}）", k_pick_hint: "点 2 个做双集结的车头；再点徽章切主力/消耗。",
    k_main: "主力", k_weak: "消耗", k_fire_double: "⚔️ 发双集结（1秒错位）", k_need2: "先选 2 个车头",
    k_you_press: "🚗 你开车！", k_press_at: "{x} 开车", k_double_land: "双集结 · 落地 ~{x}"
  },
  en: {
    nav_home: "🏠 Home", nav_kvk: "⚔️ KvK", nav_codes: "🎁 Codes", nav_events: "📅 Events", nav_guide: "📖 Guide", utc_local: "UTC · Local",
    site_tag: "Every captain follows their own launch countdown · Kingshot player tools", soon: "coming soon", sec_more: "More tools",
    card_kvk: "KvK live command / simulator", card_kvk_d: "Command from one place: both captains receive their own staggered launch countdown; ordinary members get one generic join alert.",
    card_codes: "Gift code lookup", card_codes_d: "Currently-active gift codes — check anytime, tap to copy.",
    card_events: "Event timetable", card_events_d: "Arena, dragon, bear, KvK times — auto-converted to your timezone.",
    card_guide: "KvK playbook & glossary", card_guide_d: "Animations that make rally / double / counter / refill click", card_calc: "Power calculator",
    foot: "Player-made Kingshot tool · unofficial, not affiliated with Century Games · no game assets used ⚔️🐟",
    k_h1: "KvK Live Command", k_join: "Enter a room", k_room: "Room name",
    k_join_hint: "Just a room name (pick one, share it with your team). Anyone can view; editing needs the room password.",
    k_enter: "Enter", k_net_off: "Disconnected · reconnecting…", k_net_on: "● Connected", k_presence: "{n} online",
    k_you_player: "I'm a player", k_you_cmd: "I'm the commander",
    k_ob_title: "How it works (10 seconds)", k_ob_1: "① In-game, open a rally on the King's Castle and read your march time.",
    k_ob_2: "② Enter that time below — that's your only step.", k_ob_3: "③ Keep this page open; you'll get a banner + sound when the commander calls.",
    k_ob_go: "Got it, let me fill",
    k_fill_title: "Your info (just once)", k_pid: "Player ID", k_pid_hint: "tap your avatar (top-left) in-game to see it",
    k_name_loading: "looking up name…", k_name_fail: "not found — type your name", k_march: "March to castle",
    k_alliance: "Alliance", k_save: "Submit", k_saved: "✓ Submitted — wait for the call", k_min: "m", k_sec: "s",
    k_cmd_title: "Command console", k_cmd_unlock: "🔓 Enter room password for command mode", k_pw: "Room password:",
    k_cmd_double: "⚔️ Double rally", k_cmd_refill: "💧 Refill call", k_cmd_custom: "📢 Custom", k_cmd_cancel: "✖ Cancel current",
    k_lead: "in {x}s", k_custom_ph: "custom order text…", k_send: "Send",
    k_now_cmd: "Current order", k_send_in: "in {x}", k_go: "GO!", k_in_pip: "📌 Float timer", k_pip_no: "This browser can't float; use split-screen or watch this page",
    k_sim: "🎮 Simulator", k_sim_start: "Start sim", k_sim_stop: "Stop", k_sim_hint: "Rehearse the full KvK coordination loop — doesn't affect real command.",
    k_map_castle: "Castle", k_map_empty: "No players yet · share this room link with your team",
    k_last: "Continue last room", k_or_new: "or join another room", k_change_room: "Change room",
    k_pw_title: "Room password", k_pw_ph: "enter room password", k_pw_go: "Enter command mode", k_pw_cancel: "Cancel",
    k_in_card: "✓ You're in", k_edit: "Edit",
    k_roster: "Players ({n})", k_pick_hint: "Tap 2 captains for the double rally; tap the badge to swap main/sacrifice.",
    k_main: "main", k_weak: "sacrifice", k_fire_double: "⚔️ Fire double rally (1s offset)", k_need2: "Pick 2 captains first",
    k_you_press: "🚗 YOU launch!", k_press_at: "launch {x}", k_double_land: "Double rally · land ~{x}"
  }
};
window.t = (k) => { const d = I18N[lang] || I18N.zh; return (d && d[k] != null) ? d[k] : ((I18N.zh && I18N.zh[k] != null) ? I18N.zh[k] : k); };
window.tf = (k, vars) => { let s = t(k); for (const p in vars) s = s.split("{" + p + "}").join(vars[p]); return s; };
window.applyI18n = (root) => {
  root = root || document;
  root.querySelectorAll("[data-i18n]").forEach(el => el.textContent = t(el.getAttribute("data-i18n")));
  root.querySelectorAll("[data-i18n-html]").forEach(el => el.innerHTML = t(el.getAttribute("data-i18n-html")));
  root.querySelectorAll("[data-i18n-ph]").forEach(el => el.setAttribute("placeholder", t(el.getAttribute("data-i18n-ph"))));
  document.documentElement.lang = (lang === "zh") ? "zh-CN" : "en";
};
window.renderLangToggle = () => {
  const m = $("langtoggle"); if (!m) return;
  m.innerHTML = '<button class="langbtn' + (lang === "zh" ? " on" : "") + '" data-l="zh">中</button><button class="langbtn' + (lang === "en" ? " on" : "") + '" data-l="en">EN</button>';
  m.querySelectorAll("button").forEach(b => b.onclick = () => setLang(b.getAttribute("data-l")));
};
window.setLang = (l) => { lang = l; try { localStorage.setItem(LANG_KEY, l); } catch (e) {} applyI18n(); renderLangToggle(); if (typeof window.onLangChange === "function") window.onLangChange(); };
window.initI18n = () => { applyI18n(); renderLangToggle(); };

/* ---- NTP-style server-time sync (so countdowns ignore a wrong device clock) ---- */
window.clockOffset = 0;                       // ms to add to Date.now() to get server time
window.serverNow = () => Date.now() + window.clockOffset;
window.serverNowSec = () => Math.floor(window.serverNow() / 1000);
var activeRoomSocket = null;
window.syncClock = async () => {
  if (!activeRoomSocket || typeof activeRoomSocket.syncClock !== "function") {
    return { offset: window.clockOffset, rtt: null, offsetMs: window.clockOffset, rttMs: null };
  }
  return activeRoomSocket.syncClock();
};

/* ---- live UTC clock ---- */
window.startClock = () => {
  const tick = () => { const d = new Date(), u = $("utc"), l = $("loc"); if (u) u.textContent = pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds()); if (l) l.textContent = pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()); };
  tick(); setInterval(tick, 500);
};

window.getRoomDeviceId = (room) => {
  const key = `kvk:${String(room)}:delivery-device:v1`;
  let value = '';
  try { value = localStorage.getItem(key) || ''; } catch (e) {}
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    value = crypto.randomUUID();
  }
  value = value.toLowerCase();
  try { localStorage.setItem(key, value); } catch (e) {}
  return value;
};

/* ---- legacy RoomSocket adapter over the surface-aware shared connection ---- */
window.RoomSocket = class {
  constructor(room, onState, options) {
    options = options || {};
    this.room = room;
    this.onState = onState;
    this.onError = null;
    this.onMessage = null;
    this.onOpen = null;
    this.onClose = null;
    this.onClockChange = null;
    this.dead = false;
    Object.defineProperty(this, "clientBuild", { value: Number.isSafeInteger(options.clientBuild) && options.clientBuild > 0 ? options.clientBuild : 0, enumerable: true });
    Object.defineProperty(this, "surface", { value: options.surface || "rally", enumerable: true });
    if (!window.BattleConnection || typeof window.BattleConnection.createRoomConnection !== "function") {
      throw new Error("BattleConnection is required before RoomSocket");
    }
    const self = this;
    this.connection = window.BattleConnection.createRoomConnection({
      room: room,
      surface: this.surface,
      clientBuild: this.clientBuild,
      manageClock: false,
      onMessage(message) {
        if (message.t === "state") self.onState(message.room);
        else if (message.t === "error") { if (self.onError) self.onError(message); }
        else if (self.onMessage) self.onMessage(message);
      },
      onConnectionChange(state) {
        if (state.reason === "open" && self.onOpen) self.onOpen();
        else if (state.reason === "closed" && self.onClose) self.onClose();
      },
      onClockChange(sample) {
        window.clockOffset = Number(sample.offsetMs) || 0;
        if (self.onClockChange) self.onClockChange(sample);
      }
    });
    activeRoomSocket = this;
    this.connection.start();
  }
  connect() { return this.connection.connect(); }
  send(o) { return this.connection.send(o); }
  refresh() { return this.connection.refresh(); }
  // iOS may suspend a backgrounded socket without firing onclose; reconnect if it's not OPEN/CONNECTING when we resume
  kick() { return this.connection.kick(); }
  syncClock() { return this.connection.syncClock(); }
  clockFresh() { return this.connection.clockFresh(); }
  serverNowMs() { return this.connection.serverNowMs(); }
  get ws() { return this.connection.socket(); }
  get connectionGeneration() { return this.connection.generation(); }
  get connected() { return this.connection.connected(); }
  close() { this.dead = true; this.connection.stop(); }
};

/* ---- shared KvK actor visual language (color-blind safe: ●circle=ally / ▼triangle=enemy; size+crown=captain) ----
   Used by both the glossary (guide.html) and the live battle map (kvk.html) so they match exactly. */
(function () {
  var NS = "http://www.w3.org/2000/svg";
  function E(t, a) { var e = document.createElementNS(NS, t); for (var k in a) e.setAttribute(k, a[k]); return e; }
  window.ksTriPts = function (cx, cy, W) { return cx + "," + (cy + W * 1.05) + " " + (cx - W) + "," + (cy - W * 0.78) + " " + (cx + W) + "," + (cy - W * 0.78); };
  // actor: body drawn at origin in a <g>; positioned + animated by tweening the group's x/y
  window.ksActor = function (svg, x, y, o) {
    var g = E("g", {});
    if (o.side === "ally") {
      var r = o.role === "captain" ? 11 : 6;
      g.appendChild(E("circle", { cx: 0, cy: 0, r: r, fill: "#19c8b9", stroke: "#fbf7ec", "stroke-width": 2 }));
      if (o.role === "captain") {
        g.appendChild(E("circle", { cx: 0, cy: 0, r: 8.5, fill: "none", stroke: "#0fa193", "stroke-width": 1.5 }));
        g.appendChild(E("rect", { x: -7, y: -20, width: 14, height: 3, rx: 1.5, fill: "#794f27" }));
        [[-6, -20, 2], [0, -22, 2.4], [6, -20, 2]].forEach(function (c) { g.appendChild(E("circle", { cx: c[0], cy: c[1], r: c[2], fill: "#794f27" })); });
      }
    } else {
      g.appendChild(E("polygon", { points: o.role === "captain" ? "0,11.5 -11,-8.6 11,-8.6" : "0,6.6 -6.3,-4.9 6.3,-4.9", fill: "#e05a5a", stroke: "#fbf7ec", "stroke-width": 2, "stroke-linejoin": "round" }));
      if (o.role === "captain") {
        g.appendChild(E("polygon", { points: "0,8 -7.5,-5.6 7.5,-5.6", fill: "none", stroke: "#b23b3b", "stroke-width": 1.5, "stroke-linejoin": "round" }));
        g.appendChild(E("polygon", { points: "-7,-15 -4,-21 -1,-15 0,-22 1,-15 4,-21 7,-15", fill: "#794f27" }));
      }
    }
    svg.appendChild(g); g._sx = x; g._sy = y;
    if (window.gsap) gsap.set(g, { x: x, y: y }); else g.setAttribute("transform", "translate(" + x + "," + y + ")");
    return g;
  };
  // castle: ownership shown 3 redundant ways — resident shape (circle/triangle/none) + stroke + fill tint
  window.ksCastle = function (svg, cx, cy, owner) {
    var g = E("g", {});
    var body = E("rect", { x: cx - 20, y: cy - 16, width: 40, height: 32, rx: 8, fill: "#fce3b8", stroke: "#794f27", "stroke-width": 3 });
    g.appendChild(body);
    var merlons = [-20, -6, 8].map(function (dx) { var m = E("rect", { x: cx + dx + 1, y: cy - 23, width: 8, height: 9, rx: 2, fill: "#794f27" }); g.appendChild(m); return m; });
    var rAlly = E("circle", { cx: cx, cy: cy + 2, r: 5, fill: "#19c8b9", stroke: "#fbf7ec", "stroke-width": 2, opacity: 0 });
    var rEnemy = E("polygon", { points: window.ksTriPts(cx, cy + 2, 5), fill: "#e05a5a", stroke: "#fbf7ec", "stroke-width": 2, "stroke-linejoin": "round", opacity: 0 });
    g.appendChild(rAlly); g.appendChild(rEnemy); svg.appendChild(g);
    var COL = { ally: "#5a9e1e", enemy: "#e05a5a", neutral: "#794f27" }, FILL = { ally: "#dff3c8", enemy: "#fbe0de", neutral: "#fce3b8" };
    function tint(fill, stroke) { body.setAttribute("fill", fill); body.setAttribute("stroke", stroke); merlons.forEach(function (m) { m.setAttribute("fill", stroke); }); }
    function setOwner(o) { tint(FILL[o], COL[o]); rAlly.setAttribute("opacity", o === "ally" ? 1 : 0); rEnemy.setAttribute("opacity", o === "enemy" ? 1 : 0); }
    setOwner(owner || "neutral");
    return { g: g, body: body, tint: tint, setOwner: setOwner, cx: cx, cy: cy };
  };
})();
