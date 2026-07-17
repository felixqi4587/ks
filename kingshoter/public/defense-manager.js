(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DefenseManager = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var MANAGER_STATUS_INTERVAL_MS = 20000;

  function copy(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function mergeProfileProjection(base, patch) {
    base = base && typeof base === "object" ? base : {};
    patch = patch && typeof patch === "object" ? patch : {};
    var merged = Object.assign({}, base, copy(patch));
    if (Object.prototype.hasOwnProperty.call(patch, "activeRound")) {
      merged.activeRound = patch.activeRound == null ? null : Object.assign(
        {}, base.activeRound && typeof base.activeRound === "object" ? base.activeRound : {},
        copy(patch.activeRound)
      );
    }
    return merged;
  }

  function finiteInteger(value) {
    return Number.isSafeInteger(Number(value)) ? Number(value) : null;
  }

  function nonnegativeCount(source, key, fallback) {
    var value = finiteInteger(source && source[key]);
    return value != null && value >= 0 ? value : fallback;
  }

  function normalize(value) {
    return String(value == null ? "" : value).trim().toLocaleLowerCase();
  }

  function compareText(left, right) {
    return String(left || "").localeCompare(String(right || ""), undefined, {
      sensitivity: "base", numeric: true
    });
  }

  function profileName(profile) {
    return String(profile && (profile.name || profile.playerId || profile.pid) || "");
  }

  function playerFlags(profile) {
    profile = profile || {};
    var active = profile.activeRound || null;
    var connected = Number(profile.connectedDevices) > 0;
    var ready = Number(profile.readyDevices) > 0;
    var valid = Number.isSafeInteger(Number(profile.march)) && Number(profile.march) >= 5 && Number(profile.march) <= 120;
    var targeted = !!active && active.targeted === true;
    var tooLate = !!active && (active.tooLate === true || String(active.outcome || "") === "too_late");
    var delivered = !!active && active.deliveredScheduled === true;
    return Object.freeze({
      ready: ready,
      red: connected && !ready,
      offline: !connected,
      invalid: !valid || (!!active && active.validAtAcceptance === false),
      unconfirmed: targeted && !tooLate && !delivered,
      too_late: tooLate
    });
  }

  function projectPlayers(rows, options) {
    rows = Array.isArray(rows) ? rows : [];
    options = options || {};
    var query = normalize(options.query);
    var filter = String(options.filter || "all");
    var sort = String(options.sort || (options.active ? "go" : "name"));
    var names = new Map();
    rows.forEach(function (profile) {
      var key = normalize(profileName(profile));
      if (key) names.set(key, (names.get(key) || 0) + 1);
    });
    var result = rows.map(function (profile) {
      var next = copy(profile);
      var flags = playerFlags(profile);
      next.flags = flags;
      next.displayLabel = profileName(profile);
      if ((names.get(normalize(next.displayLabel)) || 0) > 1) {
        next.displayLabel += " · " + String(profile.pid || "");
      }
      return next;
    }).filter(function (profile) {
      if (query) {
        var searchable = normalize([
          profile.name, profile.playerId, profile.pid, profile.displayLabel
        ].filter(Boolean).join(" "));
        if (searchable.indexOf(query) === -1) return false;
      }
      return filter === "all" || profile.flags[filter] === true;
    });
    result.sort(function (left, right) {
      if (sort === "march") {
        var leftMarch = Number.isFinite(Number(left.march)) ? Number(left.march) : Infinity;
        var rightMarch = Number.isFinite(Number(right.march)) ? Number(right.march) : Infinity;
        return leftMarch - rightMarch || compareText(left.displayLabel, right.displayLabel) || compareText(left.pid, right.pid);
      }
      if (sort === "go") {
        var leftGo = left.activeRound && Number.isSafeInteger(left.activeRound.goAtMs)
          ? left.activeRound.goAtMs : Infinity;
        var rightGo = right.activeRound && Number.isSafeInteger(right.activeRound.goAtMs)
          ? right.activeRound.goAtMs : Infinity;
        return leftGo - rightGo || compareText(left.displayLabel, right.displayLabel) || compareText(left.pid, right.pid);
      }
      if (sort === "status") {
        function rank(row) {
          if (row.flags.too_late) return 0;
          if (row.flags.unconfirmed) return 1;
          if (row.flags.red) return 2;
          if (row.flags.offline) return 3;
          if (row.flags.invalid) return 4;
          return 5;
        }
        return rank(left) - rank(right) || compareText(left.displayLabel, right.displayLabel);
      }
      return compareText(left.displayLabel, right.displayLabel) || compareText(left.pid, right.pid);
    });
    return result;
  }

  function groupWaves(rows, nowMs) {
    var groups = new Map();
    (Array.isArray(rows) ? rows : []).forEach(function (profile) {
      var active = profile && profile.activeRound;
      if (!active || active.targeted !== true || active.tooLate === true || !Number.isSafeInteger(active.goAtMs)) return;
      var key = Math.floor(active.goAtMs / 1000) * 1000;
      var group = groups.get(key) || { goAtMs: key, profiles: 0, pids: [] };
      group.profiles += 1;
      group.pids.push(profile.pid);
      groups.set(key, group);
    });
    return Array.from(groups.values()).sort(function (left, right) {
      return left.goAtMs - right.goAtMs;
    }).map(function (wave) {
      return Object.freeze({
        goAtMs: wave.goAtMs,
        profiles: wave.profiles,
        pids: Object.freeze(wave.pids.slice()),
        remainingMs: Math.max(0, wave.goAtMs - Number(nowMs || 0))
      });
    });
  }

  function projectStatus(input) {
    input = input || {};
    var snapshot = input.snapshot || {};
    var active = snapshot.activeOrder || null;
    var rows = Array.isArray(input.players) ? input.players : [];
    var snapshotCounts = snapshot.counts || {};
    var waiting = {
      registered: nonnegativeCount(snapshotCounts, "registeredProfiles", rows.length),
      connected: nonnegativeCount(snapshotCounts, "connectedProfiles", 0),
      audioReady: nonnegativeCount(snapshotCounts, "audioReadyProfiles", 0),
      ready: nonnegativeCount(snapshotCounts, "readyProfiles", 0),
      red: 0,
      offline: 0,
      invalid: rows.filter(function (profile) { return playerFlags(profile).invalid; }).length
    };
    waiting.red = Math.max(0, waiting.connected - waiting.ready);
    waiting.offline = Math.max(0, waiting.registered - waiting.connected);
    var issues = [];
    if (active) {
      var activeCounts = active.counts || {};
      var activeDelivery = active.delivery || {};
      if (activeCounts.offlineRosterProfiles) {
        issues.push({ code: "offline_roster", count: activeCounts.offlineRosterProfiles });
      }
      if (activeCounts.invalidTimeProfiles) {
        issues.push({ code: "invalid_time", count: activeCounts.invalidTimeProfiles });
      }
      if (activeCounts.tooLateProfiles) {
        issues.push({ code: "too_late", count: activeCounts.tooLateProfiles });
      }
      if (activeDelivery.redUnconfirmedProfiles) {
        issues.push({ code: "red_unconfirmed", count: activeDelivery.redUnconfirmedProfiles });
      }
    } else {
      issues = [];
      if (waiting.red) issues.push({ code: "red_unconfirmed", count: waiting.red });
      if (waiting.offline) issues.push({ code: "offline_roster", count: waiting.offline });
      if (waiting.invalid) issues.push({ code: "invalid_time", count: waiting.invalid });
    }
    var distribution = copy(snapshot.distribution || []);
    if (!active) {
      var marchGroups = new Map();
      rows.forEach(function (profile) {
        var march = Number(profile && profile.march);
        if (!Number.isSafeInteger(march) || march < 5 || march > 120) return;
        marchGroups.set(march, (marchGroups.get(march) || 0) + 1);
      });
      distribution = Array.from(marchGroups.entries()).sort(function (left, right) {
        return left[0] - right[0];
      }).map(function (entry) { return { march: entry[0], profiles: entry[1] }; });
    }
    var waves = groupWaves(input.players, input.nowMs);
    return Object.freeze({
      active: !!active,
      expectedImpactAtMs: active && Number.isSafeInteger(active.enemyImpactAtMs)
        ? active.enemyImpactAtMs : null,
      counts: copy(active && active.counts || snapshot.counts || {}),
      delivery: copy(active && active.delivery || {}),
      waiting: Object.freeze(waiting),
      issues: issues,
      distribution: distribution,
      waves: Object.freeze(waves),
      nextWave: waves.find(function (wave) { return wave.goAtMs >= Number(input.nowMs || 0); }) || null,
      disclaimer: "Website delivery status only; the game does not report participation or response."
    });
  }

  function createDefenseManager(options) {
    options = options || {};
    var transport = options.transport;
    if (!transport || typeof transport.send !== "function") {
      throw new TypeError("Defense manager requires a transport");
    }
    var deviceId = typeof options.deviceId === "function" ? options.deviceId : function () { return ""; };
    var randomUUID = typeof options.randomUUID === "function" ? options.randomUUID : function () {
      return "m-" + Date.now() + "-" + Math.random().toString(16).slice(2);
    };
    var setIntervalFn = options.setInterval || setInterval;
    var clearIntervalFn = options.clearInterval || clearInterval;
    var setTimeoutFn = options.setTimeout || setTimeout;
    var clearTimeoutFn = options.clearTimeout || clearTimeout;
    var nowMs = typeof options.nowMs === "function"
      ? options.nowMs
      : (typeof transport.serverNowMs === "function" ? transport.serverNowMs : Date.now);
    var onStateChange = typeof options.onStateChange === "function" ? options.onStateChange : function () {};
    var ownsHandshake = options.ownsHandshake !== false;
    var disposed = false;
    var connected = false;
    var handshakeComplete = false;
    var authorized = false;
    var unlockPending = false;
    var password = "";
    var pendingPassword = "";
    var clock = { fresh: false, sampledAtMs: 0, offsetMs: 0 };
    var lease = { exact: false, managerClockFresh: false, untilMs: 0 };
    var leaseTimer = null;
    var leaseExpiryTimer = null;
    var snapshot = null;
    var config = { tapAnchorSeconds: 180, enemyMarchSeconds: null, revision: 0, updatedAt: null };
    var configDraft = { tapAnchorSeconds: 180, enemyMarchSeconds: null };
    var configDraftDirty = false;
    var configConflict = false;
    var activeOrder = null;
    var visiblePlayers = [];
    var visibleByPid = new Map();
    var rosterHydrated = false;
    var scan = null;
    var pendingConfig = null;
    var pendingFire = null;
    var pendingCancel = null;
    var pendingPlayerMutation = null;
    var lastError = null;

    function isConnected() {
      return connected && (typeof transport.connected !== "function" || transport.connected());
    }

    function send(message) {
      return isConnected() && transport.send(copy(message)) !== false;
    }

    function managerReady() {
      return isConnected() && authorized && lease.exact && lease.managerClockFresh === true &&
        clock.fresh === true && Number(lease.untilMs) > Number(nowMs());
    }

    function state() {
      return Object.freeze({
        connected: connected,
        handshakeComplete: handshakeComplete,
        authorized: authorized,
        unlockPending: unlockPending,
        managerReady: managerReady(),
        managerLeaseUntilMs: lease.untilMs,
        managerClockFresh: lease.managerClockFresh,
        snapshot: copy(snapshot),
        config: copy(config),
        configDraft: copy(configDraft),
        configConflict: configConflict,
        activeOrder: copy(activeOrder),
        players: copy(visiblePlayers),
        rosterHydrated: rosterHydrated,
        pendingConfig: copy(pendingConfig),
        pendingFire: copy(pendingFire),
        pendingCancel: copy(pendingCancel),
        pendingPlayerMutation: copy(pendingPlayerMutation),
        lastError: copy(lastError)
      });
    }

    function notify() {
      if (!disposed) onStateChange(state());
    }

    function stopLeaseLoop() {
      if (leaseTimer != null) clearIntervalFn(leaseTimer);
      leaseTimer = null;
    }

    function stopLeaseExpiry() {
      if (leaseExpiryTimer != null) clearTimeoutFn(leaseExpiryTimer);
      leaseExpiryTimer = null;
    }

    function armLeaseExpiry() {
      stopLeaseExpiry();
      if (!lease.exact || !Number.isSafeInteger(lease.untilMs) || lease.untilMs <= 0) return;
      var delay = Math.max(0, lease.untilMs - Number(nowMs()));
      leaseExpiryTimer = setTimeoutFn(function expireLease() {
        leaseExpiryTimer = null;
        if (Number(nowMs()) < lease.untilMs) {
          armLeaseExpiry();
          return;
        }
        lease.exact = false;
        notify();
      }, delay);
    }

    function sendManagerStatus() {
      if (!isConnected() || !authorized) return false;
      return send({
        t: "defenseManagerStatus",
        deviceId: deviceId(),
        clockFresh: clock.fresh === true,
        clockSampleAtMs: finiteInteger(clock.sampledAtMs) || 0,
        clockOffsetMs: finiteInteger(clock.offsetMs) || 0
      });
    }

    function startLeaseLoop() {
      stopLeaseLoop();
      if (!isConnected() || !authorized) return;
      sendManagerStatus();
      leaseTimer = setIntervalFn(sendManagerStatus, MANAGER_STATUS_INTERVAL_MS);
    }

    function requestPage(page) {
      page = finiteInteger(page);
      if (!page || page < 1 || !authorized || !isConnected()) return false;
      var message = { t: "getDefenseManagerPlayersPage", page: page };
      if (page > 1 && scan) {
        message.baseRosterRevision = scan.rosterRevision;
        message.baseOrderRevision = scan.orderRevision;
      }
      return send(message);
    }

    function beginScan(page) {
      if (!page || page.page !== 1) return false;
      scan = {
        rosterRevision: finiteInteger(page.baseRosterRevision),
        orderRevision: finiteInteger(page.baseOrderRevision),
        total: finiteInteger(page.total) || 0,
        totalPages: Math.max(1, finiteInteger(page.totalPages) || 1),
        pages: new Map(),
        journal: new Map()
      };
      if (snapshot) {
        snapshot.rosterRevision = scan.rosterRevision;
        snapshot.orderRevision = scan.orderRevision;
      }
      scan.pages.set(1, copy(page.items || []));
      rosterHydrated = false;
      if (scan.totalPages === 1) finishScan();
      else requestPage(2);
      return true;
    }

    function finishScan() {
      if (!scan || scan.pages.size !== scan.totalPages) return false;
      var rows = [];
      for (var page = 1; page <= scan.totalPages; page += 1) {
        if (!scan.pages.has(page)) return false;
        rows = rows.concat(scan.pages.get(page));
      }
      scan.journal.forEach(function (delta, pid) {
        var index = rows.findIndex(function (row) { return row.pid === pid; });
        if (delta.removed) {
          if (index >= 0) rows.splice(index, 1);
          return;
        }
        if (index >= 0) rows[index] = mergeProfileProjection(rows[index], delta.patch);
      });
      if (rows.length !== scan.total || new Set(rows.map(function (row) { return row.pid; })).size !== rows.length) {
        restartScan();
        return false;
      }
      visiblePlayers = rows;
      visibleByPid = new Map(rows.map(function (row) { return [row.pid, row]; }));
      rosterHydrated = true;
      scan = null;
      syncActiveDelivery(visiblePlayers);
      return true;
    }

    function acceptPage(frame) {
      var page = frame && frame.playersPage;
      if (!page || !Number.isSafeInteger(page.page)) return false;
      if (page.page === 1) return beginScan(page);
      if (!scan || page.baseRosterRevision !== scan.rosterRevision ||
          page.baseOrderRevision !== scan.orderRevision || page.total !== scan.total ||
          page.totalPages !== scan.totalPages || page.page > scan.totalPages) {
        restartScan();
        return false;
      }
      scan.pages.set(page.page, copy(page.items || []));
      if (page.page < scan.totalPages) requestPage(page.page + 1);
      else finishScan();
      return true;
    }

    function restartScan() {
      scan = null;
      rosterHydrated = false;
      requestPage(1);
    }

    function replaceVisible(profile) {
      if (!profile || !profile.pid) return false;
      var existing = visibleByPid.get(profile.pid);
      if (!existing) return false;
      var next = mergeProfileProjection(existing, profile);
      visibleByPid.set(profile.pid, next);
      visiblePlayers = visiblePlayers.map(function (row) { return row.pid === profile.pid ? next : row; });
      return true;
    }

    function syncActiveDelivery(rows) {
      if (!activeOrder || !Array.isArray(rows)) return false;
      var delivered = 0;
      var audioReady = 0;
      var red = 0;
      rows.forEach(function (profile) {
        var round = profile && profile.activeRound;
        if (!round || round.targeted !== true) return;
        if (round.deliveredScheduled === true) delivered += 1;
        if (round.audioReady === true) audioReady += 1;
        if (round.tooLate !== true && round.deliveredScheduled !== true) red += 1;
      });
      var delivery = Object.assign({}, activeOrder.delivery || {}, {
        deliveredScheduledProfiles: delivered,
        audioReadyProfiles: audioReady,
        redUnconfirmedProfiles: red
      });
      activeOrder = Object.assign({}, activeOrder, { delivery: delivery });
      if (snapshot && snapshot.activeOrder && snapshot.activeOrder.id === activeOrder.id &&
          snapshot.activeOrder.revision === activeOrder.revision) {
        snapshot.activeOrder = Object.assign({}, snapshot.activeOrder, { delivery: copy(delivery) });
      }
      return true;
    }

    function applyRealtimeDelta(pid, patch, removed) {
      pid = String(pid || "");
      if (!pid) return false;
      var handled = false;
      if (scan) {
        var current = scan.journal.get(pid) || { removed: false, patch: {} };
        if (removed) current = { removed: true, patch: null };
        else current = {
          removed: false,
          patch: mergeProfileProjection(current.removed ? {} : current.patch, patch || {})
        };
        scan.journal.set(pid, current);
        handled = true;
      }
      if (removed) {
        if (visibleByPid.has(pid)) {
          visiblePlayers = visiblePlayers.filter(function (row) { return row.pid !== pid; });
          visibleByPid.delete(pid);
          handled = true;
        }
      } else if (patch && replaceVisible(Object.assign({ pid: pid }, patch))) {
        handled = true;
      }
      return handled;
    }

    function adoptManagerState(message) {
      var firstAuthorization = !authorized;
      authorized = true;
      unlockPending = false;
      if (pendingPassword) {
        password = pendingPassword;
        pendingPassword = "";
      }
      snapshot = copy(message);
      activeOrder = copy(message.activeOrder || null);
      config = copy(message.config || config);
      if (!configDraftDirty) {
        configDraft = {
          tapAnchorSeconds: config.tapAnchorSeconds,
          enemyMarchSeconds: config.enemyMarchSeconds
        };
      }
      acceptPage(message);
      if (firstAuthorization && pendingConfig && pendingConfig.request) {
        send(Object.assign({}, pendingConfig.request, { password: password }));
      }
      if (firstAuthorization && pendingFire) {
        if (activeOrder) pendingFire = null;
        else if (pendingFire.request) send(Object.assign({}, pendingFire.request, { password: password }));
      }
      if (firstAuthorization && pendingCancel) {
        if (!activeOrder || activeOrder.id !== pendingCancel.orderId) pendingCancel = null;
        else if (pendingCancel.request) send(Object.assign({}, pendingCancel.request, { password: password }));
      }
      if (firstAuthorization && pendingPlayerMutation && pendingPlayerMutation.request) {
        send(Object.assign({}, pendingPlayerMutation.request, { password: password }));
      }
      if (firstAuthorization) startLeaseLoop();
      notify();
      return true;
    }

    function handlePage(message) {
      var handled = acceptPage(message);
      notify();
      return handled;
    }

    function handleProfileDelta(message) {
      if (pendingPlayerMutation && message.mutationId === pendingPlayerMutation.mutationId) {
        pendingPlayerMutation = null;
      }
      var currentRoster = snapshot && finiteInteger(snapshot.rosterRevision);
      if (finiteInteger(message.rosterRevision) !== null && currentRoster !== null &&
          message.rosterRevision !== currentRoster) {
        snapshot.rosterRevision = message.rosterRevision;
        restartScan();
      } else if (message.removed === true) {
        applyRealtimeDelta(message.pid, null, true);
      } else if (message.profile) {
        applyRealtimeDelta(message.profile.pid, message.profile, false);
      } else if (message.pending === true && message.pid) {
        applyRealtimeDelta(message.pid, { pendingRemoval: true }, false);
      }
      notify();
      return true;
    }

    function handlePresenceDelta(message) {
      var handled = applyRealtimeDelta(message.pid, {
        connectedDevices: Number(message.connectedDevices) || 0,
        audioReadyDevices: Number(message.audioReadyDevices) || 0,
        clockFreshDevices: Number(message.clockFreshDevices) || 0,
        readyDevices: Number(message.readyDevices) || 0
      }, false);
      if (!handled) return false;
      notify();
      return true;
    }

    function handleAck(message) {
      if (!activeOrder || !message.profileDelivery || message.orderId !== activeOrder.id ||
          finiteInteger(message.revision) !== finiteInteger(activeOrder.revision) ||
          (message.profileDelivery.pid && message.profileDelivery.pid !== message.pid)) return false;
      var handled = applyRealtimeDelta(message.pid, {
        activeRound: copy(message.profileDelivery)
      }, false);
      if (!handled) return false;
      if (rosterHydrated) syncActiveDelivery(visiblePlayers);
      notify();
      return true;
    }

    function handleError(message) {
      lastError = copy(message);
      if (message.source === "defenseUnlock") {
        authorized = false;
        unlockPending = false;
        pendingPassword = "";
        password = "";
        stopLeaseLoop();
      } else if (message.source === "setDefenseConfig" && pendingConfig &&
          (!message.mutationId || message.mutationId === pendingConfig.mutationId)) {
        pendingConfig = null;
        configConflict = message.error === "revision_conflict";
        if (Number.isSafeInteger(message.canonicalRevision)) config.revision = message.canonicalRevision;
      } else if (message.source === "fireDefense" && pendingFire &&
          (!message.mutationId || message.mutationId === pendingFire.mutationId)) {
        pendingFire = null;
      } else if (message.source === "cancelDefense" && pendingCancel &&
          (!message.mutationId || message.mutationId === pendingCancel.mutationId)) {
        pendingCancel = null;
      } else if ((message.source === "setDefensePlayerMarch" || message.source === "removeDefensePlayer") &&
          pendingPlayerMutation && (!message.mutationId || message.mutationId === pendingPlayerMutation.mutationId)) {
        pendingPlayerMutation = null;
      } else if (message.source === "getDefenseManagerPlayersPage" &&
          (message.error === "roster_conflict" || message.error === "order_conflict")) {
        restartScan();
      }
      notify();
      return true;
    }

    function handleMessage(message) {
      if (disposed || !message || typeof message !== "object") return false;
      if (message.t === "defenseState") {
        handshakeComplete = true;
        notify();
        return true;
      }
      if (message.t === "defenseManagerState") return adoptManagerState(message);
      if (message.t === "defenseManagerPlayersPage") return handlePage(message);
      if (message.t === "defenseManagerStatusSaved") {
        lease = {
          exact: true,
          managerClockFresh: message.managerClockFresh === true,
          untilMs: finiteInteger(message.managerLeaseUntilMs) || 0
        };
        armLeaseExpiry();
        notify();
        return true;
      }
      if (message.t === "defenseConfigSaved") {
        if (!pendingConfig || message.mutationId !== pendingConfig.mutationId) return false;
        config = copy(message.config || config);
        pendingConfig = null;
        configConflict = false;
        configDraftDirty = false;
        configDraft = {
          tapAnchorSeconds: config.tapAnchorSeconds,
          enemyMarchSeconds: config.enemyMarchSeconds
        };
        notify();
        return true;
      }
      if (message.t === "defenseProfileDelta") return handleProfileDelta(message);
      if (message.t === "defensePresenceDelta") return handlePresenceDelta(message);
      if (message.t === "defenseAckSaved") return handleAck(message);
      if (message.t === "defenseOrderAccepted") {
        var accepted = message.order;
        var acceptedRevision = accepted && finiteInteger(accepted.revision);
        var snapshotRevision = snapshot && finiteInteger(snapshot.orderRevision);
        var activeRevision = activeOrder && finiteInteger(activeOrder.revision);
        var canonicalRevision = Math.max(snapshotRevision == null ? -1 : snapshotRevision,
          activeRevision == null ? -1 : activeRevision);
        if (!accepted || !accepted.id || acceptedRevision == null || acceptedRevision < canonicalRevision ||
            (acceptedRevision === canonicalRevision && !activeOrder && snapshotRevision === canonicalRevision) ||
            (activeOrder && acceptedRevision === activeRevision && accepted.id !== activeOrder.id)) return false;
        activeOrder = activeOrder && activeOrder.id === accepted.id && activeRevision === acceptedRevision
          ? Object.assign({}, activeOrder, copy(accepted)) : copy(accepted);
        pendingFire = null;
        if (snapshot) snapshot.activeOrder = copy(activeOrder);
        if (snapshot && activeOrder && Number.isSafeInteger(activeOrder.revision)) {
          snapshot.orderRevision = activeOrder.revision;
        }
        restartScan();
        notify();
        return true;
      }
      if (message.t === "defenseOrderCancelled" || message.t === "defenseOrderCompleted") {
        if (!activeOrder || message.orderId !== activeOrder.id ||
            !Number.isSafeInteger(message.revision) || message.revision < activeOrder.revision) return false;
        activeOrder = null;
        if (snapshot) {
          snapshot.activeOrder = null;
          snapshot.orderRevision = message.revision;
        }
        if (pendingCancel && pendingCancel.orderId === message.orderId) pendingCancel = null;
        restartScan();
        notify();
        return true;
      }
      if (message.t === "error") return handleError(message);
      return false;
    }

    function connectionChanged(next) {
      next = next || {};
      connected = next.connected === true;
      handshakeComplete = false;
      authorized = false;
      unlockPending = false;
      lease = { exact: false, managerClockFresh: false, untilMs: 0 };
      stopLeaseLoop();
      stopLeaseExpiry();
      if (!password) pendingPassword = "";
      if (connected) {
        if (ownsHandshake) send({ t: "hello" });
        if (password) {
          unlockPending = true;
          send({ t: "defenseUnlock", password: password });
        }
      }
      notify();
    }

    function clockChanged(next) {
      next = next || {};
      var previous = clock;
      var updated = {
        fresh: next.fresh === true,
        sampledAtMs: finiteInteger(next.sampledAtMs) || 0,
        offsetMs: finiteInteger(next.offsetMs) || 0
      };
      clock = updated;
      if (authorized && isConnected() && (previous.fresh !== updated.fresh ||
          previous.sampledAtMs !== updated.sampledAtMs || previous.offsetMs !== updated.offsetMs)) {
        sendManagerStatus();
      }
      notify();
    }

    function unlock(value) {
      value = String(value == null ? "" : value);
      if (!value || value.length > 256) return { ok: false, error: "invalid_password" };
      if (!isConnected()) return { ok: false, error: "disconnected" };
      if (unlockPending) return { ok: false, error: "operation_pending" };
      unlockPending = true;
      pendingPassword = value;
      lastError = null;
      send({ t: "defenseUnlock", password: value });
      notify();
      return { ok: true };
    }

    function setConfigDraft(next) {
      next = next || {};
      configDraft = {
        tapAnchorSeconds: Number(next.tapAnchorSeconds),
        enemyMarchSeconds: next.enemyMarchSeconds === "" || next.enemyMarchSeconds == null
          ? null : Number(next.enemyMarchSeconds)
      };
      configDraftDirty = true;
      configConflict = false;
      notify();
    }

    function configValid() {
      return Number.isSafeInteger(configDraft.tapAnchorSeconds) && configDraft.tapAnchorSeconds >= 5 &&
        configDraft.tapAnchorSeconds <= 300 && Number.isSafeInteger(configDraft.enemyMarchSeconds) &&
        configDraft.enemyMarchSeconds >= 5 && configDraft.enemyMarchSeconds <= 120;
    }

    function saveConfig() {
      if (!authorized || !password) return { ok: false, error: "manager_locked" };
      if (pendingConfig) return { ok: false, error: "operation_pending" };
      if (activeOrder) return { ok: false, error: "order_active" };
      if (!configValid()) return { ok: false, error: "invalid_config" };
      var mutationId = randomUUID();
      var request = {
        t: "setDefenseConfig", mutationId: mutationId,
        baseRevision: Number(config.revision) || 0,
        tapAnchorSeconds: configDraft.tapAnchorSeconds,
        enemyMarchSeconds: configDraft.enemyMarchSeconds
      };
      pendingConfig = { mutationId: mutationId, draft: copy(configDraft), request: copy(request) };
      lastError = null;
      send(Object.assign({}, request, { password: password }));
      notify();
      return { ok: true, mutationId: mutationId };
    }

    function fire() {
      if (!authorized || !password) return { ok: false, error: "manager_locked" };
      if (activeOrder) return { ok: false, error: "order_active" };
      if (pendingFire) return { ok: false, error: "operation_pending" };
      if (!managerReady()) return { ok: false, error: "manager_not_ready" };
      if (pendingConfig || configConflict || configDraftDirty ||
          !Number.isSafeInteger(config.enemyMarchSeconds)) return { ok: false, error: "config_not_saved" };
      var mutationId = randomUUID();
      var request = {
        t: "fireDefense", mutationId: mutationId,
        configRevision: Number(config.revision) || 0,
        signalAtMs: Math.round(nowMs())
      };
      pendingFire = { mutationId: mutationId, signalAtMs: request.signalAtMs, request: copy(request) };
      lastError = null;
      send(Object.assign({}, request, { password: password }));
      notify();
      return { ok: true, mutationId: mutationId };
    }

    function cancel(confirmed) {
      if (confirmed !== true) return { ok: false, error: "confirmation_required" };
      if (!activeOrder) return { ok: false, error: "no_active_order" };
      if (pendingCancel) return { ok: false, error: "operation_pending" };
      var mutationId = randomUUID();
      var request = {
        t: "cancelDefense", mutationId: mutationId,
        orderId: activeOrder.id, orderRevision: activeOrder.revision
      };
      pendingCancel = { mutationId: mutationId, orderId: activeOrder.id, request: copy(request) };
      send(Object.assign({}, request, { password: password }));
      notify();
      return { ok: true, mutationId: mutationId };
    }

    function findPlayer(pid) {
      return visibleByPid.get(String(pid || "")) || null;
    }

    function setPlayerMarch(pid, march) {
      var profile = findPlayer(pid);
      march = Number(march);
      if (!profile) return { ok: false, error: "player_not_found" };
      if (!Number.isSafeInteger(march) || march < 5 || march > 120) return { ok: false, error: "invalid_march" };
      if (pendingPlayerMutation) return { ok: false, error: "operation_pending" };
      var mutationId = randomUUID();
      var request = {
        t: "setDefensePlayerMarch", mutationId: mutationId,
        pid: profile.pid, profileGeneration: profile.profileGeneration,
        baseRevision: Number(profile.revision) || 0, march: march
      };
      pendingPlayerMutation = { mutationId: mutationId, pid: profile.pid, kind: "edit", request: copy(request) };
      send(Object.assign({}, request, { password: password }));
      notify();
      return { ok: true, mutationId: mutationId };
    }

    function removePlayer(pid, confirmed) {
      if (confirmed !== true) return { ok: false, error: "confirmation_required" };
      var profile = findPlayer(pid);
      if (!profile) return { ok: false, error: "player_not_found" };
      if (pendingPlayerMutation) return { ok: false, error: "operation_pending" };
      var orderRevision = snapshot && finiteInteger(snapshot.orderRevision);
      if (orderRevision == null || orderRevision < 0) return { ok: false, error: "state_unavailable" };
      var mutationId = randomUUID();
      var request = {
        t: "removeDefensePlayer", mutationId: mutationId,
        pid: profile.pid, profileGeneration: profile.profileGeneration,
        baseRevision: orderRevision
      };
      pendingPlayerMutation = { mutationId: mutationId, pid: profile.pid, kind: "remove", request: copy(request) };
      send(Object.assign({}, request, { password: password }));
      notify();
      return { ok: true, mutationId: mutationId };
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      stopLeaseLoop();
      stopLeaseExpiry();
      password = "";
      pendingPassword = "";
    }

    return Object.freeze({
      state: state,
      handleMessage: handleMessage,
      connectionChanged: connectionChanged,
      clockChanged: clockChanged,
      unlock: unlock,
      sendManagerStatus: sendManagerStatus,
      requestPage: requestPage,
      setConfigDraft: setConfigDraft,
      saveConfig: saveConfig,
      fire: fire,
      cancel: cancel,
      setPlayerMarch: setPlayerMarch,
      removePlayer: removePlayer,
      dispose: dispose
    });
  }

  var MANAGER_STRINGS = Object.freeze({
    en: Object.freeze({
      locked: "Manager locked",
      connecting: "Manager connected · syncing clock",
      ready: "Manager connected · clock synced",
      reconnecting: "Manager connection lost · reconnecting",
      unlockFailed: "Could not unlock the console.",
      configSaved: "Timing saved.",
      configConflict: "Timing changed elsewhere. Your draft is preserved; review and save again.",
      invalidConfig: "Use 0:05–5:00 for the enemy countdown and 0:05–2:00 for enemy march.",
      pending: "Waiting for room confirmation…",
      playersLoading: "Loading players…",
      playersCount: function (visible, total) { return visible + " shown · " + total + " loaded"; },
      empty: "No players match these filters.",
      managerNotReady: "Wait for a confirmed manager connection and fresh clock.",
      saveFirst: "Save valid timing before firing.",
      active: "Defense order active",
      waiting: "Waiting for the next Defense order",
      yourCue: "Your cue",
      now: "Now",
      nextRound: "Change applies next round",
      removePending: "Removal is queued until this round ends.",
      editSaved: "March time saved.",
      removed: "Player removal confirmed.",
      noIssues: "No website-state exceptions right now.",
      noWaves: "No future website alert waves.",
      metricTargeted: "Targeted",
      metricRegistered: "Registered",
      metricScheduled: "Scheduled",
      metricAudioReady: "Audio ready",
      metricRed: "Red / unconfirmed",
      metricImpact: "Expected impact",
      metricNext: "Next alert",
      issueOffline: "Offline at acceptance",
      issueInvalid: "Invalid march time",
      issueTooLate: "Too late",
      issueRed: "Red / unconfirmed",
      alertWaves: "Alert waves",
      marchDistribution: "March distribution",
      playerCount: function (count) { return count + (count === 1 ? " player" : " players"); },
      tapWhen: function (value) { return "Tap when enemy rally shows " + value; },
      factWebsite: "Website status",
      factMarch: "March",
      factConnected: "Connected devices",
      factAudioReady: "Audio-ready devices",
      factGo: "Round GO",
      playerIdLabel: "Player ID",
      nicknameLabel: "Nickname",
      statusReady: "Ready",
      statusRed: "Red · alert not confirmed",
      statusOffline: "Offline",
      statusInvalid: "Invalid march time",
      statusUnconfirmed: "Order unconfirmed",
      statusTooLate: "Too late",
      statusWaiting: "Waiting",
      ui: Object.freeze({
        console: "Defense Console",
        collapseConsole: "Collapse Defense Console",
        status: "Status",
        manage: "Manage",
        enemyCountdown: "Enemy rally countdown",
        enemyMarch: "Enemy march time",
        required: "Required",
        saveTiming: "Save timing",
        registered: "registered",
        readyShort: "ready",
        redShort: "red",
        websiteReadiness: "Defense website readiness",
        deliveryShort: "Website delivery status only · the game does not report participation.",
        cancelOrder: "Cancel Defense Order",
        command: "Command",
        management: "Defense management",
        managerViews: "Defense manager views",
        players: "Players",
        needsAttention: "Needs attention",
        deliveryFull: "Website delivery status only; the game does not report participation or response.",
        searchPlayers: "Search players",
        searchPlaceholder: "Search Player ID or nickname",
        filter: "Filter",
        filterAll: "All",
        filterReady: "Ready",
        filterRed: "Red",
        filterOffline: "Offline",
        filterInvalid: "Invalid time",
        filterUnconfirmed: "Unconfirmed",
        filterTooLate: "Too late",
        sort: "Sort",
        sortName: "Name",
        sortMarch: "March",
        sortStatus: "Status",
        sortGo: "GO time",
        playersList: "Defense players",
        marchTime: "March time",
        saveMarch: "Save march time",
        removePlayer: "Remove player",
        unlockConsole: "Unlock Defense Console",
        roomPassword: "Room management password",
        cancel: "Cancel",
        unlock: "Unlock",
        cancelTitle: "Cancel this Defense order?",
        cancelCopy: "Future website alerts for this round will stop. Player profiles and timing stay saved.",
        keepOrder: "Keep order",
        cancelOrderShort: "Cancel order",
        removeTitle: "Remove this player?",
        removeCopy: "An active-round player is removed after this round; otherwise removal is immediate.",
        keepPlayer: "Keep player",
        remove: "Remove"
      })
    }),
    zh: Object.freeze({
      locked: "管理未解锁",
      connecting: "管理已连接 · 正在同步时间",
      ready: "管理已连接 · 时间已同步",
      reconnecting: "管理连接中断 · 正在重连",
      unlockFailed: "无法解锁指挥台。",
      configSaved: "时间已保存。",
      configConflict: "其他管理修改了时间。你的草稿已保留，请检查后再次保存。",
      invalidConfig: "敌方倒计时须为 0:05–5:00，敌方行军须为 0:05–2:00。",
      pending: "正在等待房间确认…",
      playersLoading: "正在载入玩家…",
      playersCount: function (visible, total) { return "显示 " + visible + " · 已载入 " + total; },
      empty: "没有符合当前筛选的玩家。",
      managerNotReady: "请等待管理连接和时间同步均被确认。",
      saveFirst: "请先保存有效时间再发令。",
      active: "本轮防守指令进行中",
      waiting: "等待下一轮防守指令",
      yourCue: "你的提示",
      now: "现在",
      nextRound: "修改将在下一轮生效",
      removePending: "本轮结束后再移除该玩家。",
      editSaved: "行军时间已保存。",
      removed: "玩家移除已确认。",
      noIssues: "当前没有网站状态异常。",
      noWaves: "没有未来的网站提醒波次。",
      metricTargeted: "本轮目标",
      metricRegistered: "已登记",
      metricScheduled: "已安排提醒",
      metricAudioReady: "音频就绪",
      metricRed: "红色 / 未确认",
      metricImpact: "预计落地",
      metricNext: "下一次提醒",
      issueOffline: "发令时离线",
      issueInvalid: "行军时间无效",
      issueTooLate: "已错过",
      issueRed: "红色 / 未确认",
      alertWaves: "提醒波次",
      marchDistribution: "行军时间分布",
      playerCount: function (count) { return count + " 名玩家"; },
      tapWhen: function (value) { return "敌方集结显示 " + value + " 时点击"; },
      factWebsite: "网站状态",
      factMarch: "行军时间",
      factConnected: "在线设备",
      factAudioReady: "音频就绪设备",
      factGo: "本轮提示时间",
      playerIdLabel: "玩家 ID",
      nicknameLabel: "昵称",
      statusReady: "已准备",
      statusRed: "红色 · 提醒未确认",
      statusOffline: "离线",
      statusInvalid: "行军时间无效",
      statusUnconfirmed: "指令未确认",
      statusTooLate: "已错过",
      statusWaiting: "等待中",
      ui: Object.freeze({
        console: "防守指挥台",
        collapseConsole: "收起防守指挥台",
        status: "状态",
        manage: "管理",
        enemyCountdown: "敌方集结剩余时间",
        enemyMarch: "敌方行军时间",
        required: "必填",
        saveTiming: "保存时间",
        registered: "已登记",
        readyShort: "已准备",
        redShort: "红色",
        websiteReadiness: "防守网站就绪状态",
        deliveryShort: "仅显示网站送达状态 · 游戏不会回传参与数据。",
        cancelOrder: "取消本轮防守指令",
        command: "发令",
        management: "防守管理",
        managerViews: "防守管理视图",
        players: "玩家",
        needsAttention: "需要处理",
        deliveryFull: "仅显示网站送达状态；游戏不会回传参与或响应数据。",
        searchPlayers: "搜索玩家",
        searchPlaceholder: "搜索玩家 ID 或昵称",
        filter: "筛选",
        filterAll: "全部",
        filterReady: "已准备",
        filterRed: "红色",
        filterOffline: "离线",
        filterInvalid: "时间无效",
        filterUnconfirmed: "未确认",
        filterTooLate: "已错过",
        sort: "排序",
        sortName: "名字",
        sortMarch: "行军时间",
        sortStatus: "状态",
        sortGo: "提示时间",
        playersList: "防守玩家",
        marchTime: "行军时间",
        saveMarch: "保存行军时间",
        removePlayer: "移除玩家",
        unlockConsole: "解锁防守指挥台",
        roomPassword: "房间管理密码",
        cancel: "取消",
        unlock: "解锁",
        cancelTitle: "取消本轮防守指令？",
        cancelCopy: "本轮未来的网站提醒将停止；玩家资料和时间设置会保留。",
        keepOrder: "保留本轮",
        cancelOrderShort: "取消本轮",
        removeTitle: "移除该玩家？",
        removeCopy: "若玩家已进入本轮，会在本轮结束后移除；否则立即移除。",
        keepPlayer: "保留玩家",
        remove: "移除"
      })
    })
  });

  function formatSeconds(value) {
    value = Math.max(0, Math.round(Number(value) || 0));
    return Math.floor(value / 60) + ":" + String(value % 60).padStart(2, "0");
  }

  function formatClock(value) {
    if (!Number.isSafeInteger(value)) return "—:—:—";
    try {
      return new Date(value).toLocaleTimeString([], {
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
      });
    } catch (_) {
      return "—:—:—";
    }
  }

  function mountDefenseManager(options) {
    options = options || {};
    var win = options.window || (typeof window !== "undefined" ? window : null);
    var doc = options.document || (win && win.document);
    var transport = options.transport;
    var drawerApi = options.drawer || (win && win.BattleDrawer);
    var virtualListApi = options.virtualList || (win && win.VirtualList);
    if (!win || !doc || !transport || !drawerApi || typeof drawerApi.create !== "function" ||
        !virtualListApi || typeof virtualListApi.create !== "function") {
      throw new TypeError("Defense manager page dependencies are required");
    }
    var identityStore = options.identityStore;
    var getLanguage = typeof options.language === "function" ? options.language : function () { return "en"; };
    var language = getLanguage() === "zh" ? "zh" : "en";
    var text = MANAGER_STRINGS[language];
    var disposed = false;
    var personalState = null;
    var query = "";
    var filter = "all";
    var sort = "name";
    var selectedPid = "";
    var drawerState = "closed";
    var lastAnnouncement = "";
    var latestState = null;
    var activeDialog = null;
    var dialogReturnFocus = null;
    var inertSiblings = [];

    function element(id) { return doc.getElementById(id); }
    function setText(id, value) {
      var node = element(id);
      value = String(value == null ? "" : value);
      if (node && node.textContent !== value) node.textContent = value;
    }
    function announce(value) {
      value = String(value || "");
      if (!value || value === lastAnnouncement) return;
      lastAnnouncement = value;
      setText("defenseManagerLive", value);
    }
    function show(id, visible) {
      var node = element(id);
      if (node) node.hidden = !visible;
    }
    function applyStaticLanguage() {
      var ui = text.ui || {};
      Array.prototype.forEach.call(doc.querySelectorAll("[data-defense-manager-text]"), function (node) {
        var value = ui[node.getAttribute("data-defense-manager-text")];
        if (typeof value === "string") node.textContent = value;
      });
      Array.prototype.forEach.call(doc.querySelectorAll("[data-defense-manager-placeholder]"), function (node) {
        var value = ui[node.getAttribute("data-defense-manager-placeholder")];
        if (typeof value === "string") node.setAttribute("placeholder", value);
      });
      Array.prototype.forEach.call(doc.querySelectorAll("[data-defense-manager-aria]"), function (node) {
        var value = ui[node.getAttribute("data-defense-manager-aria")];
        if (typeof value === "string") node.setAttribute("aria-label", value);
      });
    }
    function restoreDialogBackground() {
      inertSiblings.forEach(function (entry) {
        if (entry.hadInert) entry.node.setAttribute("inert", "");
        else entry.node.removeAttribute("inert");
        entry.node.inert = entry.wasInert;
      });
      inertSiblings = [];
    }
    function setDialog(id, visible, focusId) {
      var dialog = element(id);
      if (!dialog) return;
      if (!visible) {
        dialog.hidden = true;
        if (activeDialog === dialog) {
          activeDialog = null;
          restoreDialogBackground();
          var target = dialogReturnFocus;
          dialogReturnFocus = null;
          if (target && target.isConnected !== false && typeof target.focus === "function") {
            target.focus();
          }
        }
        return;
      }
      if (activeDialog && activeDialog !== dialog) setDialog(activeDialog.id, false);
      dialogReturnFocus = doc.activeElement;
      dialog.hidden = false;
      activeDialog = dialog;
      inertSiblings = [];
      Array.prototype.forEach.call(doc.body.children, function (node) {
        if (node === dialog || node.tagName === "SCRIPT" || node.tagName === "STYLE") return;
        inertSiblings.push({
          node: node,
          hadInert: node.hasAttribute("inert"),
          wasInert: node.inert === true
        });
        node.inert = true;
        node.setAttribute("inert", "");
      });
      if (focusId) win.setTimeout(function () {
        var target = element(focusId);
        if (target && typeof target.focus === "function") target.focus();
      }, 0);
    }

    function dialogFocusables(dialog) {
      if (!dialog || !dialog.querySelectorAll) return [];
      return Array.prototype.filter.call(dialog.querySelectorAll(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
        'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
      ), function (node) {
        return !node.hidden && !node.closest("[hidden]") &&
          (!node.getClientRects || node.getClientRects().length > 0);
      });
    }

    function dismissActiveDialog() {
      if (!activeDialog) return;
      var id = activeDialog.id;
      setDialog(id, false);
      if (id === "defenseManagerUnlock") {
        var entry = element("defenseConsoleEntry");
        if (entry) delete entry.dataset.managerOpening;
      }
    }

    function handleDialogKeydown(event) {
      if (!activeDialog) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismissActiveDialog();
        return;
      }
      if (event.key !== "Tab") return;
      var focusables = dialogFocusables(activeDialog);
      if (!focusables.length) {
        event.preventDefault();
        return;
      }
      var index = focusables.indexOf(doc.activeElement);
      var next = event.shiftKey
        ? (index <= 0 ? focusables.length - 1 : index - 1)
        : (index < 0 || index === focusables.length - 1 ? 0 : index + 1);
      event.preventDefault();
      focusables[next].focus();
    }
    doc.addEventListener("keydown", handleDialogKeydown, true);

    var drawer = drawerApi.create({
      root: element("defenseManagerDrawer"),
      handle: element("defenseManagerHandle"),
      background: element("defenseMain"),
      returnFocus: element("defenseConsoleEntry"),
      reducedMotion: win.matchMedia ? win.matchMedia("(prefers-reduced-motion: reduce)") : false,
      onStateChange: function (next) {
        drawerState = next;
        var manage = next === "manage";
        show("defenseManagerCommand", !manage);
        show("defenseManagerManage", manage);
        var entry = element("defenseConsoleEntry");
        if (entry) entry.setAttribute("aria-expanded", next === "closed" ? "false" : "true");
        if (manage) virtualList.remeasure();
      }
    });

    function deviceId() {
      return identityStore && typeof identityStore.deviceId === "function" ? identityStore.deviceId() : "";
    }

    var controller = createDefenseManager({
      transport: transport,
      deviceId: deviceId,
      randomUUID: options.randomUUID,
      setInterval: win.setInterval.bind(win),
      clearInterval: win.clearInterval.bind(win),
      setTimeout: win.setTimeout.bind(win),
      clearTimeout: win.clearTimeout.bind(win),
      nowMs: transport.serverNowMs,
      ownsHandshake: false,
      onStateChange: render
    });

    function statusLabel(profile) {
      var flags = profile.flags || playerFlags(profile);
      if (flags.too_late) return { label: text.statusTooLate, level: "danger" };
      if (flags.unconfirmed) return { label: text.statusUnconfirmed, level: "danger" };
      if (flags.invalid) return { label: text.statusInvalid, level: "warning" };
      if (flags.offline) return { label: text.statusOffline, level: "warning" };
      if (flags.red) return { label: text.statusRed, level: "danger" };
      if (flags.ready) return { label: text.statusReady, level: "ready" };
      return { label: text.statusWaiting, level: "warning" };
    }

    function renderPlayerCard(node, profile) {
      while (node.firstChild) node.removeChild(node.firstChild);
      var status = statusLabel(profile);
      node.className = "defense-manager__player-card";
      node.dataset.level = status.level;
      node.setAttribute("aria-label", profile.displayLabel + ", " + status.label);
      var name = doc.createElement("strong");
      name.textContent = profile.displayLabel;
      var timing = doc.createElement("span");
      timing.className = "defense-manager__player-time";
      var goAt = profile.activeRound && profile.activeRound.targeted && profile.activeRound.goAtMs;
      timing.textContent = goAt ? formatClock(goAt) : formatSeconds(profile.march);
      var stateNode = doc.createElement("span");
      stateNode.className = "defense-manager__player-state";
      stateNode.textContent = status.label;
      node.appendChild(name);
      node.appendChild(timing);
      node.appendChild(stateNode);
    }

    var virtualList = virtualListApi.create({
      container: element("defenseManagerPlayerList"),
      rowHeight: 76,
      columns: function (width) { return width >= 360 ? 2 : 1; },
      overscanRows: 3,
      key: function (profile) { return profile.pid; },
      renderItem: renderPlayerCard,
      onActivate: function (profile) {
        selectedPid = profile.pid;
        renderPlayerDetail(latestState);
        var back = element("defenseManagerPlayerBack");
        if (back && typeof back.focus === "function") back.focus();
      }
    });

    function projectedPlayers(state) {
      return projectPlayers(state && state.players, {
        query: query,
        filter: filter,
        sort: sort,
        active: !!(state && state.activeOrder)
      });
    }

    function renderPersonalCue() {
      var cue = element("defenseManagerPersonalCue");
      var personal = personalState && personalState.personal;
      if (!cue) return;
      if (!personal || personal.captured !== true) {
        cue.hidden = true;
        cue.removeAttribute("data-phase");
        return;
      }
      cue.hidden = false;
      cue.dataset.phase = personal.phase || "scheduled";
      var value = personal.phase === "now" ? text.now :
        formatSeconds(Math.max(0, Math.ceil(Number(personal.remainingMs || 0) / 1000)));
      cue.textContent = text.yourCue + " · " + value;
    }

    function renderHeader(state) {
      var label = text.locked;
      if (state.connected && state.authorized) label = state.managerReady ? text.ready : text.connecting;
      else if (!state.connected) label = text.reconnecting;
      setText("defenseManagerHeaderStatus", label);
      var statusNode = element("defenseManagerConnection");
      if (statusNode) statusNode.dataset.ready = state.managerReady ? "true" : "false";
      setText("defenseManagerConnection", label);
      var unlockSubmit = element("defenseManagerUnlockSubmit");
      if (unlockSubmit) unlockSubmit.disabled = state.unlockPending === true;
      if (state.unlockPending) setText("defenseManagerUnlockStatus", text.pending);
      renderPersonalCue();
    }

    function renderConfig(state) {
      var anchor = element("defenseManagerAnchor");
      var enemy = element("defenseManagerEnemyMarch");
      var active = !!state.activeOrder;
      if (anchor && doc.activeElement !== anchor) anchor.value = state.configDraft.tapAnchorSeconds == null ? "" : state.configDraft.tapAnchorSeconds;
      if (enemy && doc.activeElement !== enemy) enemy.value = state.configDraft.enemyMarchSeconds == null ? "" : state.configDraft.enemyMarchSeconds;
      if (anchor) anchor.disabled = active;
      if (enemy) enemy.disabled = active;
      var save = element("defenseManagerSaveTiming");
      if (save) save.disabled = active || !!state.pendingConfig;
      var message = "";
      if (state.pendingConfig) message = text.pending;
      else if (state.configConflict) message = text.configConflict;
      else if (state.lastError && state.lastError.source === "setDefenseConfig") message = text.invalidConfig;
      setText("defenseManagerConfigStatus", message);
    }

    function renderCounts(state, rows) {
      var projected = projectStatus({
        nowMs: transport.serverNowMs(), snapshot: state.snapshot || {}, players: rows
      });
      setText("defenseManagerRegistered", projected.waiting.registered);
      setText("defenseManagerReady", projected.waiting.ready);
      setText("defenseManagerRed", projected.waiting.red);
    }

    function metric(label, value) {
      var node = doc.createElement("div");
      node.className = "defense-manager__metric";
      var strong = doc.createElement("strong");
      var span = doc.createElement("span");
      strong.textContent = String(value == null ? 0 : value);
      span.textContent = label;
      node.appendChild(strong);
      node.appendChild(span);
      return node;
    }

    function replaceChildren(node, children) {
      if (!node) return;
      while (node.firstChild) node.removeChild(node.firstChild);
      children.forEach(function (child) { node.appendChild(child); });
    }

    function issueNode(label, count) {
      var node = doc.createElement("div");
      node.className = "defense-manager__issue";
      var name = doc.createElement("span");
      var number = doc.createElement("strong");
      name.textContent = label;
      number.textContent = String(count);
      node.appendChild(name);
      node.appendChild(number);
      return node;
    }

    function renderStatus(state) {
      var projected = projectStatus({
        nowMs: transport.serverNowMs(),
        snapshot: state.snapshot || {},
        players: state.players
      });
      var counts = projected.counts || {};
      var delivery = projected.delivery || {};
      var activeAudioReady = Object.prototype.hasOwnProperty.call(delivery, "audioReadyProfiles")
        ? Math.max(0, Number(delivery.audioReadyProfiles) || 0) : projected.waiting.audioReady;
      var metrics = [
        metric(projected.active ? text.metricTargeted : text.metricRegistered,
          projected.active ? counts.targetedProfiles : projected.waiting.registered),
        metric(text.metricScheduled, delivery.deliveredScheduledProfiles || 0),
        metric(text.metricAudioReady, activeAudioReady),
        metric(text.metricRed, projected.active
          ? (delivery.redUnconfirmedProfiles || 0) : projected.waiting.red)
      ];
      if (projected.nextWave) metrics.unshift(metric(text.metricNext, formatClock(projected.nextWave.goAtMs)));
      if (projected.expectedImpactAtMs) metrics.unshift(metric(text.metricImpact, formatClock(projected.expectedImpactAtMs)));
      replaceChildren(element("defenseManagerMetrics"), metrics);

      var issueLabels = {
        offline_roster: text.issueOffline,
        invalid_time: text.issueInvalid,
        too_late: text.issueTooLate,
        red_unconfirmed: text.issueRed
      };
      var issues = (projected.issues || []).map(function (issue) {
        return issueNode(issueLabels[issue.code] || issue.code, issue.count);
      });
      if (!issues.length) issues.push(issueNode(text.noIssues, 0));
      replaceChildren(element("defenseManagerIssues"), issues);
      setText("defenseManagerIssueCount", projected.issues.reduce(function (sum, issue) { return sum + Number(issue.count || 0); }, 0));

      setText("defenseManagerWavesTitle", projected.active ? text.alertWaves : text.marchDistribution);
      var waveSource = projected.active ? projected.waves : projected.distribution;
      var waves = waveSource.map(function (wave) {
        var node = doc.createElement("div");
        node.className = "defense-manager__wave";
        var time = doc.createElement("span");
        var count = doc.createElement("strong");
        time.textContent = projected.active ? formatClock(wave.goAtMs) : formatSeconds(wave.march);
        count.textContent = text.playerCount(wave.profiles);
        node.appendChild(time);
        node.appendChild(count);
        return node;
      });
      if (!waves.length) waves.push(issueNode(projected.active ? text.noWaves : text.noIssues, 0));
      replaceChildren(element("defenseManagerWaves"), waves);
    }

    function renderFire(state) {
      var fire = element("defenseManagerFire");
      var cancelButton = element("defenseManagerCancel");
      var active = !!state.activeOrder;
      var anchor = Number(state.config.tapAnchorSeconds) || Number(state.configDraft.tapAnchorSeconds) || 180;
      if (fire) {
        fire.hidden = active;
        fire.textContent = text.tapWhen(formatSeconds(anchor));
        fire.disabled = !state.managerReady || !!state.pendingFire || !!state.pendingConfig ||
          state.configConflict || !Number.isSafeInteger(state.config.enemyMarchSeconds);
      }
      if (cancelButton) {
        cancelButton.hidden = !active;
        cancelButton.disabled = !!state.pendingCancel;
      }
      setText("defenseManagerCommandTitle", active ? text.active : text.waiting);
    }

    function renderRoster(state) {
      var rows = projectedPlayers(state);
      virtualList.setItems(rows);
      var status = !state.rosterHydrated ? text.playersLoading :
        (rows.length ? text.playersCount(rows.length, state.players.length) : text.empty);
      setText("defenseManagerRosterStatus", status);
      var removedSelection = selectedPid && !state.players.some(function (row) { return row.pid === selectedPid; })
        ? selectedPid : "";
      if (removedSelection) selectedPid = "";
      renderPlayerDetail(state);
      if (removedSelection) {
        var list = element("defenseManagerPlayerList");
        if (list && typeof list.focus === "function") list.focus();
      }
    }

    function detailFacts(profile) {
      var active = profile.activeRound || null;
      return [
        [text.factWebsite, statusLabel(Object.assign({}, profile, { flags: playerFlags(profile) })).label],
        [text.factMarch, formatSeconds(profile.march)],
        [text.factConnected, Number(profile.connectedDevices) || 0],
        [text.factAudioReady, Number(profile.audioReadyDevices) || 0],
        [text.factGo, active && active.targeted ? formatClock(active.goAtMs) : "—"]
      ];
    }

    function renderPlayerDetail(state) {
      var detail = element("defenseManagerPlayerDetail");
      var list = element("defenseManagerPlayerList");
      var tools = doc.querySelector && doc.querySelector(".defense-manager__player-tools");
      var rosterStatus = element("defenseManagerRosterStatus");
      var profile = selectedPid && state && state.players.find(function (row) { return row.pid === selectedPid; });
      if (!profile) {
        if (detail) detail.hidden = true;
        if (list) list.hidden = false;
        if (tools) tools.hidden = false;
        if (rosterStatus) rosterStatus.hidden = false;
        return;
      }
      if (detail) detail.hidden = false;
      if (list) list.hidden = true;
      if (tools) tools.hidden = true;
      if (rosterStatus) rosterStatus.hidden = true;
      setText("defenseManagerPlayerName", profileName(profile));
      setText("defenseManagerPlayerIdentity", profile.identityMode === "playerId"
        ? text.playerIdLabel + " · " + String(profile.playerId || profile.pid)
        : text.nicknameLabel + " · " + profile.pid);
      var facts = [];
      detailFacts(profile).forEach(function (pair) {
        var term = doc.createElement("dt");
        var value = doc.createElement("dd");
        term.textContent = pair[0];
        value.textContent = String(pair[1]);
        facts.push(term, value);
      });
      replaceChildren(element("defenseManagerPlayerFacts"), facts);
      var march = element("defenseManagerPlayerMarch");
      if (march && doc.activeElement !== march) march.value = profile.march;
      setText("defenseManagerPlayerStatus", profile.pendingRemoval ? text.removePending :
        (state.activeOrder ? text.nextRound : ""));
    }

    function render(state) {
      if (disposed) return;
      latestState = state;
      renderHeader(state);
      renderConfig(state);
      renderCounts(state, state.players);
      renderFire(state);
      renderStatus(state);
      renderRoster(state);
      if (state.authorized) {
        setDialog("defenseManagerUnlock", false);
        if (drawerState === "closed" && element("defenseConsoleEntry") &&
            element("defenseConsoleEntry").dataset.managerOpening === "true") {
          delete element("defenseConsoleEntry").dataset.managerOpening;
          drawer.openCommand();
        }
      }
      if (state.lastError && state.lastError.source === "defenseUnlock") {
        setText("defenseManagerUnlockStatus", text.unlockFailed);
      }
      if (state.lastError && state.lastError.source === "fireDefense") announce(state.lastError.error);
    }

    function readConfigInputs() {
      controller.setConfigDraft({
        tapAnchorSeconds: Number(element("defenseManagerAnchor").value),
        enemyMarchSeconds: element("defenseManagerEnemyMarch").value === ""
          ? null : Number(element("defenseManagerEnemyMarch").value)
      });
    }

    function openConsole() {
      if (latestState && latestState.authorized) {
        drawer.openCommand();
        return;
      }
      var entry = element("defenseConsoleEntry");
      if (entry) entry.dataset.managerOpening = "true";
      setText("defenseManagerUnlockStatus", "");
      setDialog("defenseManagerUnlock", true, "defenseManagerPassword");
    }

    function setTab(name, focus) {
      var players = name === "players";
      show("defenseManagerStatusPane", !players);
      show("defenseManagerPlayersPane", players);
      ["Status", "Players"].forEach(function (part) {
        var active = (part === "Players") === players;
        var tab = element("defenseManager" + part + "Tab");
        tab.classList.toggle("is-selected", active);
        tab.setAttribute("aria-selected", active ? "true" : "false");
        tab.tabIndex = active ? 0 : -1;
      });
      if (players) virtualList.remeasure();
      if (focus) element(players ? "defenseManagerPlayersTab" : "defenseManagerStatusTab").focus();
    }

    function bind(id, event, listener) {
      var node = element(id);
      if (node) node.addEventListener(event, listener);
    }

    bind("defenseConsoleEntry", "defense:open-console", openConsole);
    bind("defenseManagerClose", "click", function () {
      if (drawer.state() === "manage") drawer.backToCommand();
      else drawer.close();
    });
    bind("defenseManagerOpenManage", "click", function () { drawer.openManage(); });
    bind("defenseManagerBack", "click", function () { drawer.backToCommand(); });
    bind("defenseManagerStatusTab", "click", function () { setTab("status", false); });
    bind("defenseManagerPlayersTab", "click", function () { setTab("players", false); });
    bind("defenseManagerStatusTab", "keydown", function (event) {
      if (event.key === "ArrowRight" || event.key === "End") { event.preventDefault(); setTab("players", true); }
    });
    bind("defenseManagerPlayersTab", "keydown", function (event) {
      if (event.key === "ArrowLeft" || event.key === "Home") { event.preventDefault(); setTab("status", true); }
    });
    bind("defenseManagerAnchor", "input", readConfigInputs);
    bind("defenseManagerEnemyMarch", "input", readConfigInputs);
    bind("defenseManagerSaveTiming", "click", function () {
      readConfigInputs();
      var result = controller.saveConfig();
      if (!result.ok) setText("defenseManagerConfigStatus",
        result.error === "invalid_config" ? text.invalidConfig : text.pending);
    });
    bind("defenseManagerFire", "click", function () {
      var result = controller.fire();
      if (!result.ok) announce(result.error === "manager_not_ready" ? text.managerNotReady : text.saveFirst);
    });
    bind("defenseManagerCancel", "click", function () {
      setDialog("defenseManagerCancelConfirm", true, "defenseManagerCancelNo");
    });
    bind("defenseManagerCancelNo", "click", function () { setDialog("defenseManagerCancelConfirm", false); });
    bind("defenseManagerCancelYes", "click", function () {
      var result = controller.cancel(true);
      if (result.ok) setDialog("defenseManagerCancelConfirm", false);
    });
    bind("defenseManagerUnlockClose", "click", function () {
      setDialog("defenseManagerUnlock", false);
      var entry = element("defenseConsoleEntry");
      if (entry) delete entry.dataset.managerOpening;
    });
    bind("defenseManagerUnlockForm", "submit", function (event) {
      event.preventDefault();
      var result = controller.unlock(element("defenseManagerPassword").value);
      if (!result.ok) setText("defenseManagerUnlockStatus", text.unlockFailed);
    });
    bind("defenseManagerSearch", "input", function () { query = this.value; renderRoster(latestState); });
    bind("defenseManagerFilter", "change", function () { filter = this.value; renderRoster(latestState); });
    bind("defenseManagerSort", "change", function () { sort = this.value; renderRoster(latestState); });
    bind("defenseManagerPlayerBack", "click", function () {
      var previousPid = selectedPid;
      selectedPid = "";
      renderPlayerDetail(latestState);
      virtualList.remeasure();
      if (previousPid) virtualList.scrollToKey(previousPid);
      var list = element("defenseManagerPlayerList");
      if (list && typeof list.focus === "function") list.focus();
    });
    bind("defenseManagerSavePlayer", "click", function () {
      var result = controller.setPlayerMarch(selectedPid, Number(element("defenseManagerPlayerMarch").value));
      if (!result.ok) setText("defenseManagerPlayerStatus", result.error);
    });
    bind("defenseManagerRemovePlayer", "click", function () {
      setDialog("defenseManagerRemoveConfirm", true, "defenseManagerRemoveNo");
    });
    bind("defenseManagerRemoveNo", "click", function () { setDialog("defenseManagerRemoveConfirm", false); });
    bind("defenseManagerRemoveYes", "click", function () {
      var result = controller.removePlayer(selectedPid, true);
      if (result.ok) setDialog("defenseManagerRemoveConfirm", false);
    });

    function handleMessage(message) { return controller.handleMessage(message); }
    function connectionChanged(next) { return controller.connectionChanged(next); }
    function clockChanged(next) { return controller.clockChanged(next); }
    function setPersonalState(next) { personalState = next; renderPersonalCue(); }
    function setLanguage(next) {
      language = next === "zh" ? "zh" : "en";
      text = MANAGER_STRINGS[language];
      applyStaticLanguage();
      if (latestState) render(latestState);
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      doc.removeEventListener("keydown", handleDialogKeydown, true);
      if (activeDialog) setDialog(activeDialog.id, false);
      virtualList.destroy();
      drawer.destroy();
      controller.dispose();
    }

    applyStaticLanguage();
    latestState = controller.state();
    render(latestState);

    return Object.freeze({
      controller: controller,
      handleMessage: handleMessage,
      connectionChanged: connectionChanged,
      clockChanged: clockChanged,
      setPersonalState: setPersonalState,
      setLanguage: setLanguage,
      open: openConsole,
      dispose: dispose
    });
  }

  return Object.freeze({
    MANAGER_STATUS_INTERVAL_MS: MANAGER_STATUS_INTERVAL_MS,
    playerFlags: playerFlags,
    projectPlayers: projectPlayers,
    groupWaves: groupWaves,
    projectStatus: projectStatus,
    createDefenseManager: createDefenseManager,
    mountDefenseManager: mountDefenseManager
  });
}));
