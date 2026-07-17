(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BattleCues = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var DEFAULT_WINDOW_MS = 360000;
  var PAST_GRACE_MS = 150;
  var PRUNE_AGE_MS = 4000;

  function finite(value, fallback) {
    value = Number(value);
    return Number.isFinite(value) ? value : fallback;
  }

  function copyEvent(event) {
    var copy = {};
    event = event || {};
    Object.keys(event).forEach(function (key) { copy[key] = event[key]; });
    return Object.freeze(copy);
  }

  function createCueScheduler(options) {
    options = options || {};
    var audio = options.audio;
    if (!audio || typeof audio.schedule !== "function" || typeof audio.cancel !== "function" ||
        typeof audio.nowSeconds !== "function") throw new TypeError("audio scheduler is required");
    if (typeof options.nowMs !== "function") throw new TypeError("nowMs is required");

    var registry = options.registry || Object.create(null);
    var clockOffsetMs = typeof options.clockOffsetMs === "function" ? options.clockOffsetMs : function () { return 0; };
    var onScheduled = typeof options.onScheduled === "function" ? options.onScheduled : function () {};
    var onError = typeof options.onError === "function" ? options.onError : function () {};
    var disposed = false;

    function assertActive() {
      if (disposed) throw new Error("cue scheduler disposed");
    }

    function stop(entry) {
      try { audio.cancel(entry && entry.nodes || []); } catch (error) { onError(error); }
    }

    function removeKey(key) {
      var entry = registry[key];
      if (!entry) return false;
      stop(entry);
      delete registry[key];
      return true;
    }

    function prune(now) {
      Object.keys(registry).forEach(function (key) {
        var entry = registry[key];
        if (entry && entry.t < now - PRUNE_AGE_MS) removeKey(key);
      });
    }

    function normalizePlan(plan) {
      if (!plan || typeof plan.id !== "string" || !plan.id) throw new TypeError("cue plan id is required");
      var targetAtMs = finite(plan.targetAtMs, NaN);
      if (!Number.isFinite(targetAtMs)) throw new TypeError("targetAtMs must be finite");
      var events = Array.isArray(plan.events) ? plan.events : [];
      return { id: plan.id, targetAtMs: targetAtMs, events: events };
    }

    function desiredKeys(plan) {
      var desired = Object.create(null);
      for (var index = 0; index < plan.events.length; index += 1) {
        var event = plan.events[index] || {};
        var eventId = event.id == null ? String(index) : String(event.id);
        desired[plan.id + ":" + eventId] = true;
      }
      return desired;
    }

    function scheduleEvent(plan, event, index, windowMs, now) {
      var eventId = event && event.id != null ? String(event.id) : String(index);
      var key = plan.id + ":" + eventId;
      if (registry[key]) return false;
      var normalizedEvent = copyEvent(event);
      var offsetMs = finite(normalizedEvent.offsetMs, 0);
      var atMs = plan.targetAtMs + offsetMs;
      var deltaMs = atMs - now;
      if (deltaMs > windowMs) return false;

      if (deltaMs < -PAST_GRACE_MS) {
        registry[key] = {
          key: key,
          id: plan.id,
          base: plan.id,
          t: atMs,
          targetAtMs: plan.targetAtMs,
          offsetMs: offsetMs,
          off: finite(clockOffsetMs(), 0),
          event: normalizedEvent,
          nodes: []
        };
        return false;
      }

      var nodes;
      try {
        nodes = audio.schedule(normalizedEvent, audio.nowSeconds() + Math.max(0, deltaMs) / 1000);
      } catch (error) {
        onError(error, Object.freeze({ id: plan.id, key: key, event: normalizedEvent }));
        return false;
      }
      if (!Array.isArray(nodes) || nodes.length === 0) return false;
      registry[key] = {
        key: key,
        id: plan.id,
        base: plan.id,
        t: atMs,
        targetAtMs: plan.targetAtMs,
        offsetMs: offsetMs,
        off: finite(clockOffsetMs(), 0),
        event: normalizedEvent,
        nodes: nodes
      };
      onScheduled(Object.freeze({ id: plan.id, key: key, atMs: atMs, event: normalizedEvent }));
      return true;
    }

    function upsert(rawPlan, behavior) {
      assertActive();
      var plan = normalizePlan(rawPlan);
      behavior = behavior || {};
      var now = finite(options.nowMs(), 0);
      var windowMs = finite(behavior.windowMs, DEFAULT_WINDOW_MS);
      if (windowMs < 0) windowMs = DEFAULT_WINDOW_MS;
      prune(now);
      var desired = desiredKeys(plan);
      if (behavior.merge !== true) {
        Object.keys(registry).forEach(function (key) {
          var entry = registry[key];
          if (entry && entry.base === plan.id && entry.t > now && !desired[key]) removeKey(key);
        });
      }
      var count = 0;
      for (var index = 0; index < plan.events.length; index += 1) {
        if (scheduleEvent(plan, plan.events[index], index, windowMs, now)) count += 1;
      }
      return count;
    }

    function reconcile(plans, behavior) {
      assertActive();
      plans = Array.isArray(plans) ? plans.map(normalizePlan) : [];
      behavior = behavior || {};
      var now = finite(options.nowMs(), 0);
      var desired = Object.create(null);
      plans.forEach(function (plan) {
        var keys = desiredKeys(plan);
        Object.keys(keys).forEach(function (key) { desired[key] = true; });
      });
      Object.keys(registry).forEach(function (key) {
        var entry = registry[key];
        if (entry && entry.t > now && !desired[key]) removeKey(key);
      });
      var count = 0;
      plans.forEach(function (plan) {
        count += upsert(plan, { merge: true, windowMs: behavior.windowMs });
      });
      return count;
    }

    function cancel(id) {
      assertActive();
      var found = false;
      Object.keys(registry).forEach(function (key) {
        if (registry[key] && registry[key].base === id) found = removeKey(key) || found;
      });
      return found;
    }

    function cancelScope(scope) {
      assertActive();
      scope = String(scope || "");
      var count = 0;
      Object.keys(registry).forEach(function (key) {
        var entry = registry[key];
        if (entry && entry.base.indexOf(scope) === 0 && removeKey(key)) count += 1;
      });
      return count;
    }

    function cancelWhere(predicate) {
      assertActive();
      if (typeof predicate !== "function") return 0;
      var count = 0;
      Object.keys(registry).forEach(function (key) {
        var entry = registry[key];
        var projection = project(entry);
        if (predicate(projection) === true && removeKey(key)) count += 1;
      });
      return count;
    }

    function hasFutureCue(id) {
      assertActive();
      var now = finite(options.nowMs(), 0);
      return Object.keys(registry).some(function (key) {
        var entry = registry[key];
        return entry && entry.base === id && entry.t > now;
      });
    }

    function project(entry) {
      return Object.freeze({
        key: entry.key,
        id: entry.id,
        base: entry.base,
        atMs: entry.t,
        targetAtMs: entry.targetAtMs,
        offsetMs: entry.offsetMs,
        clockOffsetMs: entry.off,
        scheduled: Array.isArray(entry.nodes) && entry.nodes.length > 0,
        event: entry.event
      });
    }

    function snapshot() {
      var result = Object.keys(registry).sort().map(function (key) { return project(registry[key]); });
      return Object.freeze(result);
    }

    function cancelDrifted(currentOffsetMs, thresholdMs) {
      assertActive();
      var current = finite(currentOffsetMs, 0);
      var threshold = Math.max(0, finite(thresholdMs, 300));
      return cancelWhere(function (entry) { return Math.abs(entry.clockOffsetMs - current) > threshold; }) > 0;
    }

    function dispose() {
      if (disposed) return;
      Object.keys(registry).forEach(removeKey);
      disposed = true;
    }

    return Object.freeze({
      reconcile: reconcile,
      upsert: upsert,
      cancel: cancel,
      cancelScope: cancelScope,
      cancelWhere: cancelWhere,
      cancelDrifted: cancelDrifted,
      hasFutureCue: hasFutureCue,
      snapshot: snapshot,
      dispose: dispose
    });
  }

  return Object.freeze({ createCueScheduler: createCueScheduler });
}));
