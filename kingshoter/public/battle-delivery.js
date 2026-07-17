(function (root, factory) {
  var api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BattleDelivery = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  var DEFAULT_RETRY_DELAYS_MS = [1200, 2400, 5000, 10000, 15000];

  function requiredPart(value, label) {
    var text = String(value == null ? "" : value);
    if (!text || text.indexOf(":") >= 0) throw new TypeError(label + " is required and cannot contain a colon");
    return text;
  }

  function ackKey(value) {
    value = value || {};
    var orderId = requiredPart(value.orderId, "orderId");
    if (!Number.isInteger(value.revision) || value.revision < 0) throw new TypeError("revision is required");
    return orderId + ":" + value.revision + ":" + requiredPart(value.pid, "pid") + ":" + requiredPart(value.deviceId, "deviceId");
  }

  function callable(value, fallback) {
    return typeof value === "function" ? value : fallback;
  }

  function freezePayload(value) {
    if (!value || typeof value !== "object") return value;
    var copy = Array.isArray(value) ? value.slice() : {};
    Object.keys(value).forEach(function (key) { copy[key] = value[key]; });
    return Object.freeze(copy);
  }

  function createAckQueue(options) {
    options = options || {};
    if (typeof options.send !== "function") throw new TypeError("send is required");
    if (typeof options.nowMs !== "function") throw new TypeError("nowMs is required");
    if (typeof options.generation !== "function") throw new TypeError("generation is required");

    var retryDelays = Array.isArray(options.retryDelaysMs) && options.retryDelaysMs.length ?
      options.retryDelaysMs.map(function (value) { return Math.max(1, Number(value) || 1); }) :
      DEFAULT_RETRY_DELAYS_MS.slice();
    var setTimeoutValue = callable(options.setTimeout, callable(root.setTimeout, function () {
      throw new Error("setTimeout unavailable");
    }));
    var clearTimeoutValue = callable(options.clearTimeout, callable(root.clearTimeout, function () {}));
    var pendingEntries = Object.create(null);
    var confirmedEntries = Object.create(null);
    var rejectedEntries = Object.create(null);

    function publicEntry(entry, state) {
      if (!entry) return null;
      return {
        key: entry.key,
        scope: entry.scope,
        payload: entry.payload,
        deadlineAtMs: entry.deadlineAtMs,
        lastGeneration: entry.lastGeneration,
        attempts: entry.attempts,
        state: state,
        error: entry.error || "",
        terminal: entry.terminal === true
      };
    }

    function clearEntryTimer(entry) {
      if (!entry || entry.timer == null) return;
      clearTimeoutValue(entry.timer);
      entry.timer = null;
    }

    function removeFrom(map, key) {
      var entry = map[key];
      if (!entry) return false;
      clearEntryTimer(entry);
      delete map[key];
      return true;
    }

    function sendEntry(key, force) {
      var entry = pendingEntries[key];
      if (!entry || confirmedEntries[key] || (!force && entry.timer != null)) return false;
      var now = Number(options.nowMs());
      if (!Number.isFinite(now)) now = 0;
      if (now > entry.deadlineAtMs) { removeFrom(pendingEntries, key); return false; }
      var generation = options.generation();
      if (entry.lastGeneration !== generation) {
        clearEntryTimer(entry);
        entry.lastGeneration = generation;
        entry.attempts = 0;
      } else clearEntryTimer(entry);

      var sent = options.send(entry.payload) === true;
      if (sent) entry.attempts += 1;
      if (now < entry.deadlineAtMs) {
        var index = Math.min(Math.max(entry.attempts - 1, 0), retryDelays.length - 1);
        var delay = Math.min(retryDelays[index], Math.max(250, entry.deadlineAtMs - now));
        entry.timer = setTimeoutValue(function () {
          if (pendingEntries[key] !== entry) return;
          entry.timer = null;
          sendEntry(key, true);
        }, delay);
      }
      return sent;
    }

    function enqueue(input) {
      input = input || {};
      var key = String(input.key == null ? "" : input.key);
      if (!key) throw new TypeError("key is required");
      if (pendingEntries[key] || confirmedEntries[key] || rejectedEntries[key]) return false;
      var deadline = Number(input.deadlineAtMs);
      var now = Number(options.nowMs());
      if (!Number.isFinite(deadline)) throw new TypeError("deadlineAtMs must be finite");
      if (Number.isFinite(now) && now > deadline) return false;
      var entry = {
        key: key,
        scope: String(input.scope || ""),
        payload: freezePayload(input.payload),
        deadlineAtMs: deadline,
        timer: null,
        lastGeneration: null,
        attempts: 0
      };
      pendingEntries[key] = entry;
      return sendEntry(key, true);
    }

    function pending(key) { return publicEntry(pendingEntries[String(key || "")], "pending"); }
    function confirmed(key) { return publicEntry(confirmedEntries[String(key || "")], "confirmed"); }
    function rejected(key) { return publicEntry(rejectedEntries[String(key || "")], "rejected"); }
    function isConfirmed(key) { return !!confirmedEntries[String(key || "")]; }

    function confirm(key) {
      key = String(key || "");
      var entry = pendingEntries[key];
      if (!entry || confirmedEntries[key]) return false;
      removeFrom(pendingEntries, key);
      delete rejectedEntries[key];
      entry.timer = null;
      confirmedEntries[key] = entry;
      return true;
    }

    function reject(key, reason) {
      key = String(key || "");
      var entry = pendingEntries[key];
      if (!entry || confirmedEntries[key]) return false;
      reason = reason || {};
      removeFrom(pendingEntries, key);
      entry.timer = null;
      entry.error = String(reason.error || "");
      entry.terminal = reason.terminal === true;
      entry.lastGeneration = options.generation();
      rejectedEntries[key] = entry;
      return true;
    }

    function resume(key) {
      key = String(key || "");
      var entry = rejectedEntries[key];
      if (!entry || entry.terminal || confirmedEntries[key]) return false;
      delete rejectedEntries[key];
      entry.error = ""; entry.terminal = false; entry.timer = null;
      entry.lastGeneration = null; entry.attempts = 0;
      pendingEntries[key] = entry;
      return sendEntry(key, true);
    }

    function cancel(key) {
      key = String(key || "");
      var removed = 0;
      if (removeFrom(pendingEntries, key)) removed += 1;
      if (removeFrom(rejectedEntries, key)) removed += 1;
      if (removeFrom(confirmedEntries, key)) removed += 1;
      return removed > 0;
    }

    function cancelScope(scope) {
      scope = String(scope || "");
      if (!scope) return 0;
      var removed = 0;
      [pendingEntries, rejectedEntries, confirmedEntries].forEach(function (map) {
        Object.keys(map).forEach(function (key) {
          var entry = map[key];
          if (entry && (entry.scope === scope || entry.scope.indexOf(scope + ":") === 0)) {
            if (removeFrom(map, key)) removed += 1;
          }
        });
      });
      return removed;
    }

    function clearPending() {
      var count = 0;
      Object.keys(pendingEntries).forEach(function (key) { if (removeFrom(pendingEntries, key)) count += 1; });
      return count;
    }

    function clear() {
      var count = clearPending();
      [rejectedEntries, confirmedEntries].forEach(function (map) {
        Object.keys(map).forEach(function (key) { if (removeFrom(map, key)) count += 1; });
      });
      return count;
    }

    function pause() {
      var count = 0;
      Object.keys(pendingEntries).forEach(function (key) {
        var entry = pendingEntries[key];
        if (entry.timer != null) { clearEntryTimer(entry); count += 1; }
      });
      return count;
    }

    function retryAll(force) {
      var currentGeneration = options.generation();
      var sentCount = 0;
      var resumed = Object.create(null);
      Object.keys(rejectedEntries).forEach(function (key) {
        var entry = rejectedEntries[key];
        if (!entry.terminal && entry.lastGeneration !== currentGeneration && resume(key)) {
          resumed[key] = true;
          sentCount += 1;
        }
      });
      Object.keys(pendingEntries).forEach(function (key) {
        if (resumed[key]) return;
        var entry = pendingEntries[key];
        if ((force === true || entry.lastGeneration !== currentGeneration) && sendEntry(key, true)) sentCount += 1;
      });
      return sentCount;
    }

    function prune(keep) {
      if (typeof keep !== "function") return 0;
      var removed = 0;
      [[pendingEntries, "pending"], [rejectedEntries, "rejected"], [confirmedEntries, "confirmed"]].forEach(function (pair) {
        Object.keys(pair[0]).forEach(function (key) {
          if (keep(publicEntry(pair[0][key], pair[1])) !== true && removeFrom(pair[0], key)) removed += 1;
        });
      });
      return removed;
    }

    function snapshot() {
      var result = [];
      [[pendingEntries, "pending"], [rejectedEntries, "rejected"], [confirmedEntries, "confirmed"]].forEach(function (pair) {
        Object.keys(pair[0]).sort().forEach(function (key) { result.push(publicEntry(pair[0][key], pair[1])); });
      });
      return result;
    }

    return Object.freeze({
      enqueue: enqueue,
      send: sendEntry,
      confirm: confirm,
      reject: reject,
      resume: resume,
      pending: pending,
      confirmed: confirmed,
      rejected: rejected,
      isConfirmed: isConfirmed,
      cancel: cancel,
      cancelScope: cancelScope,
      clearPending: clearPending,
      clear: clear,
      pause: pause,
      retryAll: retryAll,
      prune: prune,
      snapshot: snapshot
    });
  }

  return Object.freeze({ ackKey: ackKey, createAckQueue: createAckQueue });
}));
