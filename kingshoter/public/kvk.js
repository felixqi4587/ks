/* kingshoter — KvK command room (world-class rebuild).
   Two jobs: (1) commander fires precise, per-captain double-rally launch targets; (2) every player
   gets one unmistakable personal launch or generic join cue. Defense timing remains an explicit rehearsal.
   Relies on app.js for: $ esc pad mmss hhmmss toast · lang/setLang/applyI18n/initI18n/renderLangToggle ·
   serverNow/serverNowSec/syncClock/clockOffset · startClock · RoomSocket · ksActor/ksCastle/ksTriPts. */
(function () {
  "use strict";
  var qp = new URLSearchParams(location.search);
  // rooms are addressed by ROOM NAME ONLY (kingdom number dropped; legacy ?k= is ignored)
  var ROOM = (qp.get("room") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48);
  var LS = function (s) { return "kingshoter_r_" + ROOM + "_" + s; };
  function rd(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function wr(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  /* ---------- state ---------- */
  var sock = null, room = null, lead = 15, roomPw = "", lastCmdId = null, myPid = "", fireKingdom = 1;
  var announcedCountdowns = {};
  var marchTouched = false, pendingUnlock = false, pendingTok = "", rosterActionsPid = "", removalState = null;
  var initialStateSeen = false, ownPlayerSeen = false, registrationPending = false, pendingMarchMutation = null;
  var pendingRegistrationProfile = null, draftActive = false, draftVersion = 0;
  var rosterQuery = "", pendingReplacementPid = "", pendingReplacementOrigin = null, pendingReplacementIncumbents = null;
  var pendingStageMutation = null, queuedStageByK = { 1: null, 2: null }, stageFocusByK = { 1: "", 2: "" };
  var editingPlayerPid = "", commanderMarchDraft = "", commanderMarchDirty = false, commanderMarchLatest = null;
  var commanderMarchStatus = "", commanderMarchStatusTone = "", commanderMarchOriginPid = "";
  var pendingCommanderMarchMutation = null, commanderMarchStale = false, commanderMarchRefreshAfterSnapshot = -1, roomSnapshotSequence = 0;
  var myProfile = null, deviceId = window.getRoomDeviceId(ROOM);
  var pendingDeliveryAcks = Object.create(null), confirmedDeliveryAcks = Object.create(null), rejectedDeliveryAcks = Object.create(null);
  var DELIVERY_ACK_RETRY_DELAYS_MS = [1200, 2400, 5000, 10000, 15000], deliveryStatusTimer = 0;
  var lastDeviceStatusSignature = "", lastDeviceStatusGeneration = -1;
  var DEVICE_STATUS_RETRY_MS = 1200, lastDeviceStatusSentSignature = "", lastDeviceStatusSentGeneration = -1, lastDeviceStatusSentAt = 0;
  try { myProfile = JSON.parse(localStorage.getItem(LS("me")) || "null"); } catch (e) {}
  if (myProfile && myProfile.pid) {
    myProfile = Object.assign({}, myProfile, {
      marchRevision: Number.isInteger(myProfile.marchRevision) ? myProfile.marchRevision : 0,
      identityMode: myProfile.identityMode || "playerId"
    });
    myPid = myProfile.pid;
  }
  var identityMode = myProfile && myProfile.identityMode === "nickname" ? "nickname" : "playerId";
  var lookupSequence = 0, lookupAbort = null, lookupTimer = null, nicknameDraftRoutingKey = "";
  var pickedByK = { 1: [], 2: [] };
  var serverStagedByK = { 1: [], 2: [] };
  // defense (refill-timing) state — ported from saltyfish defense.html, fed by room.config.enemyWhales
  var viewMode = "attack", enemyWhales = [], dFocus = 0, adminEnemies = [], lastWhalesKey = "", pendingPubWhales = null, pendingPubTok = null;
  var adminDirty = false, picksTouched = false;   // adminDirty: whale editor has unsaved edits (don't clobber from broadcasts); picksTouched: commander touched picks this session (don't rehydrate over their intent)
  var DGATHER = 300, DDELTA = 1, DGVIS = 0.25;   // enemy rally gather 5:00; our refill lands ~1s after; gather occupies 1/4 of the visual strip
  var dAnim = null, dRaf = null, dPlaying = false, dLastTs = null, dTNow = 0;
  var truthLang = "";
  var ac = null, keepAudio = null, keepAlive = false, soundReady = false, syncedOK = false;
  var syncAttempt = 0, lastAcceptedClockOffset = Number(window.clockOffset) || 0;
  var isIOS = /iP(hone|od|ad)/.test(navigator.userAgent || "") || (navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1);
  var isAndroid = /android/i.test(navigator.userAgent || "");
  var $ = window.$;

  /* ---------- reliable delivery shadow QA ---------- */
  var deliveryShadowInitialized = false, deliveryShadowController = null;
  var deliveryShadowEvents = [], deliveryShadowReady = null, deliveryShadowSynced = null;
  var deliveryShadowAttempt = null, deliveryShadowConfirmed = null;
  var deliveryShadowRetryTimer = 0, deliveryShadowRetryIndex = 0;
  var DELIVERY_SHADOW_RETRY_MS = [500, 1500, 5000, 15000];

  function deliveryShadowExactParam(name, expected) {
    var values = qp.getAll(name);
    return values.length === 1 && values[0] === expected;
  }
  function deliveryShadowGate() {
    if (!deliveryShadowExactParam("room", ROOM) ||
        !deliveryShadowExactParam("deliveryQa", "1") ||
        !deliveryShadowExactParam("deliveryShadow", "1")) return false;
    var api = window.KvkDeliveryShadow;
    try {
      return !!api && typeof api.isQaRoomName === "function" &&
        api.isQaRoomName(ROOM) === true;
    } catch (e) { return false; }
  }
  function deliveryShadowCopyEvent(event) {
    try {
      if (!event || typeof event !== "object") return null;
      var kind = event.kind, commandId = event.commandId;
      var result = event.result, count = event.count;
      if (typeof kind !== "string") return null;
      var copy = { kind: kind };
      if (typeof commandId === "string") copy.commandId = commandId;
      if (typeof result === "string") copy.result = result;
      if (Number.isInteger(count)) copy.count = count;
      return copy;
    } catch (e) { return null; }
  }
  function deliveryShadowObserve(event) {
    var copy = deliveryShadowCopyEvent(event);
    if (!copy) return false;
    deliveryShadowEvents.push(copy);
    if (deliveryShadowEvents.length > 200) deliveryShadowEvents.shift();
    return true;
  }
  function deliveryShadowEventSnapshot() {
    var out = [];
    for (var index = 0; index < deliveryShadowEvents.length; index += 1) {
      var copy = deliveryShadowCopyEvent(deliveryShadowEvents[index]);
      if (copy) out.push(copy);
    }
    return out;
  }
  function deliveryShadowValidController(value) {
    if (!value || value.enabled !== true || !Object.isFrozen(value) ||
        typeof value.onOpen !== "function" ||
        typeof value.handleMessage !== "function" ||
        typeof value.state !== "function") return false;
    return Object.keys(value).sort().join(",") === "enabled,handleMessage,onOpen,state";
  }
  function initDeliveryShadow() {
    if (deliveryShadowInitialized) return deliveryShadowController;
    deliveryShadowInitialized = true;
    if (!deliveryShadowGate()) return null;
    var api = window.KvkDeliveryShadow, controller = null;
    try {
      controller = api.create({
        room: ROOM,
        enabled: true,
        send: function (message) {
          try { return !!sock && sock.send(message) === true; } catch (e) { return false; }
        },
        now: function () { return window.serverNow(); },
        getIdentity: function () {
          return {
            pid: myPid || "",
            deviceId: deviceId || "",
            view: isCommanderDevice() ? "commander" : "player",
            audioArmed: audioAlive()
          };
        },
        observe: deliveryShadowObserve
      });
      if (!deliveryShadowValidController(controller)) return null;
    } catch (e) { return null; }
    deliveryShadowController = controller;
    try {
      var qa = {
        controller: controller,
        getSocket: function () { return sock; }
      };
      Object.defineProperty(qa, "events", {
        enumerable: true,
        get: deliveryShadowEventSnapshot
      });
      window.__kvkDeliveryQa = Object.freeze(qa);
    } catch (e) {}
    return controller;
  }
  function deliveryShadowConnection() {
    if (!sock) return null;
    return { socket: sock, generation: Number(sock.connectionGeneration || 0) };
  }
  function deliveryShadowHandshake() {
    var connection = deliveryShadowConnection();
    if (!connection || !myPid || !deviceId) return null;
    connection.pid = myPid;
    connection.deviceId = deviceId;
    return connection;
  }
  function deliveryShadowSameConnection(a, b) {
    return !!a && !!b && a.socket === b.socket && a.generation === b.generation;
  }
  function deliveryShadowSameHandshake(a, b) {
    return deliveryShadowSameConnection(a, b) &&
      a.pid === b.pid && a.deviceId === b.deviceId;
  }
  function deliveryShadowCancelRetry() {
    if (deliveryShadowRetryTimer) clearTimeout(deliveryShadowRetryTimer);
    deliveryShadowRetryTimer = 0;
  }
  function deliveryShadowRetryCurrent(key) {
    var current = deliveryShadowHandshake();
    return deliveryShadowController &&
      deliveryShadowSameHandshake(current, key) &&
      deliveryShadowSameHandshake(deliveryShadowReady, key) &&
      !deliveryShadowSameHandshake(deliveryShadowConfirmed, key);
  }
  function deliveryShadowRetryValid(key) {
    if (syncedOK !== true || !deliveryShadowRetryCurrent(key)) return false;
    if (!deliveryShadowSameConnection(deliveryShadowSynced, key)) {
      deliveryShadowSynced = key;
      deliveryShadowRetryIndex = 0;
    }
    return true;
  }
  function deliveryShadowScheduleRetry(key) {
    deliveryShadowCancelRetry();
    if (!deliveryShadowRetryCurrent(key)) return false;
    var delay = DELIVERY_SHADOW_RETRY_MS[Math.min(
      deliveryShadowRetryIndex, DELIVERY_SHADOW_RETRY_MS.length - 1
    )];
    deliveryShadowRetryIndex += 1;
    try {
      deliveryShadowRetryTimer = setTimeout(function () {
        deliveryShadowRetryTimer = 0;
        if (!deliveryShadowRetryCurrent(key)) {
          if (deliveryShadowSameHandshake(deliveryShadowAttempt, key)) deliveryShadowAttempt = null;
          return;
        }
        deliveryShadowHelloAttempt(key);
      }, delay);
      return true;
    } catch (e) { deliveryShadowRetryTimer = 0; return false; }
  }
  function deliveryShadowHelloAttempt(key) {
    if (!deliveryShadowRetryCurrent(key)) return false;
    deliveryShadowAttempt = key;
    if (deliveryShadowRetryValid(key)) {
      try { deliveryShadowController.onOpen(); } catch (e) {}
    }
    deliveryShadowScheduleRetry(key);
    return true;
  }
  function deliveryShadowMaybeStart() {
    var key = deliveryShadowHandshake();
    if (!key || syncedOK !== true ||
        !deliveryShadowSameHandshake(deliveryShadowReady, key)) return false;
    if (!deliveryShadowSameConnection(deliveryShadowSynced, key)) deliveryShadowSynced = key;
    if (deliveryShadowSameHandshake(deliveryShadowConfirmed, key)) {
      deliveryShadowCancelRetry();
      return true;
    }
    if (deliveryShadowSameHandshake(deliveryShadowAttempt, key) && deliveryShadowRetryTimer) return true;
    deliveryShadowCancelRetry();
    deliveryShadowAttempt = key;
    deliveryShadowRetryIndex = 0;
    return deliveryShadowHelloAttempt(key);
  }
  function deliveryShadowConnectionOpened() {
    deliveryShadowCancelRetry();
    deliveryShadowReady = null;
    deliveryShadowSynced = null;
    deliveryShadowAttempt = null;
    deliveryShadowRetryIndex = 0;
  }
  function deliveryShadowClockCallback() {
    var connection = deliveryShadowConnection();
    return function (ok) {
      if (!deliveryShadowController ||
          !deliveryShadowSameConnection(connection, deliveryShadowConnection())) return;
      deliveryShadowSynced = ok === true ? connection : null;
      if (ok !== true) {
        var waitingKey = deliveryShadowHandshake();
        if (waitingKey && deliveryShadowSameHandshake(deliveryShadowReady, waitingKey) &&
            !deliveryShadowSameHandshake(deliveryShadowConfirmed, waitingKey) &&
            !(deliveryShadowSameHandshake(deliveryShadowAttempt, waitingKey) &&
              deliveryShadowRetryTimer)) {
          deliveryShadowCancelRetry();
          deliveryShadowAttempt = waitingKey;
          deliveryShadowRetryIndex = 0;
          deliveryShadowScheduleRetry(waitingKey);
        }
        return;
      }
      if (!deliveryShadowSameHandshake(deliveryShadowConfirmed, deliveryShadowHandshake())) {
        deliveryShadowCancelRetry();
        deliveryShadowAttempt = null;
      }
      deliveryShadowMaybeStart();
    };
  }
  function deliveryShadowRecordReady(message) {
    var key = deliveryShadowHandshake();
    if (!key || !message || message.t !== "deviceStatusSaved" ||
        message.pid !== key.pid || message.deviceId !== key.deviceId) return false;
    if (message.soundReady !== true) {
      deliveryShadowReady = null;
      if (!deliveryShadowSameHandshake(deliveryShadowConfirmed, key)) {
        deliveryShadowCancelRetry();
        deliveryShadowAttempt = null;
      }
      return false;
    }
    deliveryShadowReady = key;
    if (!deliveryShadowMaybeStart() && syncedOK !== true &&
        !deliveryShadowSameHandshake(deliveryShadowConfirmed, key)) {
      deliveryShadowCancelRetry();
      deliveryShadowAttempt = key;
      deliveryShadowRetryIndex = 0;
      deliveryShadowScheduleRetry(key);
    }
    return true;
  }
  function deliveryShadowConfirmProbe() {
    var key = deliveryShadowHandshake();
    if (!key || (!deliveryShadowSameHandshake(deliveryShadowAttempt, key) &&
        !deliveryShadowSameHandshake(deliveryShadowConfirmed, key))) return false;
    deliveryShadowConfirmed = key;
    deliveryShadowAttempt = null;
    deliveryShadowCancelRetry();
    return true;
  }
  function handleDeliveryShadowMessage(message) {
    if (!deliveryShadowController) return false;
    var type;
    try { type = message && message.t; } catch (e) { return false; }
    if (type === "deviceStatusSaved") {
      try { return deliveryShadowRecordReady(message); } catch (e) { return false; }
    }
    if (typeof type !== "string" || type.indexOf("deliveryShadow") !== 0) return false;
    var handled = false;
    try { handled = deliveryShadowController.handleMessage(message) === true; } catch (e) {}
    if (handled && type === "deliveryShadowProbe") deliveryShadowConfirmProbe();
    return handled;
  }
  /* ---------- reliable delivery shadow QA end ---------- */

  /* ---------- KvK practice script (commander-only) ---------- */
  var SIM = [{ off: 0, kingdom: 1, kind: "double" }, { off: 45, kingdom: 2, kind: "double" }];

  /* ---------- i18n (one local dict — single source of truth, no scattered ternaries) ---------- */
  var KT = {
    zh: {
      join: "进入房间", ornew: "或进别的房间", joinhint: "填一个房间名就行（和队友约定同一个）。", room: "房间名", enter: "进入", last: "继续上次",
      fill: "填你的信息（只填这一次）", fillsub: "填好后这块自动收起，剩下你只看一个大倒计时。", march: "到王城行军时间", marchtip: "拖动，或点 ± 精确到秒", save: "提交", edit: "改", you: "你", updated: "已提交 · 战情室已更新",
      unlock: "🔓 输入房间密码进指挥模式", cmd: "指挥台", kdhint: "选择本次发令使用的王国", pickhint: "点 2 个车头做双集结；再点徽章切主力/消耗。",
      firedbl: "点两下发双集结", leadhint: "提前量 · 每位车头各自从所选秒数开始倒数", firerefill: "💧 发 refill 提醒", cancel: "✖ 取消当前", sim: "▶ 模拟演练", simstop: "停", soundcheck: "📣 全房声音测试", tapagain: "✓ 再点一次确认",
      pwtitle: "房间密码", pwph: "输入房间密码", pwcancel: "取消", pwgo: "进指挥模式",
      pwtitle_new: "首次解锁 · 设指挥密码", pwph_new: "设一个新密码", pwgo_new: "设为密码并进入",
      pwhint_new: "这个房间还没有指挥密码——你现在输入的就会成为本房间的密码，记得告诉其他指挥。",
      net_off: "连接中…", syncing: "对时中…", online_n: "{n} 在线",
      idlesub: "指挥发令后，这里变成你的大倒计时", waitlaunch: "⏳ 等待你的 {n} 秒开车倒数", youlaunch: "🚗 你开车！", whalelaunch: "🐋 鲸鱼开车", main: "主力", weak: "消耗",
      refilltitle: "💧 现在 refill 补兵", refillsub: "敌落地后补满守军，把他弹回去", go: "出发！",
      soundon: "🔊 本页提醒已开启", soundgate: "① 开启本页提醒 · 手机系统仍可能暂停后台，开战前先测试", need2: "先选 2 个车头", wrongpw: "密码错误",
      player_actions: "{n} 的操作", action_edit_march: "修改行军时间", action_remove: "删除玩家", remove_confirm: "从房间删除 {n}？", remove_aria: "移除 {n}", remove_description: "删除后，该玩家会立即从所有指挥端和待命位置消失。", remove_impact: "同时清除以下待命位置：", remove_impact_line: "王国 {k} · {r}", remove_no_impact: "当前没有待命位置", remove_in_use: "该玩家正在进行中的集结里；先取消集结才能删除", remove_cancel: "取消", remove_button: "删除玩家", removing: "正在等待全房间确认删除 {n}…", remove_unknown: "连接中断，结果待确认；重连后会核对，但不会自动重发。", remove_retry: "没有成功发送或确认，请手动重试。", remove_changed: "玩家状态或待命位置刚刚变化；请检查后再点一次确认。", removed: "已删除 {n}", player_missing: "有车头已被删除或不在名单，请重新选择",
      mapcastle: "王城", mapempty: "还没有人 · 把房间链接发给队友", mapstaged: "已就位 · 等指挥", kw1: "王国 ①", kw2: "王国 ②", mapnote: "⭕ 每环 = 30 秒行军 · 越外圈离王城越远",
      copylink: "📋 点我复制房间链接", copied: "✓ 已复制 · 发给队友吧", idle_wait: "✅ 都填好了 · 等指挥发令；切回游戏前先用下方按钮实测本机后台提醒",
      idle_note: "○ 每人离王城的行军时间 · 开打后变成实时进度条", legend_live: "● 主力 ○ 消耗 · 越近王城越快落地",
      join_note: "🐋 集结中 · 现在去游戏里点「加入」车头的集结", pulled_atk: "⚔️ 有开车指令 · 已切到进攻页（可再切回防守）",
      namefail: "✕ 查不到昵称 · 不影响使用，会以 ID 显示", pidph: "游戏内左上角头像里的数字 ID", nicknameph: "输入昵称（仅用于测试）", marchfirst: "先拖一下滑块（或点±）确认你的行军时间",
      identity_type: "身份类型", identity_player_id: "Player ID", identity_nickname: "昵称", identity_recommended: "推荐", identity_testing: "测试用", invalid_nickname: "请输入有效昵称", duplicate_suffix: "同名玩家会显示区分标记",
      defsethint: "分:秒 = 敌鲸到王城的行军时间 · 全队防守页的补兵倒计时都按它算",
      sc_title: "📣 声音测试", sc_sub: "大家听到了吗？", you_short: "你", main_s: "主力", sac_s: "消耗",
      joincue: "开车时点「加入」车头的集结", marchhow: "怎么填：游戏里对王城开一次集结，看那个「行军时间」填进来。",
      fired: "已发送 ✓", notconn: "未连接 · 稍候自动重连", notsynced: "还在对时，等一两秒再发", nomarch: "有车头没填行军时间，先让他填",
      cancelq: "再按一次取消当前指令", cancelled: "已取消", staged_line: "🛡️ 你是{k}{r}车头 · 待命，等指挥发令",
      as_on: "🔊 后台提醒已开 · 可切回游戏", as_warn: "⚠️ 声音被系统暂停 · 点一下恢复", bgtest: "🔒 测后台", bgtest_on: "锁屏切到游戏——马上来一整套 10 秒倒数示范 🔔", 
      ready_btn: "✅ 我已就位", ready_done: "✓ 已就位", notready: "有车头还没点「就位」，仍可发", readyon: "✓ 已告诉指挥你就位", readyline: "就位 {n}/{m}", rally_live: "该王国还有进行中的集结，先取消再发 refill", cap_absent: "有车头掉线了，仍可发", syncp: "{n}/{m} 已对时·在线", syncp_pick: "先点 2 个车头", land_cap: "落地",
      delivery_sent: "已发送", delivery_received: "已收到 ✓", delivery_received_count: "已收到 {n}/{m}", delivery_missing: "未确认", delivery_expired: "已过期",
      settings: "⚙️ 提醒设置", bgtest2: "🔔 实测锁屏 / 切游戏提醒", cmdlink: "🔓 我是指挥 → 解锁", marchlab: "到王城行军时间", marchtip2: "游戏里开一次集结，看那个秒数填进来",
      cancel_k: "✖ 取消 {k} 的集结", legend: "● 你 ○ 队友 · 每环 30 秒，越外越远", unlocking: "验证密码中…", checklist_done: "都填好了，等指挥发车就行",
      tab_atk: "进攻", tab_def: "防守", dpanel: "🛡️ 补兵时机（按你的行军算）", dpanelhint: "挑当场来袭的那条敌鲸，照大字发兵。时间线上=敌方（集结→🔴落地），下=我方（🟢发兵→行军→补满✓）。补兵约在敌落地后 1 秒到，把它弹回去。",
      addenemy: "加敌鲸", pubwhales: "📣 发布敌鲸给全队", pub_ok: "✓ 已发布给全队", pub_fail: "发布失败（密码或网络）", pub_neterr: "网络错误", publishing: "发布中…", confirm_over: "有人刚发布了新版，覆盖？", whale_ph: "敌鲸名", pubdef_none: "先加一条敌鲸",
      d_empty: "指挥还没发布敌方鲸鱼；开打前让指挥在指挥台设一下。", d_you_send: "你发兵", d_enemy_land: "敌落地", d_refilled: "补满✓", d_gather_band: "敌集结 5:00（加速）", d_send_now: "发兵！", d_your_march: "你行军 {x}", d_depart: "他发车", d_side_enemy: "敌方", d_side_our: "我方",
      d_indep_note: "每条各自独立 · 各自相对它自己发车算；点上方芯片切换大图聚焦哪条", d_short_gather: "集结剩 {x}", d_short_land: "发车后 {x}", d_short_imm: "发车后立刻", d_short_fill: "先填行军",
      d_cue_gather: "他集结剩 {x} 时发兵", d_cue_land: "他发车后 {x} 发兵", d_cue_imm: "他发车后立刻发（你很快）", d_cue_fill: "先填你的行军时间",
      d_note: "补兵在它落地后≈1秒到，正好补满 ✓", d_erow: "敌集结 5:00 · 你行军 {x}", d_lane_title: "🔴 {n} · 行军 {x}",
      d_ph_gather: "① 敌方集结中（加速）…", d_ph_send: "② 发兵！就是现在", d_ph_land: "③ 敌落地", d_ph_refill: "✅ 补满·弹回", d_ph_low: "③ 护盾告急→快补兵", d_ph_inc: "② 敌方来袭→盯落地",
      d_fx_send: "发兵！", d_fx_land: "敌落地", d_fx_refill: "补满！", d_fx_depart: "他发车！", d_ph_depart: "② 他发车了 → 盯落地", d_gather_cd: "集结 {x}", d_land_cd: "落地 {x}", d_whale: "敌鲸", d_enemy: "敌",
      slot_weak: "🛡️ 消耗", slot_weak_sub: "先落地 · 挡刀吃守军", slot_main: "👑 主力", slot_main_sub: "+1秒跟进收头", slot_empty: "待选", slot_swap_tip: "已互换主力/消耗",
      roster_search: "按昵称或 Player ID 搜索", replace_choose: "选择要替换的位置", replace_weak: "替换消耗 · {n}", replace_main: "替换主力 · {n}", replace_cancel: "取消", already_kingdom: "该玩家已在王国 {k}", stage_other_kingdom: "该玩家刚被另一王国选中，已恢复你的选择",
      edit_march: "修改 {n} 的行军时间", march_save: "保存", march_cancel: "取消", march_adjust: "调整行军时间", march_decrease: "减少 {n} 秒", march_increase: "增加 {n} 秒", march_latest: "房间当前值：{x}", march_active_unchanged: "已发出的倒数不会被这次修改影响", march_invalid: "请输入 0:05–3:00（5–180 秒）", march_conflict: "另一位指挥已更新；保留了你的草稿", march_retry: "按最新值重试", march_adopt: "采用最新值", march_saved: "已保存并同步到全房间", march_pending: "正在等待服务器确认与房间同步…", march_unsaved: "未保存 · 连接恢复后请手动重试", march_stale: "该玩家已不存在，正在刷新房间", march_locked: "先解锁指挥台才能修改",
      plat_ios: "🍎 iPhone：通常可在后台提醒；开战前请锁屏实测", plat_android: "🤖 安卓：保持本页亮屏最稳；系统可能暂停后台", plat_desktop: "💻 电脑：保持本标签页开启，并先做一次测试",
      atk_note: "🟡 集结 5:00 → 🟢 行军 → 到点落地", order_cancelled: "✖ 指令已取消", defense_demo: "演练动画 · 非实时战况"
    },
    en: {
      join: "Enter room", ornew: "or join another room", joinhint: "Just a room name (share the same one with your team).", room: "Room", enter: "Enter", last: "Continue",
      fill: "Your info (just once)", fillsub: "This collapses after you submit — then you just watch one big countdown.", march: "March time to the castle", marchtip: "Drag, or tap ± for the exact second", save: "Submit", edit: "Edit", you: "You", updated: "Submitted · room updated",
      unlock: "🔓 Enter room password for commander mode", cmd: "Commander", kdhint: "Choose the kingdom for this order", pickhint: "Tap 2 captains for the double rally; tap the badge to swap main/sacrifice.",
      firedbl: "Fire — tap twice", leadhint: "Lead time · each captain starts their own countdown here", firerefill: "💧 Call a refill", cancel: "✖ Cancel current", sim: "▶ Practice", simstop: "Stop", soundcheck: "📣 Test alert (whole room)", tapagain: "✓ Tap again to confirm",
      pwtitle: "Room password", pwph: "Enter room password", pwcancel: "Cancel", pwgo: "Unlock",
      pwtitle_new: "First unlock · set a commander password", pwph_new: "Choose a new password", pwgo_new: "Set & unlock",
      pwhint_new: "This room has no commander password yet — whatever you enter now becomes this room's password. Share it with your co-commanders.",
      net_off: "Connecting…", syncing: "syncing…", online_n: "{n} online",
      idlesub: "When the commander fires, this becomes your countdown", waitlaunch: "⏳ Waiting for your {n}s launch countdown", youlaunch: "🚗 YOU launch!", whalelaunch: "🐋 Whales launch", main: "Main", weak: "Sacrifice",
      refilltitle: "💧 Refill the garrison now", refillsub: "Top up right after they land — bounce them back", go: "GO!",
      soundon: "🔊 Page alerts enabled", soundgate: "① Enable page alerts · phones may pause background audio; test before battle", need2: "Pick 2 captains first", wrongpw: "Wrong password",
      player_actions: "Actions for {n}", action_edit_march: "Edit march time", action_remove: "Remove player", remove_confirm: "Remove {n} from this room?", remove_aria: "Remove {n}", remove_description: "This removes the player from every commander and clears their staged positions.", remove_impact: "Staged positions that will be cleared:", remove_impact_line: "Kingdom {k} · {r}", remove_no_impact: "No staged positions", remove_in_use: "This player is in an active rally — cancel it before removal", remove_cancel: "Cancel", remove_button: "Remove player", removing: "Waiting for the room to confirm removal of {n}…", remove_unknown: "Connection closed; outcome unknown. Reconnect will verify it without resending.", remove_retry: "Not sent or not confirmed. Retry manually.", remove_changed: "The player or staged impact changed. Review it, then confirm again.", removed: "Removed {n}", player_missing: "A captain was removed or is no longer in the roster — pick again",
      mapcastle: "King's Castle", mapempty: "Nobody yet · share the room link", mapstaged: "Staged · waiting for the order", kw1: "Kingdom ①", kw2: "Kingdom ②", mapnote: "⭕ each ring = 30s march · outer = farther from the castle",
      copylink: "📋 Tap to copy the room link", copied: "✓ Copied — share it with your team", idle_wait: "✅ All set · wait for the order; test this device's background alert below before switching to the game.",
      idle_note: "○ each dot = march time to the castle · turns into a live progress bar at fire", legend_live: "● main ○ sacrifice · closer = landing sooner",
      join_note: "🐋 Rally live — go tap JOIN on the whale's rally in-game now", pulled_atk: "⚔️ Launch order live — switched to Attack (you can tab back)",
      namefail: "✕ Name not found · that's fine — your ID will be shown", pidph: "the numeric ID under your in-game avatar", nicknameph: "enter a nickname for testing", marchfirst: "First drag the slider (or tap ±) to confirm your march time",
      identity_type: "Identity type", identity_player_id: "Player ID", identity_nickname: "Nickname", identity_recommended: "Recommended", identity_testing: "For testing", invalid_nickname: "Enter a valid nickname", duplicate_suffix: "Matching nicknames show a distinguishing marker",
      defsethint: "m:s = the enemy's march time to the castle · everyone's refill countdown is computed from it",
      sc_title: "📣 Sound check", sc_sub: "Everyone hear this?", you_short: "You", main_s: "MAIN", sac_s: "SAC",
      joincue: "Tap JOIN on a whale's rally at GO", marchhow: "How: in-game open a rally on the King's Castle, read its march timer, enter it here.",
      fired: "Fired ✓", notconn: "Not connected · reconnecting", notsynced: "Still syncing — wait a sec", nomarch: "A captain has no march time set",
      cancelq: "Tap again to cancel the order", cancelled: "Cancelled", staged_line: "🛡️ You're the {k} {r} captain · stand by",
      as_on: "🔊 Alerts on — you can switch to the game", as_warn: "⚠️ Sound paused by the OS — tap to resume", bgtest: "🔒 Test bg", bgtest_on: "Lock & switch to the game — a full 10s countdown demo starts now 🔔", 
      ready_btn: "✅ I'm ready", ready_done: "✓ Ready", notready: "A captain hasn't tapped Ready — firing anyway", readyon: "✓ Told the commander you're ready", readyline: "Ready {n}/{m}", rally_live: "A rally is still live in this kingdom — cancel it before a refill", cap_absent: "A captain went offline — firing anyway", syncp: "{n}/{m} synced & present", syncp_pick: "Pick 2 captains", land_cap: "LAND",
      delivery_sent: "Sent", delivery_received: "Received ✓", delivery_received_count: "Received {n}/{m}", delivery_missing: "No confirmation", delivery_expired: "Expired",
      settings: "⚙️ Alert settings", bgtest2: "🔔 Test lock-screen / in-game alert", cmdlink: "🔓 I'm the commander → unlock", marchlab: "March time to the castle", marchtip2: "in-game: open a rally on the castle, read that number",
      cancel_k: "✖ Cancel {k}'s rally", legend: "● you ○ mates · 30s per ring, outer = farther", unlocking: "checking password…", checklist_done: "All set — just wait for the commander",
      tab_atk: "Attack", tab_def: "Defense", dpanel: "🛡️ When to refill (for your march)", dpanelhint: "Pick the incoming whale and follow the big text. Above the line = enemy (gather → 🔴 hits), below = you (🟢 send → march → reinforced✓). Your reinforcement lands ~1s after they hit — bounces them back.",
      addenemy: "Add incoming", pubwhales: "📣 Publish to squad", pub_ok: "✓ Published to squad", pub_fail: "Publish failed (password or network)", pub_neterr: "Network error", publishing: "Publishing…", confirm_over: "Someone just published a newer version. Overwrite?", whale_ph: "Enemy name", pubdef_none: "Add an incoming whale first",
      d_empty: "The commander hasn't published incoming whales yet — ask them to set them in the console.", d_you_send: "You send", d_enemy_land: "Hits", d_refilled: "Reinforced✓", d_gather_band: "Enemy gather 5:00 (rush)", d_send_now: "SEND!", d_your_march: "march {x}", d_depart: "they march", d_side_enemy: "Enemy", d_side_our: "You",
      d_indep_note: "each incoming is independent · timed from its own launch; tap a chip above to switch which one the radar shows", d_short_gather: "gather: {x} left", d_short_land: "after launch {x}", d_short_imm: "send now", d_short_fill: "fill march",
      d_cue_gather: "Send when their gather timer shows {x} left", d_cue_land: "Send {x} after they march", d_cue_imm: "Send right after they march (you're fast)", d_cue_fill: "Fill your march time first",
      d_note: "Your reinforcement lands ~1s after they hit — right in time ✓", d_erow: "Enemy gather 5:00 · your march {x}", d_lane_title: "🔴 {n} · march {x}",
      d_ph_gather: "① Enemy gathering (rush)…", d_ph_send: "② SEND! right now", d_ph_land: "③ Enemy hits", d_ph_refill: "✅ Reinforced · held", d_ph_low: "③ Garrison low → reinforce!", d_ph_inc: "② Incoming → watch the landing",
      d_fx_send: "SEND!", d_fx_land: "Hits", d_fx_refill: "Reinforced!", d_fx_depart: "They march!", d_ph_depart: "② They marched → watch the landing", d_gather_cd: "gather {x}", d_land_cd: "land {x}", d_whale: "incoming rally", d_enemy: "Enemy ",
      slot_weak: "🛡️ SACRIFICE", slot_weak_sub: "lands first · eats the garrison", slot_main: "👑 MAIN", slot_main_sub: "lands +1s right behind", slot_empty: "—", slot_swap_tip: "Main/sacrifice swapped",
      roster_search: "Search nickname or Player ID", replace_choose: "Choose the captain to replace", replace_weak: "Replace Sacrifice · {n}", replace_main: "Replace Main · {n}", replace_cancel: "Cancel", already_kingdom: "Already selected for Kingdom {k}", stage_other_kingdom: "Another kingdom just selected this player; your prior picks were restored",
      edit_march: "Edit {n}'s march time", march_save: "Save", march_cancel: "Cancel", march_adjust: "Adjust march time", march_decrease: "Decrease {n} seconds", march_increase: "Increase {n} seconds", march_latest: "Current room value: {x}", march_active_unchanged: "An active countdown will not change", march_invalid: "Enter 0:05–3:00 (5–180 seconds)", march_conflict: "Another commander updated this player; your draft is preserved", march_retry: "Retry on latest", march_adopt: "Adopt latest", march_saved: "Saved and synchronized to the room", march_pending: "Waiting for server confirmation and room sync…", march_unsaved: "Not saved · retry manually after reconnect", march_stale: "This player is gone; refreshing the room", march_locked: "Unlock the commander console to edit",
      plat_ios: "🍎 iPhone: background alerts usually work; lock-screen test before battle", plat_android: "🤖 Android: keeping this page visible is safest; the OS may pause it", plat_desktop: "💻 Desktop: keep this tab open and run one test first",
      atk_note: "🟡 gather 5:00 → 🟢 march → lands", order_cancelled: "✖ Order cancelled", defense_demo: "Timing rehearsal · not live battle state"
    }
  };
  function L() { return window.lang === "en"; }
  function tk(k) { return (KT[L() ? "en" : "zh"] || KT.zh)[k] || k; }
  function tkf(k, v) { var s = tk(k); for (var p in v) s = s.split("{" + p + "}").join(v[p]); return s; }
  function setCancelLabel() { var b = $("cancelBtn"); if (b) b.textContent = tkf("cancel_k", { k: tk("kw" + fireKingdom) }); }

  /* ---------- voice (TTS) ---------- */
  // announcement is MINE-ONLY, so "it's your turn" is the entire message — kingdom and main/sacrifice
  // are the commander's bookkeeping (still visible on the captain's screen), not something to read aloud
  var VOICE = {
    en: { code: "en-US", yours: "your rally", launch: "launch in", sec: "seconds", refill: "refill now", check: "Sound check" },
    zh: { code: "zh-CN", yours: "该你开车", launch: "还有", sec: "秒", refill: "现在补兵", check: "声音测试" },
    ja: { code: "ja-JP", yours: "あなたの番", launch: "あと", sec: "秒", refill: "補充", check: "サウンドチェック" }
  };
  function vw() { return VOICE[window.lang === "zh" ? "zh" : "en"]; }   // announcement language follows the UI 中/EN toggle
  var voicesCache = [];
  function loadVoices() { try { voicesCache = (window.speechSynthesis && speechSynthesis.getVoices()) || []; } catch (e) { voicesCache = []; } }
  loadVoices(); try { if (window.speechSynthesis) speechSynthesis.onvoiceschanged = loadVoices; } catch (e) {}
  var VPREF = { en: [/neural/i, /natural/i, /google us english/i, /\baria\b/i, /jenny/i, /\bava\b/i, /samantha/i, /siri/i], zh: [/neural/i, /xiaoxiao/i, /yunxi/i, /ting-?ting/i, /google.*(普通话|中文)/i, /siri/i], ja: [/neural/i, /nanami/i, /kyoko/i, /google.*日本/i, /siri/i] };
  var VGENDER = { en: { f: /samantha|\bava\b|\baria\b|jenny|allison|\bzira\b|female|google us english/i, m: /\balex\b|daniel|\baaron\b|\bguy\b|davis|\bbrian\b|male/i }, zh: { f: /xiaoxiao|xiaoyi|ting-?ting|mei-?jia|female/i, m: /yunxi|yunyang|kangkang|male/i }, ja: { f: /\bo-?ren\b|kyoko|nanami|female/i, m: /otoya|keita|male/i } };
  function langPool() { var lc = vw().code.toLowerCase().slice(0, 2); var p = voicesCache.filter(function (v) { return (v.lang || "").toLowerCase().slice(0, 2) === lc; }); return p.length ? p : voicesCache; }
  function vscore(v) { var p = VPREF[window.lang === "zh" ? "zh" : "en"] || []; for (var i = 0; i < p.length; i++) if (p[i].test(v.name)) return i; return 50 + (v.localService === false ? 0 : 10); }
  function pickVoice() { var pool = langPool(); if (!pool.length) return null; var s = pool.slice().sort(function (a, b) { return vscore(a) - vscore(b); }); var re = (VGENDER[window.lang === "zh" ? "zh" : "en"] || VGENDER.en).f; return s.filter(function (v) { return re.test(v.name); })[0] || s[0] || null; }   // female only
  var lastUtter = null;   // keep a live reference — Chrome GCs un-referenced utterances and they go SILENT (the "no sound on Mac" bug)
  function speak(t) {
    if (!window.speechSynthesis) return;
    try {
      try { window.__say = t; } catch (e2) {}   // debug hook: last spoken line (headless can't hear)
      var u = new SpeechSynthesisUtterance(t), v = pickVoice(); if (v) u.voice = v;
      u.lang = vw().code; u.rate = .97; u.pitch = 1.05; lastUtter = u;
      // desktop Chrome quirks: cancel() while idle can swallow the NEXT speak(); a paused queue never resumes on its own
      if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
      try { speechSynthesis.resume(); } catch (e) {}
      speechSynthesis.speak(u);
    } catch (e) {}
  }

  /* ---------- background audio engine ----------
     Research-backed (WebKit #261554/#237322, Chrome background-tabs):
     - The keep-alive carrier is an HTML <audio> playing low-but-audible looped content. On iOS the
       silent/ring switch mutes Web Audio but NOT a media element, and a continuously-playing media
       element keeps the page (JS + WebSocket) and the AudioContext alive in the background.
     - Cues fire as Web Audio beeps PRE-SCHEDULED on the audio clock (ac.currentTime + offset) — the
       only thing that survives a backgrounded/locked iOS tab. New commands arriving over the WS
       reschedule on message (timers freeze in background; the socket message handler does not).
     - Best-effort, never a hard guarantee: a phone call / jetsam / Low-Power-Mode / OEM killer can
       still break it. UI surfaces the live status + a lock-screen self-test. */
  function AC() { return window.AudioContext || window.webkitAudioContext; }
  function ensureAudio() {
    try {
      if (!ac) { ac = new (AC())(); window.__ac = ac; ac.onstatechange = function () { if (ac.state !== "running") { try { ac.resume(); } catch (e) {} } if (ac.state === "running") sendDeviceStatus("deviceStatus", true); paintAudioStatus(); }; }
      if (ac.state !== "running") ac.resume();
      if (navigator.audioSession && navigator.audioSession.type !== "playback") navigator.audioSession.type = "playback";
    } catch (e) {} return ac;
  }
  /* keep-alive bed = a clean 40Hz sub-bass sine (below phone-speaker response → humans don't hear it).
     Amplitude strategy differs per platform:
     - iOS Safari IGNORES audio.volume, so the file itself must be near-silent (amp .002); any playing media
       element exempts the page from suspension regardless of loudness.
     - Android/desktop Chrome FREEZES hidden tabs after ~5min unless the tab is AUDIBLE — and its audibility
       check is an energy threshold on the actual output. amp .002 reads as silence → tab frozen → WebSocket
       killed → the red dot the Android users saw. Bake a louder sample (amp .05, still 40Hz) and gate loudness
       with audio.volume, which Chrome DOES honor: 0 in the foreground, up when hidden. */
  function bedURI(amp) {
    var sr = 8000, n = sr, d = new Int16Array(n);
    for (var i = 0; i < n; i++) d[i] = Math.sin(i / sr * 2 * Math.PI * 40) * amp * 32767;
    var buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf), o = 0;
    function S(t) { for (var j = 0; j < t.length; j++) v.setUint8(o++, t.charCodeAt(j)); } function U32(x) { v.setUint32(o, x, true); o += 4; } function U16(x) { v.setUint16(o, x, true); o += 2; }
    S("RIFF"); U32(36 + n * 2); S("WAVE"); S("fmt "); U32(16); U16(1); U16(1); U32(sr); U32(sr * 2); U16(2); U16(16); S("data"); U32(n * 2);
    for (var k = 0; k < n; k++) { v.setInt16(o, d[k], true); o += 2; }
    var u8 = new Uint8Array(buf), b = ""; for (var m = 0; m < u8.length; m++) b += String.fromCharCode(u8[m]);
    return "data:audio/wav;base64," + btoa(b);
  }
  function bedVol() { if (!document.hidden) return 0; return isIOS ? .04 : (isAndroid ? 1 : .3); }   // foreground always silent; hidden → loud enough for the Chrome audibility check (40Hz stays inaudible to people)
  function syncBedVol() { try { if (keepAudio) keepAudio.volume = bedVol(); } catch (e) {} }
  function startKeepAlive() {
    try {
      if (!keepAudio) {
        keepAudio = new Audio(); keepAudio.src = bedURI(isIOS ? .002 : .05); keepAudio.loop = true; keepAudio.volume = bedVol(); keepAudio.preload = "auto"; keepAudio.setAttribute("playsinline", "");
        keepAudio.addEventListener("pause", function () { if (soundReady) setTimeout(resumeAudio, 250); });   // auto-restart if the OS pauses the bed
      }
      var pr = keepAudio.play(); if (pr && pr.then) pr.then(function () { keepAlive = true; window.__keepAlive = true; paintAudioStatus(); }).catch(function () { keepAlive = false; paintAudioStatus(); });
      if ("mediaSession" in navigator) { try { navigator.mediaSession.metadata = new window.MediaMetadata({ title: "KvK alerts on", artist: "kingshoter" }); navigator.mediaSession.setActionHandler("play", resumeAudio); navigator.mediaSession.setActionHandler("pause", function () { }); } catch (e) {} }
    } catch (e) {}
  }
  function resumeAudio() { ensureAudio(); try { if (keepAudio) { syncBedVol(); if (keepAudio.paused) { var p = keepAudio.play(); if (p && p.catch) p.catch(function () {}); } } } catch (e) {} paintAudioStatus(); }
  function audioAlive() { return !!(soundReady && ac && ac.state === "running"); }   // cues ride the audio clock; a momentarily-paused keep-alive bed doesn't kill them, so don't cry wolf
  var astatOkAt = 0;
  function paintAudioStatus() {
    var el = $("audioStatus"); if (!el) return; if (!soundReady) { el.style.display = "none"; return; }
    if (audioAlive()) {   // healthy = quiet: show the reassurance for 6s, then get out of the way (warn state stays until tapped)
      if (!astatOkAt) { astatOkAt = Date.now(); setTimeout(paintAudioStatus, 6300); }
      el.style.display = Date.now() - astatOkAt > 6000 ? "none" : "";
      el.className = "astat on"; el.textContent = tk("as_on") + " · " + tk(isIOS ? "plat_ios" : isAndroid ? "plat_android" : "plat_desktop");
    } else { astatOkAt = 0; el.style.display = ""; el.className = "astat warn"; el.textContent = tk("as_warn"); }
  }
  // screen wake lock (Android/desktop): while this page stays visible the screen never sleeps, so timers/audio never throttle.
  // Auto-released by the OS on tab switch; re-acquired on every resume. Best-effort — no-op where unsupported.
  var wakeLock = null;
  function keepAwake() { try { if (document.visibilityState === "visible" && navigator.wakeLock && !wakeLock) navigator.wakeLock.request("screen").then(function (wl) { wakeLock = wl; wl.addEventListener("release", function () { wakeLock = null; }); }).catch(function () {}); } catch (e) {} }
  function beep(when, freq, dur, vol) { var o = ac.createOscillator(), g = ac.createGain(); o.connect(g); g.connect(ac.destination); o.type = "sine"; o.frequency.value = freq; g.gain.setValueAtTime(.0001, when); g.gain.exponentialRampToValueAtTime(vol, when + .012); g.gain.exponentialRampToValueAtTime(.0001, when + dur); o.start(when); o.stop(when + dur + .03); return { o: o, g: g }; }
  // scheduledBeeps[key] = {t: targetMs (server clock), off: clockOffset used when booked, base: command key, nodes:[{o,g}]}
  // nodes are RETAINED so a cue can be killed: cancelled rallies must go silent (they used to beep 5..GO anyway).
  var scheduledBeeps = {}, BEEP_HZ = 740;   // 10..6 = constant-pitch ticks; 5..1 + GO = pre-generated female voice clips
  try { window.__cues = scheduledBeeps; } catch (e) {}
  /* countdown voice: pre-generated neural clips (zh 小晓 / en Aria), decoded into Web Audio buffers and
     pre-scheduled on ac.currentTime exactly like the beeps — sample-accurate, identical on every device,
     and still fires when the phone is backgrounded (device TTS was robotic, per-device random, and dies in bg). */
  var sfxBuf = { zh: {}, en: {} }, sfxStarted = false;
  function loadSfx() {
    if (sfxStarted || !ac) return; sfxStarted = true; window.__sfx = 0;
    ["zh", "en"].forEach(function (lg) {
      ["5", "4", "3", "2", "1", "go"].forEach(function (n) {
        fetch("/sfx/" + lg + "_" + n + ".mp3").then(function (r) { return r.arrayBuffer(); })
          .then(function (ab) { return ac.decodeAudioData(ab); })
          .then(function (buf) { sfxBuf[lg][n] = buf; window.__sfx = (window.__sfx || 0) + 1; })
          .catch(function () {});   // a missing clip just falls back to a beep at schedule time
      });
    });
  }
  function playClip(when, buf, vol) { var s = ac.createBufferSource(), g = ac.createGain(); s.buffer = buf; s.connect(g); g.connect(ac.destination); g.gain.setValueAtTime(vol, when); s.start(when); return { o: s, g: g }; }
  function stopCue(e) { (e.nodes || []).forEach(function (n) { try { n.g.gain.cancelScheduledValues(0); n.g.gain.setValueAtTime(0.0001, 0); n.o.stop(0); n.o.disconnect(); n.g.disconnect(); } catch (x) {} }); }
  function scheduleBeeps(key, targetSec, windowMs) {
    ensureAudio(); if (!ac || ac.state !== "running") return;
    var win = windowMs || 360000, nowMs = window.serverNow();   // long default horizon: an arg-less call must never silently swallow a >12s cue (the core-promise bug)
    for (var pk in scheduledBeeps) if (scheduledBeeps[pk].t < nowMs - 4000) { stopCue(scheduledBeeps[pk]); delete scheduledBeeps[pk]; }   // stop before pruning: a clock correction can make a still-booked WebAudio node look expired
    var lg = L() ? "en" : "zh";
    [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].forEach(function (off) {
      var k = key + ":" + off, tMs = (targetSec - off) * 1000; if (scheduledBeeps[k]) return;
      var dtMs = tMs - nowMs;
      if (dtMs < -150) { scheduledBeeps[k] = { t: tMs, off: window.clockOffset, base: key, nodes: [] }; return; } if (dtMs > win) return;
      var when = ac.currentTime + Math.max(0, dtMs) / 1000, nodes;
      if (off === 0) {
        var go = sfxBuf[lg].go;   // GO = spoken 出发!/GO! + a soft chord underneath for punch through game audio
        nodes = go ? [playClip(when, go, 1), beep(when, 1320, .4, .3), beep(when, 1760, .4, .2)]
                   : [beep(when, 1320, .5, .7), beep(when, 1760, .5, .5)];
      } else if (off <= 5) {
        var b = sfxBuf[lg][String(off)];   // 5..1 = female voice; beep fallback until clips finish decoding
        nodes = b ? [playClip(when, b, .95)] : [beep(when, BEEP_HZ, .13, .55)];
      } else nodes = [beep(when, BEEP_HZ, .12, .5)];   // 10..6 = constant-pitch ticks
      scheduledBeeps[k] = { t: tMs, off: window.clockOffset, base: key, nodes: nodes }; try { window.__beeps = (window.__beeps || 0) + 1; } catch (e) {}
    });
  }
  // A later captain waits for their own selected countdown window. Pre-book a distinct start cue for
  // leads above 10s; at 10s the shared countdown scheduler already owns the exact T-10 cue.
  function schedulePrepareCue(key, targetSec, leadSeconds, windowMs) {
    ensureAudio(); if (!ac || ac.state !== "running") return;
    var offset = Number(leadSeconds); if (!Number.isFinite(offset) || offset < 1 || offset > 120) offset = 10;
    var k = key + ":" + offset, tMs = (targetSec - offset) * 1000; if (scheduledBeeps[k]) return;
    var nowMs = window.serverNow(), dtMs = tMs - nowMs, win = windowMs || 360000;
    if (dtMs < -150) { scheduledBeeps[k] = { t: tMs, off: window.clockOffset, base: key, nodes: [] }; return; }
    if (dtMs > win) return;
    var when = ac.currentTime + Math.max(0, dtMs) / 1000;
    var nodes = [beep(when, 587, .14, .5), beep(when + .18, 784, .18, .58)];
    scheduledBeeps[k] = { t: tMs, off: window.clockOffset, base: key, nodes: nodes }; try { window.__beeps = (window.__beeps || 0) + 1; } catch (e) {}
  }
  // kill any FUTURE booked cue whose command no longer exists (cancelled / superseded). Self-tests ("locktest-…") are exempt.
  function reconcileCues() {
    if (!room) return;
    var ids = liveCommands(room).map(function (c) { return c.id; }), nowMs = window.serverNow(), killed = false;
    for (var k in scheduledBeeps) {
      var e = scheduledBeeps[k];
      if (e.base.indexOf("locktest") === 0 || e.t <= nowMs) continue;
      var alive = ids.some(function (id) { return e.base.indexOf(id) === 0; });
      if (!alive) { stopCue(e); delete scheduledBeeps[k]; killed = true; }
    }
    return killed;
  }
  // clock offset drifted (post-suspend resync)? re-book future cues on the corrected clock — a booked oscillator can't be moved, only killed+rebooked
  function rebookCuesOnDrift() {
    var moved = false;
    for (var k in scheduledBeeps) {
      var e = scheduledBeeps[k];
      if (Math.abs((e.off || 0) - window.clockOffset) > 300) { stopCue(e); delete scheduledBeeps[k]; moved = true; }
    }
    if (moved) scheduleAllCues();
  }
  function liveCommands(r) { var out = []; if (r && r.live) { if (r.live.mode === "sim" && r.live.sim) { var sc = simCommand(r.live.sim); if (sc) out.push(sc); } else if (r.live.commands) { [1, 2].forEach(function (kk) { if (r.live.commands[kk]) out.push(r.live.commands[kk]); }); } } return out; }
  // Captains receive their exact personal launch second. Everyone else receives ONE join countdown for the
  // active rally, fixing the old visual-only joiner path while avoiding overlapping cues from both kingdoms.
  function isCommanderDevice() {
    return document.body.classList.contains("cmdmode");
  }
  function shouldBookJoinAudio() {
    return !!myPid && !isCommanderDevice();
  }
  function cancelJoinCues() {
    for (var k in scheduledBeeps) {
      var cue = scheduledBeeps[k];
      if (!cue || String(cue.base || "").slice(-5) !== "-join") continue;
      stopCue(cue); delete scheduledBeeps[k];
    }
  }
  function hasFuturePersonalCue(baseKey) {
    var nowMs = window.serverNow();
    return Object.keys(scheduledBeeps).some(function (key) {
      var cue = scheduledBeeps[key];
      return key.indexOf(baseKey + ":") === 0 && cue && cue.t > nowMs - 150 && cue.nodes && cue.nodes.length > 0;
    });
  }
  function sendDeviceStatus(messageType, force) {
    if (!sock || !myPid || !deviceId) return false;
    var type = messageType || "deviceStatus", ready = audioAlive();
    var generation = Number(sock.connectionGeneration || 0);
    var signature = myPid + ":" + deviceId + ":" + (ready ? "1" : "0");
    if (type === "deviceStatus" && !force && generation === lastDeviceStatusGeneration && signature === lastDeviceStatusSignature) return true;
    var nowMs = Date.now();
    if (type === "deviceStatus" && !force && generation === lastDeviceStatusSentGeneration && signature === lastDeviceStatusSentSignature && nowMs - lastDeviceStatusSentAt < DEVICE_STATUS_RETRY_MS) return true;
    var sent = sock.send({ t: type, pid: myPid, deviceId: deviceId, soundReady: ready });
    if (sent && type === "deviceStatus") {
      lastDeviceStatusSentGeneration = generation; lastDeviceStatusSentSignature = signature; lastDeviceStatusSentAt = nowMs;
    }
    return sent;
  }
  function deliveryAckKey(value) {
    return String(value && value.commandId || "") + ":" + String(value && value.pid || "") + ":" + String(value && value.deviceId || "");
  }
  function sameDeliveryAck(a, b) {
    return !!a && !!b && a.commandId === b.commandId && a.pid === b.pid && a.deviceId === b.deviceId &&
      a.outcome === b.outcome && Number(a.targetUTC) === Number(b.targetUTC) && Number(a.scheduledAtMs) === Number(b.scheduledAtMs);
  }
  function clearPendingDeliveryAck(key) {
    var entry = pendingDeliveryAcks[key];
    if (entry && entry.timer) clearTimeout(entry.timer);
    delete pendingDeliveryAcks[key];
  }
  function clearAllPendingDeliveryAcks() {
    Object.keys(pendingDeliveryAcks).forEach(clearPendingDeliveryAck);
  }
  function rejectPendingDeliveryAck(message) {
    if (!message || message.source !== "deliveryAck") return false;
    var key = deliveryAckKey(message), entry = pendingDeliveryAcks[key];
    if (!entry) return false;
    var error = String(message.error || ""), generation = sock ? Number(sock.connectionGeneration || 0) : -1;
    if (error === "delivery_persist_failed") return false;
    var terminal = ["ack_target_missing", "ack_conflict", "invalid_ack", "invalid_ack_target"].indexOf(error) >= 0;
    if (!terminal && error !== "bad_delivery_identity") return false;
    rejectedDeliveryAcks[key] = {
      payload: entry.payload,
      error: error,
      generation: generation,
      terminal: terminal,
      deadlineMs: entry.deadlineMs
    };
    clearPendingDeliveryAck(key);
    if (error === "bad_delivery_identity") {
      lastDeviceStatusSignature = ""; lastDeviceStatusGeneration = -1;
      lastDeviceStatusSentSignature = ""; lastDeviceStatusSentGeneration = -1; lastDeviceStatusSentAt = 0;
      setTimeout(function () { sendDeviceStatus("deviceStatus", true); }, 0);
    }
    return true;
  }
  function resumeRejectedDeliveryAck(key, rejected) {
    if (!rejected || rejected.terminal || confirmedDeliveryAcks[key]) return false;
    delete rejectedDeliveryAcks[key];
    pendingDeliveryAcks[key] = {
      payload: rejected.payload, timer: 0, lastGeneration: -1, attempts: 0,
      deadlineMs: rejected.deadlineMs
    };
    return sendPendingDeliveryAck(key, true);
  }
  function clearAllDeliveryAckState() {
    clearAllPendingDeliveryAcks(); confirmedDeliveryAcks = Object.create(null); rejectedDeliveryAcks = Object.create(null);
  }
  function pausePendingDeliveryAckTimers() {
    Object.keys(pendingDeliveryAcks).forEach(function (key) {
      var entry = pendingDeliveryAcks[key];
      if (entry.timer) { clearTimeout(entry.timer); entry.timer = 0; }
    });
  }
  function pruneDeliveryAckState() {
    if (!room) return;
    var ids = liveCommands(room).map(function (command) { return command.id; }), nowMs = window.serverNow();
    Object.keys(pendingDeliveryAcks).forEach(function (key) {
      var entry = pendingDeliveryAcks[key];
      if (ids.indexOf(entry.payload.commandId) < 0 || nowMs > entry.deadlineMs || entry.payload.pid !== myPid || entry.payload.deviceId !== deviceId) clearPendingDeliveryAck(key);
    });
    Object.keys(confirmedDeliveryAcks).forEach(function (key) {
      if (ids.indexOf(confirmedDeliveryAcks[key].commandId) < 0) delete confirmedDeliveryAcks[key];
    });
    Object.keys(rejectedDeliveryAcks).forEach(function (key) {
      var rejected = rejectedDeliveryAcks[key];
      if (!rejected.payload || ids.indexOf(rejected.payload.commandId) < 0 || nowMs > rejected.deadlineMs) delete rejectedDeliveryAcks[key];
    });
  }
  function sendPendingDeliveryAck(key, force) {
    var entry = pendingDeliveryAcks[key];
    if (!entry || confirmedDeliveryAcks[key] || (!force && entry.timer)) return false;
    var nowMs = window.serverNow(), generation = sock ? Number(sock.connectionGeneration || 0) : -1;
    if (nowMs > entry.deadlineMs) { clearPendingDeliveryAck(key); return false; }
    if (entry.lastGeneration !== generation) { entry.lastGeneration = generation; entry.attempts = 0; }
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = 0; }
    var sent = !!(sock && sock.send(entry.payload));
    if (sent) entry.attempts += 1;
    var retryDelay = DELIVERY_ACK_RETRY_DELAYS_MS[Math.min(Math.max(entry.attempts - 1, 0), DELIVERY_ACK_RETRY_DELAYS_MS.length - 1)];
    if (nowMs < entry.deadlineMs) {
      retryDelay = Math.min(retryDelay, Math.max(250, entry.deadlineMs - nowMs));
      entry.timer = setTimeout(function () { entry.timer = 0; sendPendingDeliveryAck(key, true); }, retryDelay);
    }
    return sent;
  }
  function acknowledgeClassicCommand(command, target) {
    if (!sock || !target || !target.mine || !myPid || !deviceId) return false;
    if (!syncedOK) return false;
    sendDeviceStatus();   // same socket, ordered before ACK; refreshes a context that resumed just in time
    var nowMs = window.serverNow();
    var outcome = Number(target.anchor) * 1000 <= nowMs ? "expired" : hasFuturePersonalCue(command.id + "-me") ? "scheduled" : "";
    if (!outcome) return false;
    var payload = Object.freeze({
      t: "deliveryAck", commandId: command.id, pid: myPid, deviceId: deviceId,
      outcome: outcome, targetUTC: target.anchor, scheduledAtMs: nowMs
    });
    var key = deliveryAckKey(payload);
    if (confirmedDeliveryAcks[key]) return true;
    var rejected = rejectedDeliveryAcks[key], generation = Number(sock.connectionGeneration || 0);
    if (rejected && !rejected.terminal && rejected.generation !== generation) {
      return resumeRejectedDeliveryAck(key, rejected);
    }
    if (rejected) return false;
    if (!pendingDeliveryAcks[key]) {
      pendingDeliveryAcks[key] = {
        payload: payload, timer: 0, lastGeneration: -1, attempts: 0,
        deadlineMs: Math.max(nowMs + 10000, Number(target.anchor) * 1000 + 30000)
      };
    }
    return sendPendingDeliveryAck(key, false);
  }
  function handleDeliveryAckSaved(message) {
    if (!message || message.t !== "deliveryAckSaved") return false;
    var key = deliveryAckKey(message), entry = pendingDeliveryAcks[key];
    if (!entry || !sameDeliveryAck(entry.payload, message)) return false;
    if (entry.timer) clearTimeout(entry.timer);
    confirmedDeliveryAcks[key] = entry.payload;
    delete pendingDeliveryAcks[key];
    return true;
  }
  function handleDeviceStatusSaved(message) {
    if (!message || message.t !== "deviceStatusSaved" || message.pid !== myPid || message.deviceId !== deviceId) return false;
    lastDeviceStatusGeneration = sock ? Number(sock.connectionGeneration || 0) : -1;
    lastDeviceStatusSignature = myPid + ":" + deviceId + ":" + (message.soundReady === true ? "1" : "0");
    lastDeviceStatusSentGeneration = lastDeviceStatusGeneration;
    lastDeviceStatusSentSignature = lastDeviceStatusSignature;
    lastDeviceStatusSentAt = Date.now();
    if (message.soundReady !== true) return true;
    Object.keys(rejectedDeliveryAcks).forEach(function (key) {
      var rejected = rejectedDeliveryAcks[key], payload = rejected && rejected.payload;
      if (rejected && !rejected.terminal && payload && payload.pid === myPid && payload.deviceId === deviceId) {
        resumeRejectedDeliveryAck(key, rejected);
      }
    });
    return true;
  }
  function retryPendingDeliveryAcks(force) {
    Object.keys(pendingDeliveryAcks).forEach(function (key) {
      var entry = pendingDeliveryAcks[key], generation = sock ? Number(sock.connectionGeneration || 0) : -1;
      if (force || entry.lastGeneration !== generation) sendPendingDeliveryAck(key, true);
    });
  }
  function scheduleAllCues(win) {
    if (!room) return;
    reconcileCues(); pruneDeliveryAckState();
    var personal = false, cmds = liveCommands(room);
    cmds.forEach(function (c) {
      if (c.type === "ping") return;
      var tg = myTarget(c);
      if (tg.mine) {
        personal = true; scheduleBeeps(c.id + "-me", tg.anchor, win);
        var firstPress = Number(c.payload && c.payload.firstPress);
        var countdownLead = Number(c.payload && c.payload.leadSeconds);
        if (!Number.isFinite(countdownLead) || countdownLead < 1 || countdownLead > 120) countdownLead = 10;
        if (c.type === "double_rally" && Number.isFinite(firstPress) && tg.anchor > firstPress) schedulePrepareCue(c.id + "-me", tg.anchor, countdownLead, win);
        acknowledgeClassicCommand(c, tg);
      }
    });
    var canJoin = shouldBookJoinAudio();
    if (personal || !canJoin) cancelJoinCues();
    if (!personal && canJoin) {
      var join = activeCommand(room);
      if (join && join.type === "double_rally") scheduleBeeps(join.id + "-join", myTarget(join).anchor, win);
    }
  }
  function beepCancelled() { try { ensureAudio(); if (!ac || ac.state !== "running") return; var w = ac.currentTime; beep(w, 740, .16, .5); beep(w + .2, 494, .3, .5); } catch (e) {} }   // two falling tones ≠ the rising countdown
  function lockTest() { ensureAudio(); loadSfx(); var t = window.serverNowSec() + 11; scheduleBeeps("locktest-" + t, t, 60000); window.toast(tk("bgtest_on")); }   // t=+11 → the whole 10..GO hybrid plays
  function beepConfirm() { try { ensureAudio(); if (!ac) return; var w = ac.currentTime; beep(w, 880, .12, .55); beep(w + .15, 1175, .14, .55); } catch (e) {} }
  function fireAlert() { try { navigator.vibrate && navigator.vibrate([110, 55, 110]); } catch (e) {} try { ensureAudio(); if (!ac || ac.state !== "running") return; var o = ac.createOscillator(), g = ac.createGain(); o.connect(g); g.connect(ac.destination); o.type = "sine"; o.frequency.value = 880; g.gain.setValueAtTime(.001, ac.currentTime); g.gain.exponentialRampToValueAtTime(.4, ac.currentTime + .02); g.gain.exponentialRampToValueAtTime(.001, ac.currentTime + .5); o.start(); o.stop(ac.currentTime + .5); } catch (e) {} }
  function primeAudioOnce() { var f = function () { enableSound(true); document.removeEventListener("pointerdown", f); }; document.addEventListener("pointerdown", f); }
  function enableSound(silent) {
    soundReady = true; ensureAudio(); loadSfx(); startKeepAlive(); keepAwake();
    try { if (window.speechSynthesis) { loadVoices(); var u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); } } catch (e) {}
    var g = $("soundGate"); if (g) g.style.display = "none";
    var rv = $("roomView"); if (rv) rv.classList.remove("presound");   // step ① done → unlock the rest of the page
    sendDeviceStatus(); paintHero(); paintAudioStatus();
    setTimeout(function () { sendDeviceStatus(); scheduleAllCues(); }, 0);
    if (!silent) { beepConfirm(); window.toast(tk("soundon")); }
  }

  /* ---------- command model ---------- */
  // the command THIS player should follow: a command where they're a picked captain (either kingdom) wins; else the soonest live command
  function activeCommand(r) {
    if (r.live && r.live.mode === "sim" && r.live.sim) return simCommand(r.live.sim);
    var cmds = liveCommands(r);
    if (!cmds.length) return null;
    var mineCmd = cmds.filter(function (c) { return c.payload && c.payload.pairs && c.payload.pairs.some(function (p) { return p.pid === myPid; }); })[0];
    if (mineCmd) return mineCmd;
    // an UPCOMING order always beats one whose click moment already passed — a double_rally stays "live"
    // for its whole ~6min flight, but an older kingdom order must not mask a newer upcoming order
    var nowS = window.serverNowSec();
    var up = cmds.filter(function (c) { return myTarget(c).anchor >= nowS - 3; });
    if (up.length) return up.sort(function (a, b) { return myTarget(a).anchor - myTarget(b).anchor; })[0];
    return cmds.slice().sort(function (a, b) { return myTarget(b).anchor - myTarget(a).anchor; })[0];   // all past → track the most recent flight
  }
  function simCommand(sim) {
    var el = window.serverNowSec() - sim.startUTC, step = null;
    for (var i = 0; i < SIM.length; i++) if (el >= SIM[i].off) step = SIM[i];
    if (!step) return null;
    var base = sim.startUTC + step.off, id = "sim-" + sim.id + "-" + step.off;
    if (step.kind === "refill") return { id: id, type: "refill", anchorUTC: base + 6, kingdom: step.kingdom };
    var pairs = [{ pid: "_sW", name: "Demo-SAC", role: "weak", march: 60, pressUTC: base + 4 }, { pid: "_sM", name: "Demo-MAIN", role: "main", march: 60, pressUTC: base + 5 }];
    return { id: id, type: "double_rally", anchorUTC: base + 4, payload: { pairs: pairs, firstPress: base + 4, kingdom: step.kingdom } };
  }
  function myTarget(c) {
    if (c.type === "double_rally" && c.payload && c.payload.pairs) {
      var mine = c.payload.pairs.filter(function (p) { return p.pid === myPid; })[0];
      if (mine) return { anchor: mine.pressUTC, mine: true, role: mine.role };
      return { anchor: c.payload.firstPress != null ? c.payload.firstPress : c.anchorUTC, mine: false };
    }
    return { anchor: c.anchorUTC, mine: false };
  }
  /* ---------- supported-build handoff ---------- */
  function noUpdateController() {
    return {
      start: function () {},
      check: function () { return Promise.resolve(false); },
      flush: function () { return false; }
    };
  }
  function hasActivePersonalCommandForUpdate() {
    // Until the first canonical snapshot (and again during reconnect), assume this device may
    // be a live captain. A build check must never win a race against their personal countdown.
    if (ROOM && (!initialStateSeen || !syncedOK)) return true;
    var now = window.serverNow() / 1000;
    return liveCommands(room).some(function (command) {
      var target = myTarget(command);
      return target.mine && target.anchor > now - 1;
    });
  }
  var updateController = noUpdateController();
  function makeUpdateController() {
    try {
      var api = window.KvkUpdate;
      if (!api || typeof api.createController !== "function") return noUpdateController();
      var controller = api.createController({
        fetcher: window.fetch.bind(window),
        location: window.location,
        document: document,
        hasActivePersonalCommand: hasActivePersonalCommandForUpdate,
        setIntervalFn: window.setInterval.bind(window)
      });
      if (!controller || typeof controller.start !== "function" ||
          typeof controller.check !== "function" || typeof controller.flush !== "function") {
        return noUpdateController();
      }
      return controller;
    } catch (error) { return noUpdateController(); }
  }
  function safeUpdateStart() {
    try {
      updateController = makeUpdateController();
      updateController.start();
      return true;
    } catch (error) {
      updateController = noUpdateController();
      return false;
    }
  }
  function safeUpdateCheck() {
    try {
      var result = updateController.check();
      if (result && typeof result.catch === "function") result.catch(function () {});
      return true;
    } catch (error) { return false; }
  }
  function safeUpdateFlush() {
    try { return updateController.flush() === true; }
    catch (error) { return false; }
  }
  function announceCmd(c, tg, remaining) {
    var v = vw();
    if (c.type === "ping") return speak(v.check);
    if (c.type === "refill") return speak(v.refill);
    if (c.type === "double_rally") { var rem = Number.isFinite(remaining) ? Math.max(0, remaining) : Math.max(0, Math.ceil(tg.anchor - window.serverNow() / 1000)); speak(v.yours + ", " + v.launch + " " + rem + " " + v.sec); }   // only ever called with tg.mine — the old non-mine branch was dead code
  }

  /* ---------- the ONE hero + countdown engine ---------- */
  var lastFlashSec = null;
  function pips(rem) { var lit = (rem >= 1 && rem <= 5) ? rem : 0, h = ""; for (var i = 5; i >= 1; i--) h += '<i class="' + (i <= lit ? "lit" : "") + '"></i>'; return h; }
  function stagedForMe() { var st = room && room.live && room.live.staged; if (!st) return null; for (var k = 1; k <= 2; k++) { var s = st[k]; if (s && s.pairs) { var f = s.pairs.filter(function (x) { return x.pid === myPid; })[0]; if (f) return { kingdom: k, role: f.role }; } } return null; }
  // auto-ready: a captain is ready when joined+filled AND present (a fresh heartbeat ⇒ also clock-synced, since the same path re-runs syncClock). No tap, decays in ~70s if they drop.
  function isReady(p) { return !!(p && p.march && p.lastSeen && (window.serverNow() - Date.parse(p.lastSeen)) < 70000); }
  function refreshSyncPill() {
    var el = $("syncPill"); if (!el) return;
    var cur = pickedByK[fireKingdom], n = cur.length, rn = cur.filter(function (x) { return isReady(room && room.players && room.players[x.pid]); }).length;
    if (!n) { el.textContent = tk("syncp_pick"); el.className = "syncpill"; return; }
    el.textContent = tkf("syncp", { n: rn, m: n }); el.className = "syncpill" + (n === 2 && rn === 2 ? " allgo" : "");
  }
  function paintHero() {
    var ph = $("phero"), c = room ? activeCommand(room) : null;
    if ($("cancelBtn")) $("cancelBtn").disabled = !(room && room.live && room.live.commands && room.live.commands[fireKingdom]);
    var iw = $("idleWait");
    if (!c) {
      if (lastCmdId !== null) lastCmdId = null;
      // nothing time-sensitive: stay out of the way. The dim-lock (#roomView.presound) already flags
      // missing sound, the open fill card already flags a missing march time, and #youChip already
      // shows "you're set" once both are done — the hero doesn't need to repeat any of that.
      if (!soundReady || !isFilled()) { if (iw) iw.classList.add("hide"); ph.className = "phero hide"; return; }
      var sm = stagedForMe();
      // staged = ONE LINE in the sticky chrome (the hourglass banner is gone); commander (the stager) never sees it
      var showSt = !!(sm && !roomPw), sl = $("stagedLine");
      if (sl) { sl.classList.toggle("hide", !showSt); if (showSt) sl.textContent = tkf("staged_line", { k: tk("kw" + sm.kingdom), r: tk(sm.role === "main" ? "main" : "weak") }); }
      $("chrome").classList.toggle("staged", showSt);
      if (iw) iw.classList.toggle("hide", !!(sm || roomPw));   // idle "then what": answer it in one persistent line (commander/staged states have their own)
      ph.className = "phero hide"; return;
    }
    if (iw) iw.classList.add("hide");
    var sl2 = $("stagedLine"); if (sl2 && !sl2.classList.contains("hide")) { sl2.classList.add("hide"); $("chrome").classList.remove("staged"); }   // live command → the big hero takes over
    var tg = myTarget(c), rem = Math.ceil(tg.anchor - window.serverNow() / 1000), stale = rem < -10;
    var countdownLead = Number(c.payload && c.payload.leadSeconds);
    if (!Number.isFinite(countdownLead) || countdownLead < 1 || countdownLead > 120) countdownLead = 10;
    if (c.id !== lastCmdId) { lastCmdId = c.id; lastTickSec = null; if (window.gsap && !stale) gsap.fromTo(ph, { scale: .92, opacity: 0 }, { scale: 1, opacity: 1, duration: .35, ease: "back.out(2)" }); }   // no wholesale wipe of scheduledBeeps — per-id keys + prune keep two-kingdom cues independent
    if (stale) { ph.className = "phero hide"; return; }   // never replay a finished command (late joiner/reconnect)
    // audio / haptics / flash (once per second). Pre-schedule beeps for all live cues — survives the background freeze (voice/TTS does not)
    scheduleAllCues();
    var announceKey = c.id + ":" + tg.anchor;
    if (c.type === "double_rally" && tg.mine && rem <= countdownLead && rem > -3 && !announcedCountdowns[announceKey]) {
      announcedCountdowns[announceKey] = true; fireAlert(); announceCmd(c, tg, Math.min(countdownLead, Math.max(0, rem)));
    }
    if (rem !== lastTickSec) {
      if (tg.mine && rem >= 1 && rem <= 5) { try { navigator.vibrate && navigator.vibrate(65); } catch (e) {} }
      if (rem === 0) { if (tg.mine) { try { navigator.vibrate && navigator.vibrate(230); } catch (e) {} flashGo(c.id); } }
      lastTickSec = rem;
    }
    // phase
    var phase = rem > 10 ? "" : rem > 5 ? "soon" : rem >= 1 ? "urgent" : rem > -3 ? "go" : "";
    var kd = (c.payload && c.payload.kingdom) || c.kingdom;
    var cls = "phero " + phase + (tg.mine ? " mine" : "") + (c.type === "refill" || c.type === "ping" ? " refill" : "");
    ph.className = cls.trim();
    $("pheroKick").textContent = (room.live && room.live.mode === "sim" ? (L() ? "🧪 PRACTICE · " : "🧪 演练 · ") : "") + (kd ? tk("kw" + kd) : "");
    if (c.type === "ping") { $("pheroTitle").textContent = tk("sc_title"); $("pheroNum").textContent = "🔊"; $("pheroSub").textContent = tk("sc_sub"); $("pheroPips").innerHTML = ""; return; }
    if (c.type === "refill") { $("pheroTitle").textContent = tk("refilltitle"); $("pheroSub").textContent = tk("refillsub"); }
    else if (tg.mine && rem > countdownLead) { $("pheroTitle").textContent = tkf("waitlaunch", { n: countdownLead }); $("pheroNum").textContent = "⏳"; $("pheroSub").textContent = (tg.role === "main" ? tk("main") : tk("weak")); $("pheroPips").innerHTML = ""; return; }
    else if (tg.mine) { $("pheroTitle").textContent = tk("youlaunch"); $("pheroSub").textContent = (tg.role === "main" ? tk("main") : tk("weak")); }
    else { $("pheroTitle").textContent = tk("whalelaunch"); $("pheroSub").textContent = tk("joincue"); }
    $("pheroNum").textContent = rem >= 1 ? (tg.mine ? String(rem) : (rem > 10 ? window.mmss(rem) : String(rem))) : rem > -3 ? tk("go") : "—";
    $("pheroPips").innerHTML = pips(rem);
  }
  function flashGo(id) { if (lastFlashSec === id) return; lastFlashSec = id; var f = $("goFlash"); f.classList.add("on"); setTimeout(function () { f.classList.remove("on"); }, 600); }

  var lastTickSec = null, pulledForCmd = "";
  function tick() { if (!room || safeUpdateFlush()) return; paintHero(); syncMap(); if (roomPw) refreshSyncPill();
    // NOBODY misses a live countdown by sitting on the defense tab: captains need their click second,
    // joiners need "tap JOIN at GO" — pull to attack ONCE per order (with a toast saying why), then let
    // people tab back freely: a 200ms re-force made the defense tab a dead button with zero explanation
    if (viewMode === "defense") { var c = activeCommand(room); if (c) { var tg = myTarget(c); if ((tg.anchor - window.serverNowSec()) > -3 && pulledForCmd !== c.id) { pulledForCmd = c.id; setView("attack"); window.toast(tk("pulled_atk")); } } }
  }
  setInterval(tick, 200);
  // backgrounding freezes timers → pre-queue ALL live cues on the audio clock now (survives the freeze). Returning → resume audio + reconnect + reschedule.
  function onResume() { if (ROOM && (!sock || !sock.connected)) initialStateSeen = false; beginClockSync(); safeUpdateCheck(); resumeAudio(); keepAwake(); if (sock && !sock.connected) sock.kick(); else sendDeviceStatus(); retryPendingDeliveryAcks(true); }   // re-sync the clock on return so post-suspend drift can't mis-time the GO, then reschedule on the fresh offset
  document.addEventListener("visibilitychange", function () {
    syncBedVol();   // raise the keep-alive bed to a faint level only now that we're backgrounded; silent again on return
    if (document.visibilityState === "hidden") { if (!room) return; ensureAudio(); scheduleAllCues(); }
    else onResume();
  });
  window.addEventListener("pageshow", onResume);
  window.addEventListener("pagehide", pausePendingDeliveryAckTimers);
  document.addEventListener("resume", onResume);   // Page Lifecycle: Android un-freezes the tab → reconnect + re-arm immediately
  // sticky fire dock yields while any input has focus (iOS keyboard would otherwise shove it over the whale editor)
  function focusNeedsFireDockYield(target) {
    return !!(target && (/^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName) || (target.closest && target.closest("#commanderMarchEditor:not(.hide)"))));
  }
  document.addEventListener("focusin", function (e) { var fd = $("fireDock"); if (fd && focusNeedsFireDockYield(e.target)) fd.classList.add("nofix"); });
  document.addEventListener("focusout", function () { setTimeout(function () { var fd = $("fireDock"); if (fd && !focusNeedsFireDockYield(document.activeElement)) fd.classList.remove("nofix"); }, 0); });
  window.addEventListener("focus", function () { resumeAudio(); });
  setInterval(function () { if (soundReady) { resumeAudio(); scheduleAllCues(); } if (sock) { if (!sock.connected) sock.kick(); else sendDeviceStatus("hb", true); } try { if (window.speechSynthesis && speechSynthesis.paused) speechSynthesis.resume(); } catch (e) {} }, 25000);   // heartbeat: keep the WS warm, keep me un-evictable, self-heal audio + a stuck TTS queue (desktop Chrome), re-arm cues

  /* ---------- map: radar (space) + synced timeline (time), ONE data source so they never desync ---------- */
  var CX = 180, CY = 66, ATK_GATHER = 300, mapS = { mode: null, raf: null, t0: 0, span: 1, domain: 90, live: false };   // ATK_GATHER: rally gather 5:00 — on the timeline so the landing time is REAL
  function E(t, a) { var e = document.createElementNS("http://www.w3.org/2000/svg", t); for (var k in a) e.setAttribute(k, a[k]); return e; }
  function E2(t, x, y, txt, fill, fs) { var e = E("text", { x: x, y: y, "text-anchor": "middle", fill: fill, "font-weight": 800, "font-size": fs }); e.textContent = txt; return e; }
  function stopRaf() { if (mapS.raf) { cancelAnimationFrame(mapS.raf); mapS.raf = null; } }
  function mapData() {
    if (!room) return { live: false, actors: [] };
    var c = activeCommand(room);
    if (c && c.type === "double_rally" && c.payload && c.payload.pairs && c.payload.pairs.length) {
      // real arc: press (click) → 5:00 gather → march → land. The right-rail landing clock is the ACTUAL landing.
      var pairs = c.payload.pairs.map(function (p) { var ge = p.pressUTC + ATK_GATHER; return { pid: p.pid, name: p.name || p.pid, role: p.role, march: p.march, mine: p.pid === myPid, press: p.pressUTC, gatherEnd: ge, land: ge + p.march }; });
      pairs.sort(function (a, b) { return a.march - b.march; });
      var t0 = Math.min.apply(null, pairs.map(function (p) { return p.press; })), maxLand = Math.max.apply(null, pairs.map(function (p) { return p.land; }));
      return { live: true, id: c.id, kingdom: (c.payload.kingdom) || 1, actors: pairs, t0: t0, span: Math.max(8, maxLand - t0) };
    }
    var ps = Object.keys(room.players || {}).map(function (pid) { var p = room.players[pid]; return { pid: pid, name: p.name || pid, role: "joiner", march: Math.max(5, Math.min(180, p.march || 60)), mine: pid === myPid }; });
    ps.sort(function (a, b) { return a.march - b.march; });
    return { live: false, actors: ps };
  }
  function domainFor(ms) { var mx = ms.length ? Math.max.apply(null, ms) : 60; return Math.max(30, Math.ceil(mx / 30) * 30); }   // round up to a 30s multiple so ring/axis ticks land clean
  function ringR(s, dom) { return 12 + Math.min(s, dom) / dom * 52; }   // radar (viewBox 150 tall): glance-only, no numbers — the timeline carries the times
  function clockAt(utc) { var d = new Date(utc * 1000); return window.pad(d.getHours()) + ":" + window.pad(d.getMinutes()) + ":" + window.pad(d.getSeconds()); }   // absolute landing clock time
  function renderRadar(d) {
    var svg = $("radar"); if (!svg) return; svg.innerHTML = ""; var dom = mapS.domain; mapS.dots = [];
    for (var s = 30; s <= dom; s += 30) svg.appendChild(E("circle", { cx: CX, cy: CY, r: ringR(s, dom), fill: "none", stroke: "#cdeee8", "stroke-width": 1.3, "stroke-dasharray": "2 6" }));
    window.ksCastle(svg, CX, CY, "neutral");
    if (!d.actors.length) {
      // empty-state guidance sits BELOW the castle (it used to overlap the icon and read as a render bug),
      // and "share the link" gets an actual tap action instead of sending people to dig in the address bar
      svg.appendChild(E2("text", CX, 106, tk("mapempty"), "#5aa99b", 9));
      var cp = E2("text", CX, 124, tk("copylink"), "#0fa193", 10); cp.setAttribute("id", "copyLinkT"); cp.setAttribute("style", "cursor:pointer"); svg.appendChild(cp);
    }
    else {
      var n = d.actors.length;
      d.actors.forEach(function (a, i) {
        var ang = (n > 1 ? (38 + 104 * i / (n - 1)) : 90) * Math.PI / 180, r0 = ringR(a.march, dom), col = a.role === "main" ? "#0fa193" : "#19c8b9";
        var g = E("g", {});   // numberless glyph (dot + 'you' ring) translated each frame toward the castle
        if (a.mine) g.appendChild(E("circle", { cx: 0, cy: 0, r: 9, fill: "none", stroke: "#f5c542", "stroke-width": 2.5 }));
        g.appendChild(E("circle", { cx: 0, cy: 0, r: 6, fill: a.role === "main" ? col : "#eafaf7", stroke: col, "stroke-width": 2.5 }));
        g.setAttribute("transform", "translate(" + (CX + Math.cos(ang) * r0).toFixed(1) + "," + (CY + Math.sin(ang) * r0).toFixed(1) + ")");
        svg.appendChild(g); mapS.dots.push({ g: g, ang: ang, r0: r0, a: a });
      });
    }
    svg.appendChild(E2("text", CX, 145, tk(d.live ? "legend_live" : "legend"), "#9cc4bc", 8));   // live draws captains only — a "● you" legend would promise a dot most viewers don't have
  }
  function laneRow(a, i, live, dom, t0, span) {
    var col = a.role === "main" ? "#0fa193" : "#19c8b9", fill = a.role === "main" ? col : "#fff", nm = (a.mine ? "● " : "○ ") + window.esc(a.name || a.pid);
    if (live) {
      // gather band = press → press+5:00 (amber), flight = gatherEnd → land (teal); one true linear time axis
      var pressX = Math.max(0, Math.min(100, (a.press - t0) / span * 100)),
        gEndX = Math.max(0, Math.min(98, (a.gatherEnd - t0) / span * 100)),
        landX = Math.max(6, Math.min(98, (a.land - t0) / span * 100));
      mapS.lanes[i] = { pressX: pressX, gEndX: gEndX, landX: landX, press: a.press, gatherEnd: a.gatherEnd, land: a.land };
      return '<div class="lane role-' + a.role + (a.mine ? " me" : "") + '"><span class="lname">' + nm + '</span>'
        + '<div class="ltrack"><i class="gband" style="left:' + pressX + '%;width:' + Math.max(0, gEndX - pressX).toFixed(2) + '%"></i>'
        + '<i class="lpath ' + a.role + '" style="left:' + gEndX + '%;right:' + (100 - landX) + '%"></i>'
        + '<i class="ldot tgt" style="left:' + landX + '%;border-color:' + col + '"></i>'
        + '<i class="ldot trav" data-i="' + i + '" style="left:' + pressX + '%;background:' + fill + ';border-color:' + col + '"></i></div>'
        + '<div class="ltime"><span class="ltimecap">' + tk("land_cap") + '</span><span class="ltimev">' + clockAt(a.land) + '</span></div></div>';
    }
    var px = Math.max(4, Math.min(96, a.march / dom * 100));
    return '<div class="lane role-' + a.role + (a.mine ? " me" : "") + '"><span class="lname">' + nm + '</span>'
      + '<div class="ltrack idle"><i class="ldot" style="left:' + px + '%;background:' + fill + ';border-color:' + col + '"></i></div>'
      + '<div class="ltime"><span class="ltimev">' + window.mmss(a.march) + '</span></div></div>';
  }
  function renderLanes(d) {
    var box = $("lanes"); if (!box) return; mapS.lanes = [];
    if (!d.actors.length) { box.innerHTML = ""; return; }
    var dom = mapS.domain, t0 = d.t0 || 0, span = d.span || 1, shown = d.actors.slice(0, 6), extra = d.actors.length - shown.length, h = "";
    shown.forEach(function (a, i) { h += laneRow(a, i, d.live, dom, t0, span); });
    if (extra > 0) h += '<div class="lane"><span class="lname">+' + extra + '</span><div class="ltrack"></div><div class="ltime"></div></div>';
    h += '<div class="lanenote">' + tk(d.live ? "atk_note" : "idle_note") + '</div>';   // the strip is the biggest thing on screen — it gets a legend in BOTH states, not just mid-fight
    // a mid-gather cold-open sees lanes but no verb: non-captains get the one action that matters while joining is still possible
    if (d.live && !d.actors.some(function (a) { return a.mine; })) { mapS.gEndMax = Math.max.apply(null, d.actors.map(function (a) { return a.gatherEnd; })); h += '<div class="lanenote join">' + tk("join_note") + '</div>'; }
    box.innerHTML = h + (d.live ? '<div id="nowHead"></div>' : '');
  }
  function syncMap() {
    var d = mapData();
    var key = d.live ? "live-" + d.id : ("idle-" + d.actors.map(function (a) { return a.pid + a.march; }).join(","));
    if (mapS.mode === key) return;
    mapS.mode = key; mapS.live = d.live; mapS.t0 = d.t0 || 0; mapS.span = d.span || 1; mapS.domain = domainFor(d.actors.map(function (a) { return a.march; }));
    stopRaf(); renderRadar(d); renderLanes(d);
    if (d.live) mapFrame();
  }
  // BOTH views animate off one clock: a single NOW head sweeps the timeline + army dots travel press→land, while radar dots glide inward
  function mapFrame() {
    if (!mapS.live) return;
    var now = window.serverNow() / 1000;
    // radar: dots hold at their ring through the 5:00 gather, then glide toward the castle during the flight
    (mapS.dots || []).forEach(function (o) { var a = o.a, p = (a.press && a.land) ? Math.max(0, Math.min(1, (now - a.press) / Math.max(1, a.land - a.press))) : 0; var r = o.r0 * (0.10 + 0.90 * (1 - p)); o.g.setAttribute("transform", "translate(" + (CX + Math.cos(o.ang) * r).toFixed(1) + "," + (CY + Math.sin(o.ang) * r).toFixed(1) + ")"); });   // same linear clock as the lane dot: press→land, so radius = time left to the castle
    var box = $("lanes"), t = box && box.querySelector(".ltrack");
    var jn = box && box.querySelector(".lanenote.join"); if (jn) jn.style.display = now > mapS.gEndMax ? "none" : "";   // joining closes when the gather ends — don't keep telling people to JOIN a departed rally
    if (t) {
      var nh = $("nowHead"); if (nh) { var np = Math.max(0, Math.min(1, (now - mapS.t0) / mapS.span)); nh.style.left = (t.offsetLeft + np * t.offsetWidth).toFixed(1) + "px"; }
      var tr = box.querySelectorAll(".trav");
      for (var i = 0; i < tr.length; i++) {
        var L = mapS.lanes[+tr[i].getAttribute("data-i")]; if (!L) continue;
        var x;
        if (now < L.gatherEnd) { var gp = Math.max(0, Math.min(1, (now - L.press) / ATK_GATHER)); x = L.pressX + gp * (L.gEndX - L.pressX); }   // crawl through the gather band
        else { var fp = Math.max(0, Math.min(1, (now - L.gatherEnd) / Math.max(1, L.land - L.gatherEnd))); x = L.gEndX + fp * (L.landX - L.gEndX); }
        tr[i].style.left = x.toFixed(2) + "%";
        var ln = tr[i].parentNode && tr[i].parentNode.parentNode; if (ln && now >= L.land) ln.classList.add("fx-land");
      }
    }
    mapS.raf = requestAnimationFrame(mapFrame);
  }

  /* PiP float timer removed: the background audio keep-alive already alerts by default, so the extra (iOS-fragile) button was redundant clutter. */

  /* ---------- defense: per-enemy-whale refill-timing (self-serve calculator, ported from saltyfish defense.html) ----------
     A defender fills their march once (already collected by kvk); the commander publishes incoming enemy whales into
     room.config.enemyWhales (existing setConfig path, broadcast). Each defender then reads WHEN to send reinforcement so
     it lands ~1s after each whale and tops the garrison. Static calculator (no live beep) per product decision. */
  function myMarchSec() { var me = room && room.players && room.players[myPid]; if (me && me.march) return me.march; return marchTouched ? (+$("marchRange").value || 0) : 0; }
  function dCalc(e) {
    var em = (e.mm || 0) * 60 + (e.ss || 0), landAt = DGATHER + em, refillAt = landAt + DDELTA, R = myMarchSec(), sendAt = Math.max(0, refillAt - R);
    var cue, sh, gatherRemain = R - em - DDELTA;
    if (R <= 0) { cue = tk("d_cue_fill"); sh = tk("d_short_fill"); }
    else if (gatherRemain > 0) { cue = tkf("d_cue_gather", { x: window.mmss(gatherRemain) }); sh = tkf("d_short_gather", { x: window.mmss(gatherRemain) }); }
    else { var afterLaunch = em + DDELTA - R; if (afterLaunch <= 0) { cue = tk("d_cue_imm"); sh = tk("d_short_imm"); } else { cue = tkf("d_cue_land", { x: window.mmss(afterLaunch) }); sh = tkf("d_short_land", { x: window.mmss(afterLaunch) }); } }
    return { name: e.name || tk("d_whale"), em: em, landAt: landAt, refillAt: refillAt, sendAt: sendAt, R: R, cue: cue, sh: sh, ready: R > 0 };
  }
  // each whale scaled to ITS OWN clock; gather = DGVIS of its own strip
  function dW1For(c) { return c.refillAt + 3; }   // ruler ends AT 补满✓ (tiny +3s pad keeps the end dot inside the rounded track) — no dead tail
  function dVmap(t, w1) { if (t <= DGATHER) return DGVIS * (t / DGATHER); return DGVIS + (1 - DGVIS) * ((t - DGATHER) / Math.max(1, w1 - DGATHER)); }
  function dInvmap(p, w1) { if (p <= DGVIS) return p / DGVIS * DGATHER; return DGATHER + (p - DGVIS) / (1 - DGVIS) * (w1 - DGATHER); }
  function dPct(t, w1) { return dCl(dVmap(t, w1)) * 100; }
  function dLerp(a, b, p) { return a + (b - a) * p; } function dCl(x) { return x < 0 ? 0 : x > 1 ? 1 : x; } function dSg(t, a, b) { return b <= a ? (t >= b ? 1 : 0) : dCl((t - a) / (b - a)); }

  function renderDStrips() {
    var box = $("dstrips"); if (!box) return; box.innerHTML = "";
    var dh = $("t_dpanelhint"); if (dh) dh.style.display = enemyWhales.length ? "" : "none";   // cold state: don't open with a manual describing UI that isn't on screen — the d_empty line explains everything
    if (!enemyWhales.length) { box.innerHTML = '<p class="hint">' + tk("d_empty") + '</p>'; return; }
    if (dFocus >= enemyWhales.length) dFocus = 0;
    if (enemyWhales.length > 1) { var note = document.createElement("p"); note.className = "hint"; note.style.margin = "0 0 8px"; note.textContent = tk("d_indep_note"); box.appendChild(note); }
    enemyWhales.forEach(function (e, i) {
      var c = dCalc(e), nm = window.esc(e.name || (tk("d_enemy") + String.fromCharCode(65 + i)));
      var w1 = dW1For(c), gx = DGVIS * 100, sx = dPct(c.sendAt, w1), lx = dPct(c.landAt, w1), rx = dPct(c.refillAt, w1);
      var blk = document.createElement("div"); blk.className = "dblk";
      var el = document.createElement("div"); el.className = "dlane" + (i === dFocus ? " focused" : ""); el.setAttribute("data-i", i);
      el.innerHTML =
        '<div class="dnm">' + tkf("d_lane_title", { n: nm, x: window.mmss(c.em) }) + '</div>' +
        '<div class="daxis"></div>' +
        '<div class="drt enemy">' + tk("d_side_enemy") + '</div>' +
        '<div class="dgb" style="width:' + gx.toFixed(1) + '%"></div>' +
        '<div class="def" style="left:' + gx.toFixed(1) + '%;width:' + Math.max(0, lx - gx).toFixed(2) + '%"></div>' +
        '<div class="dgbl" style="left:' + (gx / 2).toFixed(1) + '%">' + tk("d_gather_band") + '</div>' +
        '<div class="ddepv" style="left:' + gx.toFixed(1) + '%"><i></i></div>' +
        '<div class="del dep" style="left:' + gx.toFixed(1) + '%">' + tk("d_depart") + '</div>' +
        '<div class="ded land" style="left:' + lx.toFixed(2) + '%"><i class="d"></i></div>' +
        '<div class="del land" style="left:' + Math.min(93, lx).toFixed(2) + '%">' + tk("d_enemy_land") + '</div>' +
        '<div class="drt our">' + tk("d_side_our") + '</div>' +
        '<div class="dms" style="left:' + sx.toFixed(2) + '%;width:' + Math.max(0, rx - sx).toFixed(2) + '%"></div>' +
        '<div class="dml" style="left:' + Math.min(82, (sx + rx) / 2).toFixed(2) + '%">' + tkf("d_your_march", { x: window.mmss(c.R) }) + '</div>' +
        '<div class="dod send" style="left:' + sx.toFixed(2) + '%"><i class="d"></i></div>' +
        '<div class="dod refill" style="left:' + rx.toFixed(2) + '%"><i class="d"></i></div>' +
        '<div class="dol send" style="left:' + Math.min(72, sx).toFixed(2) + '%"><b>' + tk("d_you_send") + '</b><span>' + window.esc(c.sh) + '</span></div>' +
        '<div class="dol refill" style="left:' + Math.min(94, rx).toFixed(2) + '%">' + tk("d_refilled") + '</div>' +
        '<div class="dfp" style="left:' + sx.toFixed(2) + '%">' + tk("d_send_now") + '</div>' +
        (i === dFocus ? '<div class="dhd" style="left:' + sx.toFixed(2) + '%"></div>' : '');
      el.addEventListener("click", function () { if (dFocus !== i) { dFocus = i; dRefocus(); } });
      blk.appendChild(el);
      var cue = document.createElement("div"); cue.className = "erow";
      cue.innerHTML = '<div class="et"><b>' + nm + '</b> · ' + tkf("d_erow", { x: window.mmss(c.R) }) + '</div>' +
        '<div class="cue">' + (c.ready ? window.esc(c.cue) : '<span style="color:var(--brown3)">' + window.esc(c.cue) + '</span>') + '</div>' +
        (c.ready ? '<div class="note">' + tk("d_note") + '</div>' : '');
      blk.appendChild(cue);
      box.appendChild(blk);
    });
  }
  function renderWhaleChips() {
    var box = $("whaleChips"); if (!box) return;
    if (enemyWhales.length <= 1) { box.innerHTML = ""; box.style.display = "none"; return; }
    box.style.display = "flex";
    box.innerHTML = enemyWhales.map(function (e, i) { var nm = window.esc(e.name || (tk("d_enemy") + String.fromCharCode(65 + i))); return '<button class="wchip' + (i === dFocus ? " on" : "") + '" data-i="' + i + '">🔴 ' + nm + '</button>'; }).join("");
    box.querySelectorAll("button").forEach(function (b) { b.onclick = function () { var i = +b.getAttribute("data-i"); if (i !== dFocus) { dFocus = i; dRefocus(); } }; });
  }

  /* defense radar — pond animation on the focused whale's own clock (ported) */
  var dsvgEl, dcx = 180, dcy = 98, dbx = 180, dby = 182;
  var DCOL = { mint: "#19c8b9", mintDeep: "#0fa193", green: "#6fba2c", coral: "#e05a5a", brown: "#794f27", brown2: "#9f927d", yellow: "#f5c31c" };
  function dBuildBase() { dsvgEl = $("dsvg"); if (!dsvgEl) return; dsvgEl.innerHTML = "";
    dsvgEl.appendChild(E("circle", { cx: dcx, cy: dcy, r: 78, fill: "none", stroke: "#a7e6dd", "stroke-width": 2, opacity: .7 }));
    dsvgEl.appendChild(E("circle", { cx: dcx, cy: dcy, r: 50, fill: "none", stroke: "#a7e6dd", "stroke-width": 2, opacity: .5 }));
  }
  function dFocusEnemy() { var arr = enemyWhales.length ? enemyWhales : [{ name: tk("d_enemy") + "A", mm: 1, ss: 10 }]; if (dFocus >= arr.length) dFocus = 0; if (dFocus < 0) dFocus = 0; return arr[dFocus]; }
  function dRebuild() { dBuildBase(); if (!dsvgEl) return; dAnim = {};
    dAnim.castle = E("rect", { x: dcx - 20, y: dcy - 17, width: 40, height: 34, rx: 9, fill: "#fce3b8", stroke: DCOL.brown, "stroke-width": 3 }); dsvgEl.appendChild(dAnim.castle);
    dsvgEl.appendChild(E("rect", { x: dcx - 20, y: dcy - 24, width: 8, height: 9, rx: 2, fill: DCOL.brown })); dsvgEl.appendChild(E("rect", { x: dcx - 4, y: dcy - 24, width: 8, height: 9, rx: 2, fill: DCOL.brown })); dsvgEl.appendChild(E("rect", { x: dcx + 12, y: dcy - 24, width: 8, height: 9, rx: 2, fill: DCOL.brown }));
    dsvgEl.appendChild(E("rect", { x: dcx - 30, y: dcy + 24, width: 60, height: 9, rx: 4.5, fill: "#eadfca", stroke: "#d8cfb9", "stroke-width": 1 }));
    dAnim.bar = E("rect", { x: dcx - 29, y: dcy + 25, width: 58, height: 7, rx: 3.5, fill: DCOL.green }); dsvgEl.appendChild(dAnim.bar);
    dAnim.fx = E("circle", { cx: dcx, cy: dcy, r: 20, fill: "none", stroke: DCOL.coral, "stroke-width": 3.5, opacity: 0 }); dsvgEl.appendChild(dAnim.fx);
    dAnim.fxt = E("text", { x: dcx, y: dcy, "text-anchor": "middle", "font-size": 13, "font-weight": 900, opacity: 0 }); dsvgEl.appendChild(dAnim.fxt);
    dsvgEl.appendChild(E("rect", { x: dbx - 10, y: dby - 10, width: 20, height: 20, rx: 6, fill: "#dff7f2", stroke: DCOL.mintDeep, "stroke-width": 2.5 }));
    var sh = E("text", { x: dbx, y: dby + 4, "text-anchor": "middle", "font-size": 11 }); sh.textContent = "🛡️"; dsvgEl.appendChild(sh);
    // nothing published → idle pond only (castle + rings + your base), no fabricated demo whale pretending to be live intel
    var dc = document.querySelector("#defenseView .ctrl");
    if (!enemyWhales.length) { dAnim.foc = null; dAnim.keys = []; dAnim.w1 = 0; if (dc) dc.style.display = "none"; var pl0 = $("dphaselab"); if (pl0) pl0.textContent = ""; return; }
    if (dc) dc.style.display = "";
    var c = dCalc(dFocusEnemy()); dAnim.c = c; dAnim.w1 = dW1For(c);
    var spawnX = dcx, spawnY = dcy - 68, o = { c: c, sx: spawnX, sy: spawnY };   // y=30: on the outer ring, fully on-canvas (the old off-screen spawn hid the gather phase AND the depart FX)
    o.aura = E("circle", { cx: spawnX, cy: spawnY, r: 14, fill: "none", stroke: DCOL.yellow, "stroke-width": 2.5, opacity: 0, "stroke-dasharray": "3 5" }); dsvgEl.appendChild(o.aura);
    o.dot = E("circle", { cx: spawnX, cy: spawnY, r: 12, fill: DCOL.coral, opacity: 0, stroke: "#fff", "stroke-width": 2 }); dsvgEl.appendChild(o.dot);
    o.eye = E("circle", { cx: spawnX, cy: spawnY, r: 2, fill: "#fff", opacity: 0 }); dsvgEl.appendChild(o.eye);
    o.cd = E("text", { x: spawnX, y: spawnY - 15, "text-anchor": "middle", fill: DCOL.coral, "font-size": 10, "font-weight": 800, opacity: 0 }); dsvgEl.appendChild(o.cd);
    o.bub = [0, 1, 2].map(function () { var d = E("circle", { cx: dbx, cy: dby, r: 4, fill: DCOL.mint, opacity: 0, stroke: "#fff", "stroke-width": 1.5 }); dsvgEl.appendChild(d); return d; });
    dAnim.foc = o;
    var keys = [{ t: DGATHER, type: "depart" }, { t: c.sendAt, type: "send" }, { t: c.landAt, type: "land" }, { t: c.refillAt, type: "refill" }];   // depart = 他发车 — same emphasis as 敌落地
    keys.sort(function (a, b) { return a.t - b.t; }); dAnim.keys = keys; dAnim.p = 0; dAnim.ki = 0; dAnim.holdUntil = 0;
  }
  function dRenderAnim(t, curKey, ts) { if (!dAnim || !dAnim.foc) return; ts = ts || 0;
    var c = dAnim.c, o = dAnim.foc, sv = (t >= c.landAt && t < c.refillAt) ? 0.4 : 1;
    dAnim.bar.setAttribute("width", (58 * sv).toFixed(1)); dAnim.bar.setAttribute("fill", sv < 0.7 ? DCOL.coral : DCOL.green); dAnim.castle.setAttribute("stroke", sv < 0.7 ? DCOL.coral : DCOL.brown);
    var x = o.sx, y = o.sy;
    if (t < DGATHER) { o.dot.setAttribute("opacity", .9); var pu = 0.5 + 0.5 * Math.sin(t * 0.5); o.aura.setAttribute("opacity", .4 + .4 * pu); o.aura.setAttribute("r", (15 + 5 * pu).toFixed(1)); o.aura.setAttribute("cx", x); o.aura.setAttribute("cy", y);
      o.cd.setAttribute("opacity", 1); o.cd.setAttribute("x", x); o.cd.setAttribute("y", y - 17); o.cd.setAttribute("fill", DCOL.brown2); o.cd.textContent = tkf("d_gather_cd", { x: window.mmss(DGATHER - t) }); }
    else if (t < c.landAt) { o.aura.setAttribute("opacity", 0); var ap = dSg(t, DGATHER, c.landAt); x = dLerp(o.sx, dcx, ap); y = dLerp(o.sy, dcy, ap);
      o.dot.setAttribute("opacity", 1); o.cd.setAttribute("opacity", 1); o.cd.setAttribute("x", x); o.cd.setAttribute("y", y - 15); o.cd.setAttribute("fill", DCOL.coral); o.cd.textContent = tkf("d_land_cd", { x: window.mmss(c.landAt - t) }); }
    else { o.dot.setAttribute("opacity", 0); o.cd.setAttribute("opacity", 0); o.aura.setAttribute("opacity", 0); }
    o.dot.setAttribute("cx", x); o.dot.setAttribute("cy", y);
    o.eye.setAttribute("opacity", t < c.landAt ? 0.9 : 0); o.eye.setAttribute("cx", x + 3); o.eye.setAttribute("cy", y - 2);
    var rp = dSg(t, c.sendAt, c.refillAt), on = t >= c.sendAt && t < c.refillAt;
    o.bub.forEach(function (d, k) { if (on) { var ox = (k - 1) * 7; d.setAttribute("opacity", .95); d.setAttribute("cx", dLerp(dbx + ox, dcx + ox, rp)); d.setAttribute("cy", dLerp(dby, dcy, rp)); } else d.setAttribute("opacity", 0); });
    if (curKey) { var pu2 = 0.5 + 0.5 * Math.sin(ts * 0.012); var col = curKey.type === "send" ? DCOL.green : (curKey.type === "land" || curKey.type === "depart" ? DCOL.coral : DCOL.mint);
      var fxX = curKey.type === "send" ? dbx : (curKey.type === "depart" ? o.sx : dcx), fxY = curKey.type === "send" ? dby : (curKey.type === "depart" ? o.sy : dcy);
      dAnim.fx.setAttribute("opacity", .9); dAnim.fx.setAttribute("stroke", col); dAnim.fx.setAttribute("cx", fxX); dAnim.fx.setAttribute("cy", fxY); dAnim.fx.setAttribute("r", (16 + 14 * pu2).toFixed(1));
      var fty = fxY - 26 < 14 ? fxY + 40 : fxY - 26;   // too close to the top edge → label flips below the pulse ring
      dAnim.fxt.setAttribute("opacity", 1); dAnim.fxt.setAttribute("fill", col); dAnim.fxt.setAttribute("x", fxX); dAnim.fxt.setAttribute("y", fty); dAnim.fxt.textContent = curKey.type === "send" ? tk("d_fx_send") : (curKey.type === "depart" ? tk("d_fx_depart") : (curKey.type === "land" ? tk("d_fx_land") : tk("d_fx_refill")));
    } else { dAnim.fx.setAttribute("opacity", 0); dAnim.fxt.setAttribute("opacity", 0); }
    var pl = $("dphaselab"); if (pl) pl.textContent = curKey && curKey.type === "depart" ? tk("d_ph_depart") : t < DGATHER ? tk("d_ph_gather") : (curKey && curKey.type === "send" ? tk("d_ph_send") : (curKey && curKey.type === "land" ? tk("d_ph_land") : (curKey && curKey.type === "refill" ? tk("d_ph_refill") : (sv < 0.7 ? tk("d_ph_low") : tk("d_ph_inc")))));
    var L = document.querySelector("#dstrips .dlane.focused"); if (L) { var h = L.querySelector(".dhd"); if (h) h.style.left = dPct(t, dAnim.w1).toFixed(2) + "%"; L.classList.remove("fx-depart", "fx-send", "fx-land", "fx-refill", "now"); if (curKey) L.classList.add("fx-" + curKey.type, "now"); }
  }
  var DSWEEP = 4.5, DHOLD = { depart: 800, send: 1400, land: 800, refill: 900 };
  function dFrame(ts) { if (viewMode !== "defense") { dRaf = null; return; } if (dLastTs == null) dLastTs = ts; var dt = (ts - dLastTs) / 1000; dLastTs = ts; if (!dAnim || !dAnim.w1) { dRaf = requestAnimationFrame(dFrame); return; }
    if (dPlaying) {
      if (dAnim.holdUntil) { if (ts >= dAnim.holdUntil) { dAnim.holdUntil = 0; dAnim.ki++; } }
      if (!dAnim.holdUntil) {
        dAnim.p += dt / DSWEEP;
        if (dAnim.ki < dAnim.keys.length) { var kp = dVmap(dAnim.keys[dAnim.ki].t, dAnim.w1); if (dAnim.p >= kp) { dAnim.p = kp; dAnim.holdUntil = ts + (DHOLD[dAnim.keys[dAnim.ki].type] || 700); } }
        if (dAnim.p >= 1) { dAnim.p = 0; dAnim.ki = 0; dAnim.holdUntil = 0; }
      }
      dTNow = dInvmap(dAnim.p, dAnim.w1); var sc = $("dscrub"); if (sc) sc.value = Math.round(dAnim.p * 1000);
    }
    var curKey = dAnim.holdUntil && dAnim.ki < dAnim.keys.length ? dAnim.keys[dAnim.ki] : null;
    dRenderAnim(dTNow, curKey, ts); dRaf = requestAnimationFrame(dFrame);
  }
  function dRefocus() { dRebuild(); renderDStrips(); renderWhaleChips(); dLastTs = null; dPlaying = true; var pp = $("dpp"); if (pp) pp.textContent = "⏸"; }
  function renderDefense() { dRebuild(); renderDStrips(); renderWhaleChips(); }

  /* attack/defense view switch */
  function setBadge() { var b = $("defBadge"); if (!b) return; var n = enemyWhales.length; if (n > 0) { b.textContent = n; b.classList.remove("hide"); } else b.classList.add("hide"); }
  function setView(m) {
    viewMode = m;
    if ($("tabAtk")) $("tabAtk").classList.toggle("on", m === "attack");
    if ($("tabDef")) $("tabDef").classList.toggle("on", m === "defense");
    if ($("attackView")) $("attackView").classList.toggle("hide", m !== "attack");
    if ($("defenseView")) $("defenseView").classList.toggle("hide", m !== "defense");
    if (m === "defense") { renderDefense(); dLastTs = null; if (!dRaf) dRaf = requestAnimationFrame(dFrame); }
    else if (dRaf) { cancelAnimationFrame(dRaf); dRaf = null; }
    paintHero();
  }

  /* commander: edit + publish enemy whales into room.config.enemyWhales (existing setConfig path) */
  function dEnemyRow(e, onDel, onChg) {
    var el = document.createElement("div"); el.className = "foe";
    el.innerHTML = '<div class="r1"><input class="nm" placeholder="' + window.esc(tk("whale_ph")) + '" value="' + window.esc(e.name || "") + '" data-k="name" maxlength="16">' +
      '<span class="mmss"><input type="number" min="0" max="600" value="' + (e.mm || 0) + '" data-k="mm" style="width:46px;text-align:center;font-family:var(--mono)"><span class="u">' + (L() ? "m" : "分") + '</span><span class="c">:</span>' +
      '<input type="number" min="0" max="59" value="' + (e.ss || 0) + '" data-k="ss" style="width:46px;text-align:center;font-family:var(--mono)"><span class="u">' + (L() ? "s" : "秒") + '</span></span>' +
      '<button class="del">×</button></div>';
    el.addEventListener("input", function (ev) { var k = ev.target.getAttribute("data-k"); if (!k) return; var v = ev.target.value; if (k === "mm") v = Math.max(0, +v || 0); if (k === "ss") v = Math.min(59, Math.max(0, +v || 0)); e[k] = (k === "name") ? v : (+v || 0); onChg && onChg(); });
    el.querySelector(".del").addEventListener("click", function () { onDel && onDel(); }); return el;
  }
  function renderAdmin() { var box = $("enemyList"); if (!box) return; box.innerHTML = ""; adminEnemies.forEach(function (e, i) { box.appendChild(dEnemyRow(e, function () { adminDirty = true; adminEnemies.splice(i, 1); renderAdmin(); }, function () { adminDirty = true; })); }); }
  function sendWhales(whales, baseAt) { pendingPubTok = "pub" + Date.now(); return sock.send({ t: "setConfig", password: roomPw, config: Object.assign({}, (room && room.config) || {}, { enemyWhales: whales }), baseUpdatedAt: baseAt, by: pendingPubTok }); }
  function publishWhales() {
    var b = $("pubWhales"); if (!b) return;
    var whales = adminEnemies.map(function (e) { return { name: (e.name || "").slice(0, 24), mm: Math.max(0, Math.min(600, +e.mm || 0)), ss: Math.max(0, Math.min(59, +e.ss || 0)) }; });
    var msg = $("pubMsg"); b.disabled = true; var old = b.textContent.trim(); b.textContent = tk("publishing"); pendingPubWhales = whales;
    var ok = sendWhales(whales, room ? room.updatedAt : undefined);
    if (ok) adminDirty = false;   // the published version IS the editor's version again
    setTimeout(function () { b.disabled = false; b.textContent = old; }, 1200);
    if (!ok && msg) { msg.innerHTML = '<span style="color:var(--coral)">' + tk("pub_neterr") + '</span>'; pendingPubWhales = null; pendingPubTok = null; }
  }

  /* ---------- commander ---------- */
  function renderKingdomPick() { var b = $("kingdomPick"); if (!b) return; b.innerHTML = [1, 2].map(function (n) { return '<button class="chipbtn ' + (fireKingdom === n ? "kon" : "") + '" data-k="' + n + '">🌍 ' + tk("kw" + n) + '</button>'; }).join(""); b.querySelectorAll("button").forEach(function (x) { x.onclick = function () { fireKingdom = +x.getAttribute("data-k"); closeReplacement(false); renderKingdomPick(); if (room) renderRoster(); setCancelLabel(); }; }); }
  function renderLead() { var b = $("lead"); if (!b) return; b.innerHTML = [10, 15, 30, 60].map(function (v) { return '<button class="chipbtn ' + (v === lead ? "on" : "") + '" data-v="' + v + '">' + (L() ? "in " + v + "s" : v + "秒后") + '</button>'; }).join(""); b.querySelectorAll("button").forEach(function (x) { x.onclick = function () { lead = +x.getAttribute("data-v"); renderLead(); }; }); }

  function canonicalPick(pid, role, players) {
    var player = players && players[pid];
    if (!player) return null;
    return { pid: pid, role: role === "main" ? "main" : "weak", name: player.name || pid, march: player.march, marchRevision: Number.isInteger(player.marchRevision) ? player.marchRevision : 0 };
  }
  function reconcilePickList(list, players) {
    var seenPid = Object.create(null), seenRole = Object.create(null), next = [];
    (Array.isArray(list) ? list : []).some(function (pick) {
      if (next.length >= 2) return true;
      var pid = pick && String(pick.pid || ""), role = pick && pick.role;
      if (!players || !Object.prototype.hasOwnProperty.call(players, pid) || (role !== "weak" && role !== "main") || seenPid[pid] || seenRole[role]) return false;
      seenPid[pid] = true; seenRole[role] = true; next.push({ pid: pid, role: role }); return false;
    });
    return next;
  }
  function reconcilePicks(players) { [1, 2].forEach(function (kingdom) { pickedByK[kingdom] = reconcilePickList(pickedByK[kingdom], players); }); }
  function clonePicks(list) { return (list || []).map(function (pick) { return { pid: pick.pid, role: pick.role }; }); }
  function pickSignature(list) { return clonePicks(list).sort(function (a, b) { return a.role.localeCompare(b.role); }).map(function (pick) { return pick.role + ":" + pick.pid; }).join("|"); }
  function otherKingdomForPid(pid, kingdom) {
    var other = kingdom === 1 ? 2 : 1;
    return pickedByK[other].concat(serverStagedByK[other] || []).some(function (pick) { return pick.pid === pid; }) ? other : 0;
  }
  function duplicateNameCounts(players) {
    var counts = Object.create(null);
    Object.keys(players || {}).forEach(function (pid) { var name = (players[pid] && players[pid].name) || pid; counts[name] = (counts[name] || 0) + 1; });
    return counts;
  }
  function playerDisplayParts(pid, players, counts) {
    var player = players && players[pid], name = (player && player.name) || pid;
    var duplicate = (counts || duplicateNameCounts(players))[name] > 1;
    return { name: name, suffix: duplicate ? "#" + String(pid).slice(-4) : "" };
  }
  function playerDisplayText(pid, players) { var part = playerDisplayParts(pid, players); return part.name + (part.suffix ? " " + part.suffix : ""); }
  function restoreRosterFocus(pid) {
    setTimeout(function () {
      var target = pid && document.querySelector('#roster .rp[data-pid="' + window.esc(pid) + '"]');
      if (!target && $("rosterSearchWrap") && !$("rosterSearchWrap").classList.contains("hide")) target = $("rosterSearch");
      if (!target) target = $("t_cmd");
      if (target) { if (!target.hasAttribute("tabindex") && target.id === "t_cmd") target.setAttribute("tabindex", "-1"); target.focus(); }
    }, 0);
  }
  function closeReplacement(restoreFocus) {
    var origin = pendingReplacementOrigin || pendingReplacementPid;
    pendingReplacementPid = ""; pendingReplacementOrigin = null; pendingReplacementIncumbents = null;
    if ($("replaceOvl")) $("replaceOvl").classList.remove("show");
    var page = document.querySelector(".wrap"); if (page) { page.inert = false; page.removeAttribute("inert"); }
    if (restoreFocus) { if (pendingStageMutation || queuedStageByK[1] || queuedStageByK[2]) stageFocusByK[fireKingdom] = origin; restoreRosterFocus(origin); }
  }
  function openReplacement(pid) {
    if (!room || !room.players || !room.players[pid]) return;
    pendingReplacementPid = pid; pendingReplacementOrigin = pid;
    var weak = pickedByK[fireKingdom].filter(function (pick) { return pick.role === "weak"; })[0];
    var main = pickedByK[fireKingdom].filter(function (pick) { return pick.role === "main"; })[0];
    pendingReplacementIncumbents = { weak: weak && weak.pid, main: main && main.pid, signature: pickSignature(pickedByK[fireKingdom]) };
    $("replaceTitle").textContent = tk("replace_choose");
    $("replaceWeak").hidden = !weak; $("replaceMain").hidden = !main;
    if (weak) $("replaceWeak").textContent = tkf("replace_weak", { n: playerDisplayText(weak.pid, room.players) });
    if (main) $("replaceMain").textContent = tkf("replace_main", { n: playerDisplayText(main.pid, room.players) });
    $("replaceCancel").textContent = tk("replace_cancel");
    $("replaceOvl").classList.add("show");
    var page = document.querySelector(".wrap"); if (page) page.inert = true;
    setTimeout(function () { var first = !$("replaceWeak").hidden ? $("replaceWeak") : $("replaceMain"); if (first) first.focus(); }, 0);
  }
  function rollbackStageSelection(message, discardQueued) {
    if (!pendingStageMutation) return false;
    var rollback = pendingStageMutation, focusPid = stageFocusByK[rollback.kingdom]; pendingStageMutation = null;
    if (discardQueued) { queuedStageByK[1] = null; queuedStageByK[2] = null; }
    [1, 2].forEach(function (kingdom) {
      pickedByK[kingdom] = queuedStageByK[kingdom]
        ? reconcilePickList(queuedStageByK[kingdom], room && room.players)
        : clonePicks(serverStagedByK[kingdom]);
    });
    closeReplacement(false); if (room) renderRoster();
    if (focusPid && !queuedStageByK[rollback.kingdom]) { stageFocusByK[rollback.kingdom] = ""; restoreRosterFocus(focusPid); }
    if (message) window.toast(message);
    if (!discardQueued) pumpStageQueue();
    return true;
  }
  function commitPicks(next) {
    var previous = clonePicks(pickedByK[fireKingdom]);
    var active = document.activeElement, focusPid = active && active.dataset && active.dataset.pid;
    if (focusPid) stageFocusByK[fireKingdom] = focusPid;
    pickedByK[fireKingdom] = reconcilePickList(next, room && room.players);
    if (pendingReplacementPid && pendingReplacementIncumbents && pickSignature(pickedByK[fireKingdom]) !== pendingReplacementIncumbents.signature) closeReplacement(true);
    picksTouched = true; renderRoster(); stageBroadcast(previous);
  }
  function applyReplacement(pid, role) {
    var candidate = pid || pendingReplacementPid, other = otherKingdomForPid(candidate, fireKingdom), current = pickedByK[fireKingdom];
    var currentRole = current.filter(function (pick) { return pick.role === role; })[0], expectedPid = pendingReplacementIncumbents && pendingReplacementIncumbents[role];
    if (!candidate || !room || !room.players[candidate] || other || !currentRole || !expectedPid || currentRole.pid !== expectedPid) { closeReplacement(true); return; }
    var next = current.filter(function (pick) { return pick.role !== role && pick.pid !== candidate; }).concat([{ pid: candidate, role: role }]);
    stageFocusByK[fireKingdom] = candidate; closeReplacement(false); commitPicks(next);
  }
  function selectOrReplacePlayer(pid) {
    var other = otherKingdomForPid(pid, fireKingdom), current = pickedByK[fireKingdom], existing = current.filter(function (pick) { return pick.pid === pid; })[0];
    if (other) { window.toast(tkf("already_kingdom", { k: other })); return; }
    if (existing) { commitPicks(current.filter(function (pick) { return pick.pid !== pid; })); return; }
    if (current.length >= 2) { openReplacement(pid); return; }
    var role = current.some(function (pick) { return pick.role === "weak"; }) ? "main" : "weak";
    commitPicks(current.concat([{ pid: pid, role: role }]));
  }
  function parseMMSS(value) {
    var match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
    if (!match) return null;
    var secondsPart = Number(match[2]);
    if (secondsPart >= 60) return null;
    var seconds = Number(match[1]) * 60 + secondsPart;
    return Number.isInteger(seconds) && seconds >= 5 && seconds <= 180 ? seconds : null;
  }
  function canonicalMarchRecord(pid, players) {
    var player = players && players[pid];
    if (!player || !Number.isInteger(player.march)) return null;
    return { pid: pid, march: player.march, revision: Number.isInteger(player.marchRevision) ? player.marchRevision : 0 };
  }
  function rememberCommanderMarchLatest(record) {
    if (!record || record.pid !== editingPlayerPid) return;
    if (!commanderMarchLatest || record.revision > commanderMarchLatest.revision ||
        (record.revision === commanderMarchLatest.revision && record.march === commanderMarchLatest.march)) {
      commanderMarchLatest = { pid: record.pid, march: record.march, revision: record.revision };
    }
  }
  function restoreCommanderMarchFocus() {
    setTimeout(function () {
      var target = commanderMarchOriginPid && document.querySelector('.roster-time[data-pid="' + commanderMarchOriginPid + '"]');
      var visible = function (element) { return !!(element && element.isConnected && !element.hidden && !element.closest("[hidden], .hide") && element.getClientRects().length); };
      if (!visible(target)) { var search = $("rosterSearch"); if (visible(search)) target = search; }
      if (!visible(target)) target = Array.from(document.querySelectorAll("#roster .rp")).filter(visible)[0] || $("console");
      if (target && target.focus) target.focus();
      commanderMarchOriginPid = "";
    }, 0);
  }
  function closeCommanderMarchEditor(restoreFocus) {
    if (pendingCommanderMarchMutation) return false;
    var editor = $("commanderMarchEditor");
    editingPlayerPid = ""; commanderMarchDraft = ""; commanderMarchDirty = false; commanderMarchLatest = null;
    commanderMarchStatus = ""; commanderMarchStatusTone = ""; commanderMarchStale = false; commanderMarchRefreshAfterSnapshot = -1;
    if (editor) { editor.classList.add("hide"); editor.removeAttribute("aria-busy"); }
    if (room) renderRoster();
    if (restoreFocus) restoreCommanderMarchFocus(); else commanderMarchOriginPid = "";
    return true;
  }
  function renderCommanderMarchEditor() {
    var editor = $("commanderMarchEditor"); if (!editor) return;
    var player = editingPlayerPid && room && room.players && room.players[editingPlayerPid];
    if (!editingPlayerPid || (!player && !commanderMarchStale)) { editor.classList.add("hide"); return; }
    editor.classList.remove("hide");
    var pending = !!pendingCommanderMarchMutation, latest = commanderMarchLatest || canonicalMarchRecord(editingPlayerPid, room && room.players);
    var parts = player ? playerDisplayParts(editingPlayerPid, room.players) : { name: editingPlayerPid, suffix: "" };
    $("commanderMarchTitle").textContent = tkf("edit_march", { n: parts.name + (parts.suffix ? " " + parts.suffix : "") });
    $("commanderMarchCanonical").textContent = latest ? "r" + latest.revision : "";
    $("commanderMarchLabel").textContent = tk("marchlab") + " · MM:SS";
    var input = $("commanderMarchInput");
    if (document.activeElement !== input || input.value !== commanderMarchDraft) input.value = commanderMarchDraft;
    input.setAttribute("aria-invalid", commanderMarchStatus === "invalid" ? "true" : "false");
    input.readOnly = pending || commanderMarchStale;
    input.setAttribute("aria-disabled", pending || commanderMarchStale ? "true" : "false");
    $("commanderMarchLatest").textContent = latest ? tkf("march_latest", { x: window.mmss(latest.march) }) : "";
    $("commanderMarchActiveHint").textContent = tk("march_active_unchanged");
    var status = $("commanderMarchStatus");
    var statusKey = commanderMarchStatus === "invalid" ? "march_invalid" : commanderMarchStatus === "conflict" ? "march_conflict" : commanderMarchStatus === "pending" ? "march_pending" : commanderMarchStatus === "unsaved" ? "march_unsaved" : commanderMarchStatus === "stale" ? "march_stale" : commanderMarchStatus === "saved" ? "march_saved" : "";
    status.textContent = statusKey ? tk(statusKey) : "";
    status.className = "commander-march-status" + (commanderMarchStatusTone ? " " + commanderMarchStatusTone : "");
    var conflict = $("commanderMarchConflict"), hasConflict = commanderMarchStatus === "conflict" && !!latest && !pending;
    conflict.classList.toggle("hide", !hasConflict);
    $("commanderMarchAdopt").textContent = tk("march_adopt"); $("commanderMarchRetry").textContent = tk("march_retry");
    $("commanderMarchCancel").textContent = tk("march_cancel"); $("commanderMarchSave").textContent = tk("march_save");
    var steps = editor.querySelector(".commander-march-steps");
    if (steps) {
      steps.setAttribute("aria-label", tk("march_adjust"));
      steps.querySelectorAll("[data-march-delta]").forEach(function (button) {
        var delta = Number(button.dataset.marchDelta || 0);
        button.setAttribute("aria-label", tkf(delta < 0 ? "march_decrease" : "march_increase", { n: Math.abs(delta) }));
      });
    }
    editor.setAttribute("aria-busy", pending ? "true" : "false");
    editor.querySelectorAll("button, input").forEach(function (control) {
      var conflictAction = control.id === "commanderMarchAdopt" || control.id === "commanderMarchRetry";
      var unavailable = conflictAction ? pending || !hasConflict : pending || commanderMarchStale;
      control.setAttribute("aria-disabled", unavailable ? "true" : "false");
      if (control.tagName === "INPUT") control.readOnly = unavailable;
      else control.disabled = conflictAction && !hasConflict;
    });
  }
  function openCommanderMarchEditor(pid, origin) {
    if (!roomPw) { window.toast(tk("march_locked")); return false; }
    var canonical = canonicalMarchRecord(pid, room && room.players); if (!canonical) return false;
    if (editingPlayerPid === pid) {
      renderCommanderMarchEditor(); var current = $("commanderMarchInput"); if (current) current.focus(); return true;
    }
    if (editingPlayerPid && (commanderMarchDirty || pendingCommanderMarchMutation)) {
      renderCommanderMarchEditor(); var existing = $("commanderMarchInput"); if (existing) existing.focus(); return false;
    }
    if (editingPlayerPid && editingPlayerPid !== pid) closeCommanderMarchEditor(false);
    editingPlayerPid = pid; commanderMarchOriginPid = origin && origin.dataset ? origin.dataset.pid : pid;
    commanderMarchDraft = window.mmss(Math.max(5, Math.min(180, canonical.march))); commanderMarchDirty = false; commanderMarchLatest = canonical;
    commanderMarchStatus = ""; commanderMarchStatusTone = ""; commanderMarchStale = false; commanderMarchRefreshAfterSnapshot = -1;
    renderRoster(); renderCommanderMarchEditor();
    var input = $("commanderMarchInput"); if (input) { input.focus(); input.select(); }
    return true;
  }
  function sendCommanderMarch(baseRevision) {
    if (!editingPlayerPid || pendingCommanderMarchMutation || commanderMarchStale) return false;
    var march = parseMMSS(commanderMarchDraft);
    if (march == null) { commanderMarchStatus = "invalid"; commanderMarchStatusTone = "err"; renderCommanderMarchEditor(); $("commanderMarchInput").focus(); return false; }
    var mutation = { mutationId: crypto.randomUUID(), pid: editingPlayerPid, requestedMarch: march, baseRevision: baseRevision, ackSeen: false, stateSeen: false, awaitingReconnect: false, reconnectAfterSnapshot: -1 };
    var sent = !!(sock && sock.send({ t: "setPlayerMarch", mutationId: mutation.mutationId, password: roomPw, pid: mutation.pid, march: mutation.requestedMarch, baseRevision: mutation.baseRevision }));
    if (!sent) { commanderMarchStatus = "unsaved"; commanderMarchStatusTone = "err"; commanderMarchDirty = true; renderCommanderMarchEditor(); return false; }
    pendingCommanderMarchMutation = mutation; commanderMarchStatus = "pending"; commanderMarchStatusTone = ""; commanderMarchDirty = true; renderCommanderMarchEditor();
    return true;
  }
  function saveCommanderMarch() {
    var latest = commanderMarchLatest || canonicalMarchRecord(editingPlayerPid, room && room.players);
    if (!latest) { commanderMarchStatus = "stale"; commanderMarchStatusTone = "err"; renderCommanderMarchEditor(); return false; }
    return sendCommanderMarch(latest.revision);
  }
  function settleCommanderMarchMutation() {
    var pending = pendingCommanderMarchMutation;
    if (!pending || !pending.ackSeen || !pending.stateSeen) return false;
    var current = canonicalMarchRecord(pending.pid, room && room.players);
    if (!current || current.revision !== pending.baseRevision + 1 || current.march !== pending.requestedMarch) return false;
    pendingCommanderMarchMutation = null; commanderMarchDirty = false; commanderMarchStatus = "saved"; commanderMarchStatusTone = "ok";
    window.toast(tk("march_saved") + " · " + window.mmss(pending.requestedMarch));
    closeCommanderMarchEditor(true);
    return true;
  }
  function markCommanderMarchConflict(record) {
    rememberCommanderMarchLatest(record);
    pendingCommanderMarchMutation = null; commanderMarchDirty = true; commanderMarchStatus = "conflict"; commanderMarchStatusTone = "err";
    renderCommanderMarchEditor();
  }
  function reconcileCommanderMarchState(players) {
    if (!editingPlayerPid) return;
    var record = canonicalMarchRecord(editingPlayerPid, players);
    if (!record || (commanderMarchStale && roomSnapshotSequence > commanderMarchRefreshAfterSnapshot)) {
      pendingCommanderMarchMutation = null; window.toast(tk("player_missing")); closeCommanderMarchEditor(true); return;
    }
    var prior = commanderMarchLatest;
    rememberCommanderMarchLatest(record);
    var pending = pendingCommanderMarchMutation;
    if (pending) {
      pending.stateSeen = record.revision === pending.baseRevision + 1 && record.march === pending.requestedMarch;
      if (!pending.stateSeen && (record.revision > pending.baseRevision + 1 || (record.revision === pending.baseRevision + 1 && record.march !== pending.requestedMarch))) markCommanderMarchConflict(record);
      else if (!pending.stateSeen && pending.awaitingReconnect && roomSnapshotSequence > pending.reconnectAfterSnapshot) markCommanderMarchConflict(record);
      settleCommanderMarchMutation();
    } else if (commanderMarchDirty && prior && (record.revision > prior.revision || (record.revision === prior.revision && record.march !== prior.march))) {
      markCommanderMarchConflict(record);
    } else if (!commanderMarchDirty) commanderMarchDraft = window.mmss(Math.max(5, Math.min(180, record.march)));
  }
  function removalSnapshot(pid, sourceRoom) {
    var currentRoom = sourceRoom || room, players = (currentRoom && currentRoom.players) || {};
    var exists = !!(pid && Object.prototype.hasOwnProperty.call(players, pid));
    var name = exists ? playerDisplayText(pid, players) : pid, impacts = [];
    [1, 2].forEach(function (kingdom) {
      var staged = currentRoom && currentRoom.live && currentRoom.live.staged && currentRoom.live.staged[kingdom];
      var pairs = staged && Array.isArray(staged.pairs) ? staged.pairs : [];
      pairs.forEach(function (pair) {
        if (String(pair && pair.pid || "").trim() === pid) impacts.push({ kingdom: kingdom, role: String(pair.role || "") });
      });
    });
    var roleRank = function (role) { return role === "weak" ? 0 : role === "main" ? 1 : 2; };
    impacts.sort(function (a, b) { return a.kingdom - b.kingdom || roleRank(a.role) - roleRank(b.role) || a.role.localeCompare(b.role); });
    var commands = (currentRoom && currentRoom.live && currentRoom.live.commands) || {}, nowSec = window.serverNowSec(), active = false;
    Object.keys(commands).forEach(function (key) {
      var command = commands[key], pairs = command && command.payload && Array.isArray(command.payload.pairs) ? command.payload.pairs : [];
      if (command && Number(command.expiresUTC) > nowSec && pairs.some(function (pair) { return String(pair && pair.pid || "").trim() === pid; })) active = true;
    });
    var signature = JSON.stringify({ exists: exists, name: name, impacts: impacts, active: active });
    return { pid: pid, exists: exists, name: name, impacts: impacts, active: active, signature: signature };
  }
  function visibleControl(element) { return !!(element && element.isConnected && !element.hidden && !element.closest("[hidden], .hide") && element.getClientRects().length); }
  function restorePlayerActionsFocus(pid) {
    var focusBest = function () {
      var target = pid && document.querySelector('.roster-actions[data-pid="' + window.esc(pid) + '"]');
      if (!visibleControl(target)) target = visibleControl($("rosterSearch")) ? $("rosterSearch") : null;
      if (!visibleControl(target)) target = Array.from(document.querySelectorAll("#roster .rp")).filter(visibleControl)[0] || $("console");
      if (target && target.focus) target.focus();
    };
    focusBest(); setTimeout(focusBest, 0);
  }
  function positionRosterActionsMenu() {
    var menu = $("rosterActionsMenu"), trigger = rosterActionsPid && document.querySelector('.roster-actions[data-pid="' + window.esc(rosterActionsPid) + '"]');
    if (!menu || !visibleControl(trigger)) return false;
    menu.hidden = false;
    var rect = trigger.getBoundingClientRect(), menuRect = menu.getBoundingClientRect();
    var left = Math.max(12, Math.min(window.innerWidth - menuRect.width - 12, rect.right - menuRect.width));
    var top = rect.bottom + 5;
    if (top + menuRect.height > window.innerHeight - 8) top = Math.max(8, rect.top - menuRect.height - 5);
    menu.style.left = Math.round(left) + "px"; menu.style.top = Math.round(top) + "px";
    return true;
  }
  function closeRosterActionsMenu(restoreFocus) {
    var pid = rosterActionsPid, menu = $("rosterActionsMenu"); rosterActionsPid = "";
    if (menu) { menu.hidden = true; menu.style.left = ""; menu.style.top = ""; $("rosterActionsExplanation").textContent = ""; }
    document.querySelectorAll('.roster-actions[aria-controls="rosterActionsMenu"]').forEach(function (trigger) { trigger.setAttribute("aria-expanded", "false"); });
    if (restoreFocus) restorePlayerActionsFocus(pid);
  }
  function renderRosterActionsMenu(sourceRoom) {
    var menu = $("rosterActionsMenu"); if (!menu || !rosterActionsPid) return;
    var snapshot = removalSnapshot(rosterActionsPid, sourceRoom);
    if (!snapshot.exists || !positionRosterActionsMenu()) { closeRosterActionsMenu(true); return; }
    var trigger = document.querySelector('.roster-actions[data-pid="' + window.esc(rosterActionsPid) + '"]');
    if (trigger) trigger.setAttribute("aria-expanded", "true");
    menu.setAttribute("aria-label", tkf("player_actions", { n: snapshot.name }));
    var edit = menu.querySelector('[data-action="edit-march"]'), remove = menu.querySelector('[data-action="remove"]');
    edit.textContent = tk("action_edit_march"); remove.textContent = tk("action_remove");
    var focusedAction = menu.contains(document.activeElement) && document.activeElement.dataset ? document.activeElement.dataset.action : "";
    edit.tabIndex = focusedAction === "remove" ? -1 : 0; remove.tabIndex = focusedAction === "remove" ? 0 : -1;
    var removalBusy = !!(removalState && ["pending", "unknown"].indexOf(removalState.status) >= 0 && removalState.pid !== rosterActionsPid);
    remove.setAttribute("aria-disabled", snapshot.active || removalBusy ? "true" : "false");
    $("rosterActionsExplanation").textContent = snapshot.active ? tk("remove_in_use") : removalBusy ? tkf("removing", { n: removalState.name }) : "";
  }
  function openRosterActionsMenu(pid) {
    if (!room || !room.players || !room.players[pid] || (removalState && removalState.dialogOpen)) return;
    if (rosterActionsPid === pid && !$("rosterActionsMenu").hidden) { closeRosterActionsMenu(true); return; }
    closeRosterActionsMenu(false); rosterActionsPid = pid; renderRosterActionsMenu();
    var first = $("rosterActionsMenu").querySelector('[role="menuitem"]'); if (first) first.focus();
  }
  function setRemovalPageInert(inert) {
    var page = document.querySelector(".wrap"); if (!page) return;
    if (inert) page.inert = true; else { page.inert = false; page.removeAttribute("inert"); }
  }
  function closeRemovalDialog(restoreFocus, discardRequest) {
    var state = removalState, pid = state && state.originPid;
    if ($("removePlayerOvl")) { $("removePlayerOvl").classList.remove("show"); $("removePlayerOvl").removeAttribute("aria-busy"); }
    setRemovalPageInert(false);
    if (state) state.dialogOpen = false;
    if (discardRequest || !state || ["pending", "unknown"].indexOf(state.status) < 0) removalState = null;
    if (restoreFocus) restorePlayerActionsFocus(pid);
  }
  function renderRemovalDialog(sourceRoom) {
    var overlay = $("removePlayerOvl"); if (!overlay || !removalState || !removalState.dialogOpen) return;
    var snapshot = removalSnapshot(removalState.pid, sourceRoom);
    if (!snapshot.exists) return;
    removalState.name = snapshot.name;
    $("removePlayerTitle").textContent = tkf("remove_confirm", { n: snapshot.name });
    $("removePlayerDescription").textContent = tk("remove_description");
    var impactLines = snapshot.impacts.map(function (impact) {
      var role = impact.role === "weak" ? tk("weak") : impact.role === "main" ? tk("main") : impact.role;
      return tkf("remove_impact_line", { k: impact.kingdom, r: role });
    });
    $("removePlayerImpact").textContent = impactLines.length ? tk("remove_impact") + "\n" + impactLines.join("\n") : tk("remove_no_impact");
    $("removePlayerCancel").textContent = tk("remove_cancel"); $("removePlayerConfirm").textContent = tk("remove_button");
    var statusKey = snapshot.active || removalState.status === "blocked" ? "remove_in_use" : removalState.status === "pending" ? "removing" : removalState.status === "unknown" ? "remove_unknown" : removalState.status === "retry" ? "remove_retry" : removalState.status === "changed" ? "remove_changed" : "";
    $("removePlayerStatus").textContent = statusKey ? tkf(statusKey, { n: snapshot.name }) : "";
    $("removePlayerStatus").className = "remove-player-status" + (["blocked", "unknown", "retry", "changed"].indexOf(removalState.status) >= 0 || snapshot.active ? " err" : "");
    var busy = removalState.status === "pending", unknown = removalState.status === "unknown";
    overlay.setAttribute("aria-busy", busy ? "true" : "false");
    $("removePlayerConfirm").disabled = busy || unknown || snapshot.active || removalState.status === "blocked";
  }
  function openRemovalDialog(pid) {
    var snapshot = removalSnapshot(pid); if (!snapshot.exists) return;
    if (snapshot.active) { $("rosterActionsExplanation").textContent = tk("remove_in_use"); return; }
    if (removalState && ["pending", "unknown"].indexOf(removalState.status) >= 0 && removalState.pid !== pid) {
      $("rosterActionsExplanation").textContent = tkf("removing", { n: removalState.name }); return;
    }
    var prior = removalState && removalState.pid === pid ? removalState : null;
    closeRosterActionsMenu(false); closeReplacement(false);
    removalState = prior || { pid: pid, name: snapshot.name, originPid: pid, baselineSignature: snapshot.signature, status: "confirm", socketGeneration: 0, dialogOpen: false };
    removalState.originPid = pid; removalState.name = snapshot.name; removalState.dialogOpen = true;
    if (["pending", "unknown", "retry"].indexOf(removalState.status) < 0) { removalState.status = "confirm"; removalState.baselineSignature = snapshot.signature; }
    setRemovalPageInert(true); $("removePlayerOvl").classList.add("show"); renderRemovalDialog(); $("removePlayerCancel").focus();
  }
  function submitRemoval() {
    if (!removalState || removalState.status === "pending" || removalState.status === "unknown") return false;
    var snapshot = removalSnapshot(removalState.pid);
    if (!snapshot.exists) return false;
    if (snapshot.active) { removalState.status = "blocked"; renderRemovalDialog(); return false; }
    if (snapshot.signature !== removalState.baselineSignature) {
      removalState.baselineSignature = snapshot.signature; removalState.status = "changed"; renderRemovalDialog(); return false;
    }
    var generation = sock ? sock.connectionGeneration : 0;
    var sent = !!(sock && sock.send({ t: "removePlayer", password: roomPw, pid: removalState.pid }));
    if (!sent) { removalState.status = "retry"; removalState.socketGeneration = 0; renderRemovalDialog(); return false; }
    removalState.status = "pending"; removalState.socketGeneration = generation; renderRemovalDialog(); return true;
  }
  function markRemovalDisconnected() {
    if (!removalState || removalState.status !== "pending" || !sock || removalState.socketGeneration !== sock.connectionGeneration) return;
    removalState.status = "unknown"; renderRemovalDialog();
  }
  function finishRemoval(pid, name) {
    var focusedPid = pid;
    if (rosterActionsPid === pid) { focusedPid = rosterActionsPid; closeRosterActionsMenu(false); }
    if (removalState && removalState.pid === pid) {
      focusedPid = removalState.originPid || focusedPid; closeRemovalDialog(false, true);
    }
    window.toast(tkf("removed", { n: name || pid })); restorePlayerActionsFocus(focusedPid); return true;
  }
  function reconcileRemovalState(nextRoom, freshSnapshot) {
    var players = (nextRoom && nextRoom.players) || {}, acknowledged = false;
    if (rosterActionsPid && !Object.prototype.hasOwnProperty.call(players, rosterActionsPid)) closeRosterActionsMenu(true);
    if (removalState) {
      if (!Object.prototype.hasOwnProperty.call(players, removalState.pid)) acknowledged = finishRemoval(removalState.pid, removalState.name);
      else if (["pending", "unknown"].indexOf(removalState.status) >= 0 && freshSnapshot && sock && sock.connectionGeneration > removalState.socketGeneration) {
        removalState.status = "retry"; renderRemovalDialog(nextRoom);
      } else if (removalState.status === "blocked" && freshSnapshot) {
        var latest = removalSnapshot(removalState.pid, nextRoom);
        if (!latest.active) removalState.status = latest.signature === removalState.baselineSignature ? "retry" : "changed";
        renderRemovalDialog(nextRoom);
      } else renderRemovalDialog(nextRoom);
    }
    if (rosterActionsPid) renderRosterActionsMenu(nextRoom);
    return acknowledged;
  }
  function invalidateCommanderAccess() {
    closeRosterActionsMenu(false); closeRemovalDialog(false, true);
    try { localStorage.removeItem(LS("pw")); } catch (e) {}
    window.toast(tk("wrongpw")); lockCmd();
    setTimeout(function () { if ($("cmdUnlock")) $("cmdUnlock").focus(); }, 0);
  }
  function handleRemovalProtocolError(message) {
    if (!removalState || !message || !sock || removalState.status !== "pending" || removalState.socketGeneration !== sock.connectionGeneration) return false;
    if (message.error === "player_in_live_command" && message.pid === removalState.pid) {
      removalState.status = "blocked"; renderRemovalDialog(); if (typeof sock.refresh === "function") sock.refresh(); return true;
    }
    if (message.error === "bad_password") {
      invalidateCommanderAccess(); return true;
    }
    return false;
  }
  function renderRoster() {
    var box = $("roster"); if (!box || !room) return;
    var players = Object.keys(room.players || {}).map(function (pid) { return Object.assign({ pid: pid }, room.players[pid]); });
    var cur = pickedByK[fireKingdom], otherK = fireKingdom === 1 ? 2 : 1, other = pickedByK[otherK].concat(serverStagedByK[otherK] || []);
    $("pickCnt").textContent = cur.length + "/2";
    box.innerHTML = "";
    var searchWrap = $("rosterSearchWrap"), search = $("rosterSearch"), showSearch = players.length > 6;
    if (searchWrap) searchWrap.classList.toggle("hide", !showSearch);
    if (search) { search.placeholder = tk("roster_search"); search.setAttribute("aria-label", tk("roster_search")); if (!showSearch) { rosterQuery = ""; search.value = ""; } }
    if (!players.length) {
      if (rosterActionsPid) closeRosterActionsMenu(false);
      if ($("duplicateHint")) { $("duplicateHint").classList.add("hide"); $("duplicateHint").textContent = ""; }
      box.innerHTML = '<span class="hint">' + tk("mapempty") + '</span>';
      refreshSyncPill(); renderSlots(); renderCommanderMarchEditor();
      var emptyFire = $("fireDouble"); if (emptyFire) emptyFire.disabled = true;
      return;
    }
    var counts = duplicateNameCounts(room.players), duplicateExists = Object.keys(counts).some(function (name) { return counts[name] > 1; });
    if ($("duplicateHint")) { $("duplicateHint").classList.toggle("hide", !duplicateExists); $("duplicateHint").textContent = duplicateExists ? tk("duplicate_suffix") : ""; }
    var rank = function (p) { return (cur.some(function (x) { return x.pid === p.pid; }) ? 0 : 2) + (isReady(p) ? 0 : 1); };
    players.sort(function (a, b) { return rank(a) - rank(b) || String(a.name || a.pid).localeCompare(String(b.name || b.pid)); });
    players.forEach(function (p) {
      var sel = cur.filter(function (x) { return x.pid === p.pid; })[0], inO = other.filter(function (x) { return x.pid === p.pid; })[0];
      var parts = playerDisplayParts(p.pid, room.players, counts), playerName = parts.name;
      var wrap = document.createElement("div"); wrap.className = "roster-row rpi" + (sel ? " sel" : "") + (inO ? " otherk" : ""); wrap.dataset.pid = p.pid; wrap.setAttribute("role", "listitem");
      var el = document.createElement("button"); el.type = "button"; el.className = "rp" + (sel ? " sel" : "") + (inO ? " otherk" : ""); el.dataset.pid = p.pid; el.setAttribute("aria-pressed", sel ? "true" : "false");
      if (inO) { el.setAttribute("aria-disabled", "true"); el.title = tkf("already_kingdom", { k: otherK }); }
      var presence = document.createElement("span"); presence.className = "roster-presence" + (isReady(p) ? "" : " stale"); presence.textContent = isReady(p) ? "●" : "○"; presence.setAttribute("aria-hidden", "true"); el.appendChild(presence);
      var nameSpan = document.createElement("span"); nameSpan.className = "roster-name"; nameSpan.textContent = parts.name; el.appendChild(nameSpan);
      if (parts.suffix) { var suffix = document.createElement("span"); suffix.className = "roster-name-suffix"; suffix.textContent = parts.suffix; el.appendChild(suffix); }
      el.setAttribute("aria-label", playerDisplayText(p.pid, room.players) + (inO ? " · " + tkf("already_kingdom", { k: otherK }) : ""));
      var roleButton = document.createElement("button"); roleButton.type = "button"; roleButton.className = "roster-role " + (sel ? sel.role : inO ? "otherk" : "ghost"); roleButton.dataset.pid = p.pid;
      roleButton.textContent = sel ? tk(sel.role === "main" ? "main" : "weak") : inO ? "🌍" + otherK : "—";
      roleButton.setAttribute("aria-disabled", sel ? "false" : "true"); roleButton.setAttribute("aria-label", sel ? tk(sel.role === "main" ? "main" : "weak") : inO ? tkf("already_kingdom", { k: otherK }) : tk("slot_empty"));
      roleButton.onclick = function () { if (!sel) return; var next = cur.map(function (pick) { return { pid: pick.pid, role: pick.pid === sel.pid ? (sel.role === "main" ? "weak" : "main") : (pick.role === "main" ? "weak" : "main") }; }); commitPicks(next); };
      var timeButton = document.createElement("button"); timeButton.type = "button"; timeButton.className = "roster-time"; timeButton.dataset.pid = p.pid; timeButton.textContent = window.mmss(p.march || 0); timeButton.setAttribute("aria-disabled", roomPw ? "false" : "true"); timeButton.setAttribute("aria-expanded", editingPlayerPid === p.pid ? "true" : "false"); timeButton.setAttribute("aria-controls", "commanderMarchEditor"); timeButton.setAttribute("aria-label", tkf("edit_march", { n: playerDisplayText(p.pid, room.players) }) + " · " + window.mmss(p.march || 0));
      timeButton.onclick = function () { openCommanderMarchEditor(p.pid, timeButton); };
      var del = document.createElement("button");
      del.type = "button"; del.className = "roster-actions"; del.dataset.pid = p.pid; del.textContent = "⋯";
      del.setAttribute("aria-label", tkf("player_actions", { n: playerDisplayText(p.pid, room.players) })); del.setAttribute("aria-haspopup", "menu"); del.setAttribute("aria-controls", "rosterActionsMenu"); del.setAttribute("aria-expanded", rosterActionsPid === p.pid ? "true" : "false");
      del.onclick = function (event) { event.preventDefault(); event.stopPropagation(); openRosterActionsMenu(p.pid); };
      el.onclick = function () { selectOrReplacePlayer(p.pid); };
      var haystack = ((p.name || "") + " " + p.pid).toLowerCase(); wrap.hidden = !!(rosterQuery && haystack.indexOf(rosterQuery) < 0);
      wrap.appendChild(el); wrap.appendChild(roleButton); wrap.appendChild(timeButton); wrap.appendChild(del); box.appendChild(wrap);
    });
    refreshSyncPill(); renderSlots(); renderCommanderMarchEditor(); if (rosterActionsPid) renderRosterActionsMenu();
    var ready = cur.length === 2 && cur.some(function (pick) { return pick.role === "weak"; }) && cur.some(function (pick) { return pick.role === "main"; });
    var fd = $("fireDouble"); if (fd) fd.disabled = !ready;
  }
  function deliveryForPlayer(command, pid) {
    if (!command || !Array.isArray(command.delivery)) return null;
    var delivery = command.delivery.filter(function (value) { return value && value.pid === pid; })[0];
    if (!delivery) return null;
    var expected = Math.max(0, Number(delivery.expected) || 0);
    var received = Math.max(0, Number(delivery.received) || 0);
    var expired = Math.max(0, Number(delivery.expired) || 0);
    if (received > 0) {
      var partial = expected > received;
      return {
        kind: "received",
        complete: !partial,
        text: expected > 1 ? tkf("delivery_received_count", { n: received, m: expected }) : tk("delivery_received")
      };
    }
    if (expired > 0) return { kind: "expired", complete: false, text: tk("delivery_expired") };
    var createdAt = Date.parse(command.at || ""), ageMs = Number.isFinite(createdAt) ? window.serverNow() - createdAt : Infinity;
    if (ageMs < 1500) return { kind: "sent", complete: false, text: tk("delivery_sent") };
    return { kind: "missing", complete: false, text: tk("delivery_missing") };
  }
  function armDeliveryStatusTimer(command) {
    if (deliveryStatusTimer) { clearTimeout(deliveryStatusTimer); deliveryStatusTimer = 0; }
    if (!command || !Array.isArray(command.delivery)) return;
    var createdAt = Date.parse(command.at || ""), ageMs = Number.isFinite(createdAt) ? window.serverNow() - createdAt : Infinity;
    var waiting = command.delivery.some(function (value) { return value && !(Number(value.received) > 0) && !(Number(value.expired) > 0); });
    if (waiting && ageMs < 1500) {
      deliveryStatusTimer = setTimeout(function () { deliveryStatusTimer = 0; renderSlots(); }, Math.max(20, 1510 - Math.max(0, ageMs)));
    }
  }
  // explicit role slots: who's SACRIFICE (lands first, eats the garrison) vs MAIN (+1s behind) is never a guess.
  // Tap a filled slot's × to unpick; ⇄ swaps roles in one tap (the roster-badge tap still works too).
  function renderSlots(kingdom) {
    var box = $("pickSlots"); if (!box) return;
    var selectedKingdom = kingdom || fireKingdom, cur = pickedByK[selectedKingdom], players = (room && room.players) || {}, counts = duplicateNameCounts(players);
    var liveCommand = room && room.live && room.live.commands && room.live.commands[selectedKingdom];
    var livePairs = liveCommand && liveCommand.payload && Array.isArray(liveCommand.payload.pairs) ? liveCommand.payload.pairs : [];
    var frozen = cur.length === 0 && livePairs.length > 0, source = frozen ? livePairs : cur;
    var weakPick = source.filter(function (x) { return x.role === "weak"; })[0], mainPick = source.filter(function (x) { return x.role === "main"; })[0];
    var weak = frozen ? weakPick : weakPick && canonicalPick(weakPick.pid, "weak", players);
    var main = frozen ? mainPick : mainPick && canonicalPick(mainPick.pid, "main", players);
    box.classList.toggle("frozen", frozen);
    function cell(role, c) {
      var parts = c ? playerDisplayParts(c.pid, players, counts) : null;
      var status = frozen && c ? deliveryForPlayer(liveCommand, c.pid) : null;
      var deliveryClass = status ? "delivery " + status.kind + (status.kind === "received" && !status.complete ? " partial" : "") : "";
      return '<div class="slot ' + role + (c ? " filled" : "") + (frozen ? " frozen" : "") + '"' + (c ? ' data-pid="' + window.esc(c.pid) + '"' : "") + '>'
        + '<div class="sl">' + tk(role === "weak" ? "slot_weak" : "slot_main") + '</div>'
        + (c ? '<div class="sv"><span class="slot-name">' + window.esc(parts.name) + '</span>' + (parts.suffix ? '<span class="roster-name-suffix">' + window.esc(parts.suffix) + '</span>' : '') + ' <small>' + window.mmss(c.march || 0) + '</small>' + (frozen ? '' : '<button type="button" class="sx" data-pid="' + window.esc(c.pid) + '" aria-label="' + window.esc(tkf("remove_aria", { n: parts.name })) + '">×</button>') + '</div>'
             : '<div class="sv empty">' + tk("slot_empty") + '</div>')
        + '<div class="ss">' + tk(role === "weak" ? "slot_weak_sub" : "slot_main_sub") + '</div>'
        + (status ? '<span class="' + deliveryClass + '">' + window.esc(status.text) + '</span>' : '') + '</div>';
    }
    box.innerHTML = cell("weak", weak) + (frozen ? "" : '<button class="swapbtn" id="swapRoles" title="⇄" aria-label="' + window.esc(tk("slot_swap_tip")) + '"' + (cur.length === 2 ? "" : " disabled") + '>⇄</button>') + cell("main", main);
    box.querySelectorAll(".sx").forEach(function (x) {
      x.onclick = function () { var pid = x.getAttribute("data-pid"); commitPicks(pickedByK[fireKingdom].filter(function (p) { return p.pid !== pid; })); };
    });
    var sw = $("swapRoles"); if (sw) sw.onclick = function () { commitPicks(pickedByK[fireKingdom].map(function (pick) { return { pid: pick.pid, role: pick.role === "main" ? "weak" : "main" }; })); window.toast(tk("slot_swap_tip")); };
    armDeliveryStatusTimer(frozen ? liveCommand : null);
  }
  // hard sync gate that does NOT waste the commander's confirm tap: if unsynced, resync then auto-fire on success
  function gateSync(fn) { if (syncedOK) return fn(); window.toast(tk("notsynced")); beginClockSync(function (ok) { if (ok) fn(); else window.toast(tk("notconn")); }); }
  function fireDouble() {
    var commandKingdom = fireKingdom, cur = pickedByK[commandKingdom]; if (cur.length < 2) { window.toast(tk("need2")); return; }
    var weakPick = cur.filter(function (x) { return x.role === "weak"; })[0], mainPick = cur.filter(function (x) { return x.role === "main"; })[0];
    var weak = weakPick && canonicalPick(weakPick.pid, "weak", room && room.players), main = mainPick && canonicalPick(mainPick.pid, "main", room && room.players);
    if (!weak || !main || weak.pid === main.pid) { window.toast(tk("need2")); return; }   // belt+braces: never fire the same player as both roles
    if (!weak.march || !main.march) { window.toast(tk("nomarch")); return; }
    gateSync(function () {
      var absent = [weak, main].some(function (c) { return !isReady(room && room.players && room.players[c.pid]); });
      if (absent) window.toast(tk("cap_absent"));
      var now = window.serverNow() / 1000, off = (main.march - weak.march) - 1, pm, ps;
      if (off >= 0) { pm = now + lead; ps = pm + off; } else { ps = now + lead; pm = ps - off; }
      var pairs = [{ pid: weak.pid, name: weak.name, role: "weak", march: weak.march, pressUTC: ps }, { pid: main.pid, name: main.name, role: "main", march: main.march, pressUTC: pm }];
      var ok = sock.send({ t: "cmd", password: roomPw, cmd: { type: "double_rally", kingdom: commandKingdom, anchorUTC: Math.min(pm, ps), payload: { pairs: pairs, firstPress: Math.min(pm, ps), kingdom: commandKingdom, leadSeconds: lead } } });
      if (ok) consumeStageForFire(commandKingdom);
      window.toast(ok ? tk("fired") : tk("notconn"));
    });
  }

  function consumeStageForFire(kingdom) {
    queuedStageByK[kingdom] = null;
    if (pendingStageMutation && pendingStageMutation.kingdom === kingdom) pendingStageMutation = null;
    stageFocusByK[kingdom] = "";
  }

  function renderTruthTexts() {
    truthLang = L() ? "en" : "zh";
    var note = $("defenseDemoNote"); if (note) note.textContent = tk("defense_demo");
    var pp = $("dpp"); if (pp) pp.setAttribute("aria-label", L() ? "Play or pause timing rehearsal" : "播放或暂停时机演练");
    var scrub = $("dscrub"); if (scrub) scrub.setAttribute("aria-label", L() ? "Timing rehearsal progress" : "时机演练进度");
  }
  function pauseDefenseRehearsal() { dPlaying = false; dLastTs = null; var pp = $("dpp"); if (pp) pp.textContent = "▶"; }
  function wireDefenseTruth() {
    document.addEventListener("click", function (e) { if (e.target && e.target.closest && e.target.closest("#defenseView .wchip, #defenseView .dlane")) setTimeout(pauseDefenseRehearsal, 0); });
    renderTruthTexts();
    setInterval(function () { if (truthLang !== (L() ? "en" : "zh")) renderTruthTexts(); }, 500);
  }
  function stageBroadcast(previous) {
    if (!roomPw || !sock) return false;
    queuedStageByK[fireKingdom] = clonePicks(pickedByK[fireKingdom]);
    return pumpStageQueue();
  }
  function pumpStageQueue() {
    if (pendingStageMutation || !roomPw || !sock) return false;
    var kingdom = queuedStageByK[1] ? 1 : queuedStageByK[2] ? 2 : 0;
    if (!kingdom) return true;
    var desired = clonePicks(queuedStageByK[kingdom]); queuedStageByK[kingdom] = null;
    if (pickSignature(desired) === pickSignature(serverStagedByK[kingdom])) {
      pickedByK[kingdom] = clonePicks(serverStagedByK[kingdom]);
      var settledFocus = stageFocusByK[kingdom]; stageFocusByK[kingdom] = "";
      if (room) renderRoster(); if (settledFocus) restoreRosterFocus(settledFocus);
      return pumpStageQueue();
    }
    pendingStageMutation = { kingdom: kingdom, expected: desired, awaitingReconnect: false, reconnectAfterSnapshot: -1 };
    var ok = sock.send({ t: "stage", password: roomPw, staged: { kingdom: kingdom, pairs: desired } });
    if (!ok) rollbackStageSelection(tk("notconn"), true);
    return ok;
  }
  function tapFire(btn, labelEl, labelKey, fn) {   // double-TAP to confirm — no long-press, so iOS never pops the text-selection/copy callout
    var armed = 0;
    btn.onclick = function () {
      var n = Date.now();
      if (armed && n - armed < 3000) { armed = 0; labelEl.textContent = tk(labelKey); btn.classList.remove("armed"); try { navigator.vibrate && navigator.vibrate(40); } catch (e) {} fn(); }
      else { armed = n; var a = n; labelEl.textContent = tk("tapagain"); btn.classList.add("armed"); setTimeout(function () { if (armed === a) { armed = 0; labelEl.textContent = tk(labelKey); btn.classList.remove("armed"); } }, 3000); }
    };
  }

  /* ---------- player identity ---------- */
  function normalizeNickname(value) {
    return Array.from(String(value || "")
      .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
      .trim().replace(/\s+/g, " ")).slice(0, 24).join("");
  }
  function createNicknameRoutingKey() {
    var bytes = crypto.getRandomValues(new Uint8Array(11));
    return "n_" + Array.from(bytes, function (byte) { return byte.toString(16).padStart(2, "0"); }).join("");
  }
  function cancelIdentityLookup() {
    lookupSequence += 1;
    if (lookupTimer) clearTimeout(lookupTimer);
    lookupTimer = null;
    var controller = lookupAbort; lookupAbort = null;
    if (controller) controller.abort();
    var output = $("nameOut");
    if (output) { output.textContent = ""; output.dataset.name = ""; }
    return lookupSequence;
  }
  function syncIdentityControls(locked) {
    var playerId = $("identityPlayerId"), nickname = $("identityNickname"), input = $("pid");
    if (!playerId || !nickname || !input) return;
    var nicknameSelected = identityMode === "nickname";
    var group = $("identityMode"); if (group) group.setAttribute("aria-label", tk("identity_type"));
    playerId.textContent = tk("identity_player_id") + " · " + tk("identity_recommended");
    nickname.textContent = tk("identity_nickname") + " · " + tk("identity_testing");
    playerId.setAttribute("aria-checked", nicknameSelected ? "false" : "true");
    nickname.setAttribute("aria-checked", nicknameSelected ? "true" : "false");
    playerId.setAttribute("tabindex", nicknameSelected ? "-1" : "0");
    nickname.setAttribute("tabindex", nicknameSelected ? "0" : "-1");
    playerId.disabled = !!locked; nickname.disabled = !!locked;
    input.readOnly = !!locked;
    input.setAttribute("inputmode", nicknameSelected ? "text" : "numeric");
    input.placeholder = tk(nicknameSelected ? "nicknameph" : "pidph");
    var label = $("identityLabel"); if (label) label.textContent = tk(nicknameSelected ? "identity_nickname" : "identity_player_id");
  }
  function setIdentityMode(mode) {
    if (myProfile && myProfile.pid) return;
    var nextMode = mode === "nickname" ? "nickname" : "playerId";
    if (identityMode === nextMode) { syncIdentityControls(false); return; }
    identityMode = nextMode; nicknameDraftRoutingKey = ""; markDraft(); cancelIdentityLookup();
    $("pid").value = "";
    syncIdentityControls(false);
  }
  function showExistingIdentity(profile) {
    cancelIdentityLookup(); nicknameDraftRoutingKey = "";
    identityMode = profile && profile.identityMode === "nickname" ? "nickname" : "playerId";
    $("pid").value = identityMode === "nickname" ? (profile.name || "") : profile.pid;
    if (profile.name) { $("nameOut").textContent = "✓ " + profile.name; $("nameOut").dataset.name = profile.name; }
    syncIdentityControls(true);
  }
  function resetIdentityDraft() {
    cancelIdentityLookup(); nicknameDraftRoutingKey = ""; identityMode = "playerId";
    $("pid").value = "";
    syncIdentityControls(false);
  }
  function schedulePlayerLookup(input) {
    var fid = input.value.replace(/\D/g, "").slice(0, 16);
    input.value = fid;
    var sequence = cancelIdentityLookup();
    if (!fid || identityMode !== "playerId") return;
    $("nameOut").textContent = "…";
    lookupTimer = setTimeout(function () {
      if (identityMode !== "playerId" || sequence !== lookupSequence || $("pid").value.replace(/\D/g, "") !== fid) return;
      lookupTimer = null;
      var controller = new AbortController(); lookupAbort = controller;
      fetch("/api/lookup?fid=" + encodeURIComponent(fid), { signal: controller.signal })
        .then(function (response) { return response.json(); })
        .then(function (result) {
          if (identityMode !== "playerId" || sequence !== lookupSequence || $("pid").value.replace(/\D/g, "") !== fid) return;
          $("nameOut").textContent = result.ok ? "✓ " + result.nickname : tk("namefail");
          $("nameOut").dataset.name = result.ok ? result.nickname : "";
        })
        .catch(function (error) {
          if (identityMode !== "playerId" || sequence !== lookupSequence || $("pid").value.replace(/\D/g, "") !== fid || (error && error.name === "AbortError")) return;
          $("nameOut").textContent = tk("namefail"); $("nameOut").dataset.name = "";
        })
        .finally(function () {
          if (identityMode === "playerId" && sequence === lookupSequence && $("pid").value.replace(/\D/g, "") === fid && lookupAbort === controller) lookupAbort = null;
        });
    }, 500);
  }
  function wireIdentityControls() {
    var options = [$("identityPlayerId"), $("identityNickname")];
    options.forEach(function (option) {
      option.onclick = function () { setIdentityMode(option.dataset.mode); };
      option.addEventListener("keydown", function (event) {
        var mode = null;
        if (event.key === "Home") mode = "playerId";
        else if (event.key === "End") mode = "nickname";
        else if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].indexOf(event.key) >= 0) mode = option.dataset.mode === "nickname" ? "playerId" : "nickname";
        if (!mode) return;
        event.preventDefault(); setIdentityMode(mode);
        $(mode === "nickname" ? "identityNickname" : "identityPlayerId").focus();
      });
    });
    $("pid").addEventListener("input", function () {
      markDraft();
      if (identityMode === "nickname") cancelIdentityLookup();
      else schedulePlayerLookup(this);
    });
    syncIdentityControls(!!(myProfile && myProfile.pid));
  }

  /* ---------- alerts UI ---------- */
  function saveProfile(profile) {
    myProfile = profile;
    myPid = profile && profile.pid ? profile.pid : "";
    if (profile) wr(LS("me"), JSON.stringify(profile));
    else { try { localStorage.removeItem(LS("me")); } catch (e) {} }
  }
  function adoptCanonicalPlayer(pid, player) {
    if (!myProfile || pid !== myProfile.pid) return;
    saveProfile(Object.assign({}, myProfile, {
      name: player.name || pid,
      march: player.march,
      marchRevision: Number.isInteger(player.marchRevision) ? player.marchRevision : 0,
      identityMode: player.identityMode || myProfile.identityMode || "playerId"
    }));
  }
  function registerStoredProfile() {
    if (!myProfile || registrationPending || !sock) return;
    registrationPending = sock.send({
      t: "registerPlayer", pid: myProfile.pid, name: myProfile.name,
      march: myProfile.march, identityMode: myProfile.identityMode || "playerId", alliance: ""
    });
  }
  function registerPendingProfile() {
    if (!pendingRegistrationProfile || registrationPending || !sock) return registrationPending;
    registrationPending = sock.send({
      t: "registerPlayer", pid: pendingRegistrationProfile.pid, name: pendingRegistrationProfile.name,
      march: pendingRegistrationProfile.march, identityMode: pendingRegistrationProfile.identityMode || "playerId", alliance: ""
    });
    if (!registrationPending) { draftActive = true; window.toast(tk("notconn")); }
    return registrationPending;
  }
  function acceptPendingRegistration(player) {
    var pending = pendingRegistrationProfile;
    if (!pending) return;
    var settleUI = pending.draftVersion === draftVersion;
    saveProfile({
      pid: pending.pid,
      name: player.name || pending.pid,
      march: player.march,
      marchRevision: Number.isInteger(player.marchRevision) ? player.marchRevision : 0,
      identityMode: player.identityMode || pending.identityMode || "playerId"
    });
    if (!deviceId) deviceId = window.getRoomDeviceId(ROOM);
    nicknameDraftRoutingKey = ""; cancelIdentityLookup();
    pendingRegistrationProfile = null; registrationPending = false; ownPlayerSeen = true;
    sendDeviceStatus();
    if (settleUI) {
      draftActive = false; showInCard(myProfile); window.toast(tk("updated") + " · " + window.mmss(myProfile.march));
      if (viewMode === "defense") renderDefense();
    } else { draftActive = true; showExistingIdentity(myProfile); }
  }
  function settlePendingMarchMutation() {
    if (!pendingMarchMutation || !pendingMarchMutation.ackSeen || !pendingMarchMutation.stateSeen) return;
    var march = pendingMarchMutation.requestedMarch, settleUI = pendingMarchMutation.draftVersion === draftVersion;
    pendingMarchMutation = null;
    if (settleUI) {
      draftActive = false; showInCard(myProfile); window.toast(tk("updated") + " · " + window.mmss(march));
      if (viewMode === "defense") renderDefense();
    } else draftActive = true;
  }
  function handleCommanderMarchAck(message) {
    var pending = pendingCommanderMarchMutation;
    if (!message || message.t !== "playerMarchSaved" || !pending || message.mutationId !== pending.mutationId) return false;
    if (message.pid === pending.pid && message.march === pending.requestedMarch && message.revision === pending.baseRevision + 1) {
      pending.ackSeen = true; settleCommanderMarchMutation();
    }
    return true;
  }
  function handleStageSuperseded(message) {
    if (!message || message.t !== "stageSuperseded") return false;
    var kingdom = Number(message.kingdom);
    if (kingdom !== 1 && kingdom !== 2) return true;
    consumeStageForFire(kingdom);
    serverStagedByK[kingdom] = [];
    var live = room && room.live && room.live.commands && room.live.commands[kingdom];
    if (live && live.id === message.commandId) pickedByK[kingdom] = [];
    if (room) renderRoster();
    return true;
  }
  function handleSocketMessage(message) {
    if (handleStageSuperseded(message)) return;
    if (handleDeviceStatusSaved(message)) return;
    if (handleDeliveryAckSaved(message)) return;
    if (handleCommanderMarchAck(message)) return;
    if (!message || message.t !== "playerMarchSaved" || !pendingMarchMutation || message.mutationId !== pendingMarchMutation.mutationId) return;
    pendingMarchMutation.ackSeen = true;
    settlePendingMarchMutation();
  }
  function clearOwnProfile() {
    registrationPending = false; pendingRegistrationProfile = null; pendingMarchMutation = null;
    clearAllDeliveryAckState(); lastDeviceStatusSignature = ""; lastDeviceStatusGeneration = -1;
    lastDeviceStatusSentSignature = ""; lastDeviceStatusSentGeneration = -1; lastDeviceStatusSentAt = 0;
    saveProfile(null); draftActive = true; ownPlayerSeen = false;
    try { localStorage.removeItem("kvk:" + ROOM + ":delivery-device:v1"); } catch (e) {}
    deviceId = "";
    if (sock && typeof sock.refresh === "function") setTimeout(function () { sock.refresh(); }, 0);
    resetIdentityDraft();
    $("fillCard").classList.remove("hide"); $("youChip").classList.add("hide");
  }
  function markDraft() { draftActive = true; draftVersion += 1; }
  function handleCommanderMarchProtocolError(message) {
    var pending = pendingCommanderMarchMutation;
    if (!pending || !message || message.mutationId !== pending.mutationId) return false;
    pendingCommanderMarchMutation = null; commanderMarchDirty = true; commanderMarchStatusTone = "err";
    if (message.error === "player_conflict") {
      var latest = message.latest;
      if (latest && latest.pid === pending.pid && Number.isInteger(latest.march) && Number.isInteger(latest.revision) && latest.revision >= 0) {
        markCommanderMarchConflict({ pid: latest.pid, march: latest.march, revision: latest.revision });
      } else { commanderMarchStatus = "unsaved"; renderCommanderMarchEditor(); }
    } else if (message.error === "invalid_march") {
      commanderMarchStatus = "invalid"; renderCommanderMarchEditor();
    } else if (message.error === "player_missing") {
      commanderMarchStale = true; commanderMarchStatus = "stale"; commanderMarchRefreshAfterSnapshot = roomSnapshotSequence; renderCommanderMarchEditor();
      if (sock && typeof sock.refresh === "function") sock.refresh(); else if (sock) sock.kick();
    } else if (message.error === "bad_password") {
      commanderMarchStatus = "unsaved"; renderCommanderMarchEditor();
      invalidateCommanderAccess();
    } else {
      commanderMarchStatus = "unsaved"; renderCommanderMarchEditor();
    }
    return true;
  }
  function handlePlayerProtocolError(message) {
    var error = message && message.error;
    if (["invalid_march", "player_missing", "player_conflict"].indexOf(error) < 0 && error !== "invalid_pid") return false;
    if (error === "player_missing" && !message.mutationId) return false;
    if (message.mutationId && (!pendingMarchMutation || message.mutationId !== pendingMarchMutation.mutationId)) return false;
    if (pendingMarchMutation && message.mutationId === pendingMarchMutation.mutationId) {
      if (error === "player_conflict" && message.latest && myProfile && message.latest.pid === myProfile.pid) {
        saveProfile(Object.assign({}, myProfile, {
          march: message.latest.march,
          marchRevision: Number.isInteger(message.latest.revision) ? message.latest.revision : myProfile.marchRevision
        }));
      }
      pendingMarchMutation = null; draftActive = true;
    } else if (pendingRegistrationProfile || registrationPending) {
      pendingRegistrationProfile = null; registrationPending = false; draftActive = true;
    } else return false;
    if (error === "invalid_pid") nicknameDraftRoutingKey = "";
    cancelIdentityLookup();
    if (myProfile && myProfile.pid) showExistingIdentity(myProfile); else syncIdentityControls(false);
    $("fillCard").classList.remove("hide"); $("youChip").classList.add("hide");
    if (error === "invalid_march") window.toast(tk("marchfirst"));
    else if (error === "invalid_pid") window.toast(identityMode === "nickname" ? tk("invalid_nickname") : "Player ID");
    else if (error === "player_missing") window.toast(tk("player_missing"));
    return true;
  }
  /* ---------- net + sync ---------- */
  function connect() {
    initDeliveryShadow();
    sock = new window.RoomSocket(ROOM, onState);
    var deliveryShadowSocket = sock;
    sock.onMessage = function (message) {
      var deliveryShadowGeneration = Number(deliveryShadowSocket.connectionGeneration || 0);
      handleSocketMessage(message);
      if (sock !== deliveryShadowSocket ||
          Number(deliveryShadowSocket.connectionGeneration || 0) !== deliveryShadowGeneration) return;
      handleDeliveryShadowMessage(message);
    };
    sock.onOpen = function () { deliveryShadowConnectionOpened(); initialStateSeen = false; safeUpdateCheck(); registrationPending = false; setNet(true); sendDeviceStatus(); retryPendingDeliveryAcks(true); beginClockSync().then(deliveryShadowClockCallback()); };
    sock.onClose = function () {
      initialStateSeen = false; registrationPending = false;
      if (pendingMarchMutation && !pendingMarchMutation.ackSeen) pendingMarchMutation = null;
      if (pendingCommanderMarchMutation && !pendingCommanderMarchMutation.ackSeen) { pendingCommanderMarchMutation = null; commanderMarchStatus = "unsaved"; commanderMarchStatusTone = "err"; commanderMarchDirty = true; renderCommanderMarchEditor(); }
      else if (pendingCommanderMarchMutation) { pendingCommanderMarchMutation.awaitingReconnect = true; pendingCommanderMarchMutation.reconnectAfterSnapshot = roomSnapshotSequence; }
      if (pendingStageMutation) { pendingStageMutation.awaitingReconnect = true; pendingStageMutation.reconnectAfterSnapshot = roomSnapshotSequence; }
      markRemovalDisconnected();
      setNet(false);
    };
    sock.onError = function (m) {
      if (rejectPendingDeliveryAck(m)) return;
      if (m && m.source === "deviceStatus" && ["invalid_device_identity", "socket_identity_locked", "device_owned_by_other_pid"].indexOf(m.error) >= 0) return;
      if (handleCommanderMarchProtocolError(m)) return;
      if (handlePlayerProtocolError(m)) return;
      if (handleRemovalProtocolError(m)) return;
      if (m && m.mutationId) return;
      if (m.error === "player_staged_other_kingdom") { rollbackStageSelection(tk("stage_other_kingdom")); return; }
      if (pendingStageMutation && m.error === "player_missing") { rollbackStageSelection(tk("player_missing")); return; }
      if (m.error === "bad_password" && pendingStageMutation) rollbackStageSelection(null, true);
      if (m.error === "bad_password") {
        if (pendingUnlock) { pendingUnlock = false; roomPw = ""; var msg = $("pwMsg"); if (msg) { msg.textContent = tk("wrongpw"); msg.className = "pwmsg err"; } }
        else invalidateCommanderAccess();
      } else if (m.error === "player_missing") window.toast(tk("player_missing"));
      else if (m.error === "rally_live") window.toast(tk("rally_live"));
      else if (m.error === "conflict") {
        if (pendingUnlock) { if (m.room) room = m.room; unlockedOK(); }
        else if (pendingPubWhales && window.confirm(tk("confirm_over"))) sendWhales(pendingPubWhales, m.room ? m.room.updatedAt : (room ? room.updatedAt : undefined));
        else { pendingPubWhales = null; pendingPubTok = null; var pm = $("pubMsg"); if (pm) pm.innerHTML = '<span style="color:var(--coral)">' + tk("pub_fail") + '</span>'; }
      }
    };
  }
  // one glanceable signal instead of four separate badges: worst state wins (offline > syncing > "{n} online")
  var connFlag = false, presenceN = 1;
  function paintChrome() {
    var dot = $("cdot"), lab = $("netlab"); if (!dot || !lab) return;
    if (!connFlag) { dot.className = "cdot off"; lab.textContent = tk("net_off"); }
    else if (!syncedOK) { dot.className = "cdot"; lab.textContent = tk("syncing"); }
    else { dot.className = "cdot on"; lab.textContent = tkf("online_n", { n: presenceN }); }
  }
  function setNet(on) { connFlag = on; paintChrome(); }
  function beginClockSync(done) {
    var attempt = ++syncAttempt;
    syncedOK = false; paintChrome();
    return window.syncClock().then(function (result) {
      if (attempt !== syncAttempt) { window.clockOffset = lastAcceptedClockOffset; return false; }
      lastAcceptedClockOffset = Number(window.clockOffset) || 0;
      updateSync(result);
      if (done) done(syncedOK);
      return syncedOK;
    });
  }
  function updateSync(r) { if (r) syncedOK = r.rtt != null; paintChrome(); rebookCuesOnDrift(); if (syncedOK) scheduleAllCues(); }   // post-suspend resync: future beeps re-book on the corrected clock, then ACK only the corrected schedule
  var lastStagedKey = "", lastMyMarch = 0;
  function onState(r) {
    var freshRoomSnapshot = r !== room, settledStageFocusPid = "";
    if (freshRoomSnapshot) roomSnapshotSequence += 1;
    var nextPlayers = r.players || {};
    var firstSnapshot = !initialStateSeen; initialStateSeen = true;
    var trackedPid = myProfile && myProfile.pid;
    var ownRemoved = !!(trackedPid && ownPlayerSeen && !Object.prototype.hasOwnProperty.call(nextPlayers, trackedPid));
    var ownRemovedName = ownRemoved ? (myProfile.name || trackedPid) : "", acknowledgedOwnRemoval = false;
    [1, 2].forEach(function (kd) {
      var canonicalStaged = r.live && r.live.staged && r.live.staged[kd];
      serverStagedByK[kd] = canonicalStaged && Array.isArray(canonicalStaged.pairs) ? canonicalStaged.pairs.map(function (pick) { return { pid: pick.pid, role: pick.role }; }) : [];
    });
    if (roomPw && !picksTouched) {
      [1, 2].forEach(function (kd) {
        var staged = r.live && r.live.staged && r.live.staged[kd];
        if (staged && Array.isArray(staged.pairs) && staged.pairs.length && !pickedByK[kd].length) {
          pickedByK[kd] = staged.pairs.map(function (pick) { return { pid: pick.pid, role: pick.role }; });
        }
      });
    }
    reconcilePicks(nextPlayers);
    if (pendingStageMutation) {
      var stageKingdom = pendingStageMutation.kingdom;
      if (pickSignature(serverStagedByK[stageKingdom]) === pickSignature(pendingStageMutation.expected)) {
        pendingStageMutation = null;
        if (!queuedStageByK[stageKingdom]) { pickedByK[stageKingdom] = clonePicks(serverStagedByK[stageKingdom]); settledStageFocusPid = stageFocusByK[stageKingdom]; stageFocusByK[stageKingdom] = ""; }
      } else if (pendingStageMutation.awaitingReconnect && freshRoomSnapshot && roomSnapshotSequence > pendingStageMutation.reconnectAfterSnapshot) {
        rollbackStageSelection();
      }
    }
    [1, 2].forEach(function (kd) { if ((!pendingStageMutation || pendingStageMutation.kingdom !== kd) && !queuedStageByK[kd]) pickedByK[kd] = clonePicks(serverStagedByK[kd]); });
    if (pendingReplacementPid && (!nextPlayers[pendingReplacementPid] || pickedByK[fireKingdom].length < 2 || otherKingdomForPid(pendingReplacementPid, fireKingdom) || (pendingReplacementIncumbents && pickSignature(pickedByK[fireKingdom]) !== pendingReplacementIncumbents.signature))) closeReplacement(true);
    var removingOwnPid = !!(removalState && removalState.pid === trackedPid);
    acknowledgedOwnRemoval = reconcileRemovalState(r, freshRoomSnapshot) && ownRemoved && removingOwnPid;
    if (ownRemoved) {
      clearOwnProfile();
      if (!acknowledgedOwnRemoval) window.toast(tkf("removed", { n: ownRemovedName }));
    } else if (pendingRegistrationProfile) {
      if (Object.prototype.hasOwnProperty.call(nextPlayers, pendingRegistrationProfile.pid)) acceptPendingRegistration(nextPlayers[pendingRegistrationProfile.pid]);
      else if (firstSnapshot && !registrationPending) registerPendingProfile();
    } else if (myProfile) {
      var canonical = nextPlayers[myProfile.pid];
      if (canonical) {
        var canonicalRevision = Number.isInteger(canonical.marchRevision) ? canonical.marchRevision : 0;
        var becameCanonical = !ownPlayerSeen;
        ownPlayerSeen = true; registrationPending = false;
        if (becameCanonical) sendDeviceStatus("deviceStatus", true);
        adoptCanonicalPlayer(myProfile.pid, canonical);
        if (pendingMarchMutation && pendingMarchMutation.pid === myProfile.pid &&
            canonical.march === pendingMarchMutation.requestedMarch &&
            canonicalRevision === pendingMarchMutation.baseRevision + 1) {
          pendingMarchMutation.stateSeen = true;
        } else if (pendingMarchMutation && (canonicalRevision > pendingMarchMutation.baseRevision + 1 ||
                   (canonicalRevision === pendingMarchMutation.baseRevision + 1 && canonical.march !== pendingMarchMutation.requestedMarch))) {
          pendingMarchMutation = null; draftActive = true;
        }
        if (!draftActive && !pendingRegistrationProfile && !pendingMarchMutation) showInCard(myProfile);
        settlePendingMarchMutation();
      } else if (firstSnapshot && !ownPlayerSeen) registerStoredProfile();
    }
    // a live order that vanishes BEFORE its click moment = cancelled → everyone gets a positive audible+visual cue
    // (the pre-booked countdown beeps are killed by reconcileCues inside scheduleAllCues)
    if (room) {
      var nowS = window.serverNowSec(), newIds = liveCommands(r).map(function (c) { return c.id; });
      var gone = liveCommands(room).filter(function (c) { return myTarget(c).anchor > nowS - 1 && newIds.indexOf(c.id) < 0; });
      if (gone.some(function (c) { return myTarget(c).mine; })) { beepCancelled(); window.toast(tk("order_cancelled")); }
    }
    room = r; if (firstSnapshot) sendDeviceStatus(); if (!pendingStageMutation) pumpStageQueue(); reconcileCommanderMarchState(nextPlayers); setNet(true); if (pendingUnlock && r.updatedBy && r.updatedBy === pendingTok) unlockedOK(); presenceN = r.presence || 1; paintChrome(); paintHero(); syncMap(); renderRoster(); if (settledStageFocusPid) restoreRosterFocus(settledStageFocusPid); scheduleAllCues(); paintAudioStatus();
    var ew = (r.config && r.config.enemyWhales) || [], key = JSON.stringify(ew);
    if (key !== lastWhalesKey) {
      lastWhalesKey = key; enemyWhales = ew; setBadge(); if (viewMode === "defense") renderDefense();   // only re-render (resets the radar) when the whale list actually changed, not on every heartbeat
      if (roomPw && !adminDirty && !$("console").classList.contains("hide")) { adminEnemies = ew.map(function (e) { return { name: e.name, mm: e.mm, ss: e.ss }; }); renderAdmin(); }   // pristine editor follows the published truth (a reload must never wipe the squad's whales)
    }
    // publish ack = the server echoing OUR by-token (never "the count looks right" — a stale broadcast could fake that)
    if (pendingPubTok && r.updatedBy === pendingPubTok) { pendingPubTok = null; pendingPubWhales = null; var pm = $("pubMsg"); if (pm) pm.innerHTML = '<span style="color:var(--green-deep)">' + tk("pub_ok") + '</span>'; window.toast(tk("pub_ok")); }
    // staged pre-warning must be perceivable even from the Defense tab / a pocketed phone
    var sm = stagedForMe(), sk = sm ? (sm.kingdom + ":" + sm.role) : "";
    if (sk && sk !== lastStagedKey) { if (viewMode === "defense") setView("attack"); fireAlert(); try { navigator.vibrate && navigator.vibrate([80, 40, 80]); } catch (e) {} }
    lastStagedKey = sk;
    // my march changed (this device or another of mine) → defense cues recompute
    var mm = (r.players && r.players[myPid] && r.players[myPid].march) || 0;
    if (mm !== lastMyMarch) { lastMyMarch = mm; if (viewMode === "defense") renderDefense(); }
    safeUpdateFlush();
  }

  /* ---------- fill ---------- */
  function setMarchUI(s) { s = Math.max(5, Math.min(180, Math.round(s || 90))); $("marchRange").value = s; $("marchBig").textContent = marchTouched ? window.mmss(s) : "—:—"; var sb = $("saveBtn"); if (sb) sb.classList.toggle("dim", !marchTouched); }   // dim, NOT disabled: a native-disabled button swallows the tap and the stuck user gets zero feedback
  function showProfileDraft(me) { marchTouched = true; $("fillCard").classList.remove("hide"); $("youChip").classList.add("hide"); showExistingIdentity(me); setMarchUI(me.march); }
  function showInCard(me) { draftActive = false; marchTouched = true; $("fillCard").classList.add("hide"); $("youChip").classList.remove("hide"); $("youName").textContent = tk("you") + " · " + me.name; $("youMarch").textContent = window.mmss(me.march); showExistingIdentity(me); setMarchUI(me.march); }
  function isFilled() { return !!myPid; }

  /* ---------- commander unlock ---------- */
  function doUnlock() {
    var pw = $("pwInput").value; if (!pw) return;
    roomPw = pw; pendingUnlock = true; pendingTok = "u" + Date.now();
    var msg = $("pwMsg"); if (msg) { msg.textContent = tk("unlocking"); msg.className = "pwmsg"; }
    // send a unique 'by' token; the console opens only when onState echoes it back (a POSITIVE server ack), never on a timer — a wrong password is rejected and never opens
    sock.send({ t: "setConfig", password: pw, config: (room && room.config) || {}, baseUpdatedAt: room ? room.updatedAt : undefined, by: pendingTok });
    setTimeout(function () { if (pendingUnlock) { pendingUnlock = false; roomPw = ""; var m2 = $("pwMsg"); if (m2) { m2.textContent = tk("notconn"); m2.className = "pwmsg err"; } } }, 4000);   // no ack in 4s → fail, don't open
  }
  function unlockedOK() { pendingUnlock = false; $("pwOvl").classList.remove("show"); openCmd(); wr(LS("pw"), roomPw); }
  function openCmd() { document.body.classList.add("cmdmode"); $("cmdGate").classList.add("hide"); $("console").classList.remove("hide"); $("chrome").classList.add("cmd"); renderKingdomPick(); renderLead(); if (room) renderRoster(); adminDirty = false; adminEnemies = ((room && room.config && room.config.enemyWhales) || []).map(function (e) { return { name: e.name, mm: e.mm, ss: e.ss }; }); renderAdmin(); }
  function lockCmd() { document.body.classList.remove("cmdmode"); roomPw = ""; try { localStorage.removeItem(LS("pw")); } catch (e) {} $("cmdGate").classList.remove("hide"); $("console").classList.add("hide"); $("chrome").classList.remove("cmd"); }

  /* ---------- static text (one place; re-applied on lang change) ---------- */
  function renderStatics() {
    var set = function (id, k) { var e = $(id); if (e) e.textContent = tk(k); };
    set("t_join", "join"); set("t_ornew", "ornew"); set("t_joinhint", "joinhint"); set("t_room", "room"); set("joinBtn", "enter");
    set("t_fill", "fill"); set("t_fillsub", "fillsub"); set("t_march", "marchlab"); set("saveBtn", "save"); set("editBtn", "edit");
    set("t_cmd", "cmd"); set("t_kdhint", "kdhint"); set("t_leadhint", "leadhint"); set("t_defsethint", "defsethint"); set("idleWait", "idle_wait");
    syncIdentityControls(!!(myProfile && myProfile.pid));
    set("t_pwtitle", "pwtitle"); set("pwCancel", "pwcancel"); set("pwGo", "pwgo"); set("cmdUnlock", "cmdlink");
    set("bgTest", "bgtest2"); set("t_settings", "settings");
    set("t_tab_atk", "tab_atk"); set("t_tab_def", "tab_def"); set("t_dpanel", "dpanel"); set("t_dpanelhint", "dpanelhint"); set("t_addenemy", "addenemy"); set("t_pubwhales", "pubwhales");
    var cd = $("cstep_def"); if (cd) cd.textContent = L() ? "🛡️ Set incoming whales → publish" : "🛡️ 设敌鲸 → 发布";
    var dl = $("dleg"); if (dl) dl.innerHTML = L() ? "🔴 incoming<br>🛡️ your refill<br>🏰 castle shield" : "🔴 敌鲸来袭<br>🛡️ 你的补兵<br>🏰 王城护盾";
    $("t_firedbl").textContent = tk("firedbl"); setCancelLabel();
    paintAudioStatus();
    var mt = $("marchTip"); if (mt) mt.textContent = tk("marchtip2");
    var sg = $("soundGate"); if (sg) sg.textContent = tk("soundgate");
    var pw = $("pwInput"); if (pw) pw.placeholder = tk("pwph");
  }

  /* ---------- join gate ---------- */
  function showJoin() {
    $("joinCard").classList.remove("hide"); renderStatics();
    try { var lr = JSON.parse(localStorage.getItem("kingshoter_lastroom") || "null"); if (lr && lr.room) { $("lastWrap").classList.remove("hide"); $("lastBtn").textContent = tk("last") + " · " + lr.room; $("lastBtn").onclick = function () { location.href = "kvk.html?room=" + lr.room; }; } } catch (e) {}
    var go = function () { var r = $("jr").value.replace(/[^A-Za-z0-9_-]/g, ""); if (!r) return; location.href = "kvk.html?room=" + r; };
    $("joinBtn").onclick = go;
    $("jr").addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
  }

  /* ---------- wiring ---------- */
  function wireRoom() {
    if (myProfile) showProfileDraft(myProfile);
    wireIdentityControls();
    $("rosterSearch").addEventListener("input", function () { rosterQuery = this.value.toLowerCase().trim(); if (room) renderRoster(); });
    $("replaceWeak").onclick = function () { applyReplacement(pendingReplacementPid, "weak"); };
    $("replaceMain").onclick = function () { applyReplacement(pendingReplacementPid, "main"); };
    $("replaceCancel").onclick = function () { closeReplacement(true); };
    $("replaceOvl").addEventListener("click", function (event) { if (event.target === $("replaceOvl")) closeReplacement(true); });
    $("rosterActionsMenu").addEventListener("click", function (event) {
      var item = event.target.closest('[role="menuitem"]'); if (!item) return;
      event.preventDefault(); var pid = rosterActionsPid, origin = pid && document.querySelector('.roster-actions[data-pid="' + window.esc(pid) + '"]');
      if (item.getAttribute("aria-disabled") === "true") { $("rosterActionsExplanation").textContent = tk("remove_in_use"); return; }
      if (item.dataset.action === "edit-march") { closeRosterActionsMenu(false); openCommanderMarchEditor(pid, origin); }
      else if (item.dataset.action === "remove") openRemovalDialog(pid);
    });
    $("rosterActionsMenu").addEventListener("keydown", function (event) {
      var items = Array.from(this.querySelectorAll('[role="menuitem"]')); if (!items.length) return;
      var index = Math.max(0, items.indexOf(document.activeElement)), next = index;
      if (event.key === "Escape") { event.preventDefault(); closeRosterActionsMenu(true); return; }
      if (event.key === "ArrowDown") next = (index + 1) % items.length;
      else if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = items.length - 1;
      else return;
      event.preventDefault(); items.forEach(function (item, i) { item.tabIndex = i === next ? 0 : -1; }); items[next].focus();
    });
    document.addEventListener("pointerdown", function (event) {
      if (!rosterActionsPid || $("rosterActionsMenu").hidden) return;
      if ($("rosterActionsMenu").contains(event.target) || event.target.closest('.roster-actions[data-pid="' + window.esc(rosterActionsPid) + '"]')) return;
      closeRosterActionsMenu(true);
    });
    window.addEventListener("resize", positionRosterActionsMenu); window.addEventListener("scroll", positionRosterActionsMenu, true);
    $("removePlayerCancel").onclick = function () { closeRemovalDialog(true, false); };
    $("removePlayerConfirm").onclick = submitRemoval;
    $("removePlayerOvl").addEventListener("click", function (event) { if (event.target === $("removePlayerOvl")) closeRemovalDialog(true, false); });
    document.addEventListener("keydown", function (event) {
      if ($("removePlayerOvl").classList.contains("show")) {
        if (event.key === "Escape") { event.preventDefault(); closeRemovalDialog(true, false); return; }
        if (event.key !== "Tab") return;
        var removalControls = Array.from($("removePlayerOvl").querySelectorAll("button:not([disabled])"));
        if (!removalControls.length) { event.preventDefault(); return; }
        var removalFirst = removalControls[0], removalLast = removalControls[removalControls.length - 1];
        if (event.shiftKey && document.activeElement === removalFirst) { event.preventDefault(); removalLast.focus(); }
        else if (!event.shiftKey && document.activeElement === removalLast) { event.preventDefault(); removalFirst.focus(); }
        return;
      }
      if (!$("replaceOvl").classList.contains("show")) return;
      if (event.key === "Escape") { event.preventDefault(); closeReplacement(true); return; }
      if (event.key !== "Tab") return;
      var controls = Array.from($("replaceOvl").querySelectorAll("button:not([hidden]):not([disabled])"));
      if (!controls.length) { event.preventDefault(); return; }
      var first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    $("commanderMarchInput").addEventListener("input", function () {
      commanderMarchDraft = this.value; commanderMarchDirty = true;
      if (commanderMarchStatus === "invalid" || commanderMarchStatus === "unsaved" || commanderMarchStatus === "saved") { commanderMarchStatus = ""; commanderMarchStatusTone = ""; }
      renderCommanderMarchEditor();
    });
    $("commanderMarchEditor").addEventListener("submit", function (event) { event.preventDefault(); saveCommanderMarch(); });
    $("commanderMarchEditor").querySelectorAll("[data-march-delta]").forEach(function (button) {
      button.onclick = function () {
        if (pendingCommanderMarchMutation || commanderMarchStale) return;
        var current = parseMMSS(commanderMarchDraft), latest = commanderMarchLatest;
        var next = Math.max(5, Math.min(180, (current == null ? (latest ? latest.march : 90) : current) + Number(button.dataset.marchDelta || 0)));
        commanderMarchDraft = window.mmss(next); commanderMarchDirty = true;
        if (commanderMarchStatus === "invalid" || commanderMarchStatus === "unsaved") { commanderMarchStatus = ""; commanderMarchStatusTone = ""; }
        renderCommanderMarchEditor(); $("commanderMarchInput").focus(); $("commanderMarchInput").select();
      };
    });
    $("commanderMarchCancel").onclick = function () { if (!pendingCommanderMarchMutation && !commanderMarchStale) closeCommanderMarchEditor(true); };
    $("commanderMarchAdopt").onclick = function () {
      if (pendingCommanderMarchMutation || !commanderMarchLatest) return;
      commanderMarchDraft = window.mmss(commanderMarchLatest.march); commanderMarchDirty = false; closeCommanderMarchEditor(true);
    };
    $("commanderMarchRetry").onclick = function () { if (!pendingCommanderMarchMutation && commanderMarchLatest) sendCommanderMarch(commanderMarchLatest.revision); };
    document.addEventListener("keydown", function (event) {
      if (event.defaultPrevented || event.key !== "Escape" || $("commanderMarchEditor").classList.contains("hide") || $("replaceOvl").classList.contains("show")) return;
      event.preventDefault(); if (!pendingCommanderMarchMutation && !commanderMarchStale) closeCommanderMarchEditor(true);
    });
    $("saveBtn").onclick = function () {
      var identityValue = $("pid").value, resolvedName = $("nameOut").dataset.name || "";
      cancelIdentityLookup();
      var existingIdentity = !!(myProfile && myProfile.pid), mode = existingIdentity ? (myProfile.identityMode || "playerId") : identityMode;
      var pid = existingIdentity ? myProfile.pid : "", name = existingIdentity ? myProfile.name : "";
      if (!existingIdentity && mode === "nickname") {
        name = normalizeNickname(identityValue);
        if (!name) { window.toast(tk("invalid_nickname")); return; }
        $("pid").value = name;
        pid = nicknameDraftRoutingKey || (nicknameDraftRoutingKey = createNicknameRoutingKey());
      } else if (!existingIdentity) {
        pid = identityValue.replace(/\D/g, "").slice(0, 16); $("pid").value = pid;
        if (!pid) { window.toast("Player ID"); return; }
        name = resolvedName || pid;
      }
      if (!marchTouched) { window.toast(tk("marchfirst")); if (window.gsap) gsap.fromTo($("marchBig"), { scale: 1.18, color: "#e05a5a" }, { scale: 1, clearProps: "all", duration: .5 }); return; }   // the slider LOOKS set (thumb mid-track) but isn't — explain the invisible rule instead of a dead tap
      var march = +$("marchRange").value, ok;
      draftActive = true;
      if (myProfile && myProfile.pid && ownPlayerSeen) {
        if (pendingMarchMutation) return;
        pendingMarchMutation = {
          mutationId: crypto.randomUUID(), pid: myProfile.pid, requestedMarch: march,
          baseRevision: Number.isInteger(myProfile.marchRevision) ? myProfile.marchRevision : 0,
          ackSeen: false, stateSeen: false, draftVersion: draftVersion
        };
        ok = sock.send({
          t: "updateOwnMarch", mutationId: pendingMarchMutation.mutationId, pid: pendingMarchMutation.pid,
          march: pendingMarchMutation.requestedMarch, baseRevision: pendingMarchMutation.baseRevision
        });
        if (!ok) { pendingMarchMutation = null; window.toast(tk("notconn")); }
        return;
      }
      if (registrationPending && myProfile && !ownPlayerSeen) return;
      if (pendingRegistrationProfile) return;
      pendingRegistrationProfile = { pid: pid, name: name, march: march, marchRevision: 0, identityMode: mode, draftVersion: draftVersion };
      ok = registerPendingProfile();
      if (!ok) return;
      if (room && room.players && room.players[pid]) acceptPendingRegistration(room.players[pid]);
    };
    $("editBtn").onclick = function () { markDraft(); if (myProfile) showExistingIdentity(myProfile); $("youChip").classList.add("hide"); $("fillCard").classList.remove("hide"); };
    $("marchRange").addEventListener("input", function () { markDraft(); marchTouched = true; setMarchUI(+this.value); });
    $("marchMinus").onclick = function () { markDraft(); marchTouched = true; setMarchUI(+$("marchRange").value - 1); };
    $("marchPlus").onclick = function () { markDraft(); marchTouched = true; setMarchUI(+$("marchRange").value + 1); };
    if (!myPid) setMarchUI(90);   // only seed the default for a brand-new user; a returning user's saved march was already set by showInCard (don't clobber it to 1:30)
    $("cmdUnlock").onclick = function () {
      // a FRESH room has no password yet — the first string typed here silently becomes it (room.js setConfig).
      // The modal must say "you're SETTING a password", or the first commander is stuck asking "what password?"
      var first = !!(room && !room.hasPw);
      $("t_pwtitle").textContent = tk(first ? "pwtitle_new" : "pwtitle");
      $("pwInput").placeholder = tk(first ? "pwph_new" : "pwph");
      $("pwGo").textContent = tk(first ? "pwgo_new" : "pwgo");
      var hn = $("pwHint"); if (hn) hn.textContent = first ? tk("pwhint_new") : "";
      $("pwInput").value = ""; $("pwOvl").classList.add("show"); setTimeout(function () { $("pwInput").focus(); }, 50);
    };
    $("radar").addEventListener("click", function (e) {   // empty-state "copy room link" (the SVG re-renders, so delegate)
      if (!e.target || e.target.id !== "copyLinkT") return;
      var url = location.origin + location.pathname + "?room=" + ROOM;
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(function () { window.toast(tk("copied")); }, function () { window.prompt("URL", url); });
      else window.prompt("URL", url);
    });
    $("pwCancel").onclick = function () { $("pwOvl").classList.remove("show"); };
    $("pwGo").onclick = doUnlock; $("pwInput").addEventListener("keydown", function (e) { if (e.key === "Enter") doUnlock(); });
    try { var sp = localStorage.getItem(LS("pw")); if (sp) { roomPw = sp; openCmd(); } } catch (e) {}
    tapFire($("fireDouble"), $("t_firedbl"), "firedbl", fireDouble);
    var cancelArmed = 0;
    $("cancelBtn").onclick = function () { var n = Date.now(); if (cancelArmed && n - cancelArmed < 3000) { cancelArmed = 0; var ok = sock.send({ t: "cmd", password: roomPw, cmd: { type: "cancel", kingdom: fireKingdom } }); window.toast(ok ? tk("cancelled") : tk("notconn")); } else { cancelArmed = n; window.toast(tk("cancelq")); } };
    $("soundGate").onclick = function () { enableSound(false); };
    if (soundReady) $("soundGate").style.display = "none";
    if ($("audioStatus")) $("audioStatus").onclick = function () { enableSound(false); };   // tap the status chip to re-arm / resume a paused session
    if ($("bgTest")) $("bgTest").onclick = function () { enableSound(true); lockTest(); };
    // defense: view toggle + commander enemy-whale editor + radar playback
    if ($("tabAtk")) $("tabAtk").onclick = function () { setView("attack"); };
    if ($("tabDef")) $("tabDef").onclick = function () { setView("defense"); };
    if ($("addEnemy")) $("addEnemy").onclick = function () { if (adminEnemies.length >= 30) return; adminDirty = true; adminEnemies.push({ name: tk("d_enemy") + String.fromCharCode(65 + adminEnemies.length), mm: 1, ss: 0 }); renderAdmin(); };
    if ($("pubWhales")) $("pubWhales").onclick = publishWhales;
    if ($("dpp")) $("dpp").onclick = function () { dPlaying = !dPlaying; $("dpp").textContent = dPlaying ? "⏸" : "▶"; dLastTs = null; };
    if ($("dscrub")) $("dscrub").oninput = function () { dPlaying = false; $("dpp").textContent = "▶"; if (dAnim && dAnim.w1) { dAnim.p = (+$("dscrub").value) / 1000; dAnim.holdUntil = 0; dTNow = dInvmap(dAnim.p, dAnim.w1); dRenderAnim(dTNow, null, 0); } };
    renderKingdomPick(); renderLead();
    window.onLangChange = function () { mapS.mode = null; lastWhalesKey = ""; renderStatics(); renderKingdomPick(); renderLead(); if (room) onState(room); if (viewMode === "defense") renderDefense(); if (!$("console").classList.contains("hide")) renderAdmin(); $("roomlabel").textContent = "🏠 " + ROOM; };
  }

  /* ---------- bootstrap (after every definition; no fragile load-order) ---------- */
  window.startClock(); beginClockSync(); setInterval(beginClockSync, 180000); safeUpdateStart();
  if (!ROOM) { window.onLangChange = function () { renderStatics(); showJoin(); }; showJoin(); window.initI18n(); return; }   // join gate re-translates on 中/EN toggle too
  try { localStorage.setItem("kingshoter_lastroom", JSON.stringify({ room: ROOM })); } catch (e) {}
  $("roomView").classList.remove("hide");
  $("roomView").classList.add("presound");   // everything below the sound switch is dimmed/locked until step ① is done — no auto-prime, the gesture must be the sound button
  $("roomlabel").textContent = "🏠 " + ROOM;
  window.initI18n(); renderStatics(); connect(); wireRoom(); wireDefenseTruth();
  paintHero();   // the forced flow (dim-lock + fill card) IS the onboarding; the commander tour runs once on first unlock
})();
