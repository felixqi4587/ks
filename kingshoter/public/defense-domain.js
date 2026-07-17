(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DefenseDomain = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var ROUTING_KEY = /^(?!__proto__$|constructor$|prototype$)[A-Za-z0-9_-]{1,64}$/;
  var CUES = [
    { id: "prepare-15", offsetMs: -15000, kind: "prepare" },
    { id: "beep-10", offsetMs: -10000, kind: "beep" },
    { id: "beep-9", offsetMs: -9000, kind: "beep" },
    { id: "beep-8", offsetMs: -8000, kind: "beep" },
    { id: "beep-7", offsetMs: -7000, kind: "beep" },
    { id: "beep-6", offsetMs: -6000, kind: "beep" },
    { id: "count-5", offsetMs: -5000, kind: "countdown", name: "5" },
    { id: "count-4", offsetMs: -4000, kind: "countdown", name: "4" },
    { id: "count-3", offsetMs: -3000, kind: "countdown", name: "3" },
    { id: "count-2", offsetMs: -2000, kind: "countdown", name: "2" },
    { id: "count-1", offsetMs: -1000, kind: "countdown", name: "1" },
    { id: "now", offsetMs: 0, kind: "go", name: "go" }
  ].map(Object.freeze);

  function safeInteger(value) {
    return Number.isSafeInteger(value) ? value : null;
  }

  function routingKey(value) {
    value = String(value == null ? "" : value);
    return ROUTING_KEY.test(value) ? value : "";
  }

  function waiting(nowMs) {
    return Object.freeze({
      captured: false,
      tooLate: false,
      phase: "waiting",
      remainingMs: null,
      observedAtMs: safeInteger(nowMs) == null ? 0 : nowMs
    });
  }

  function targetFrom(order, pid) {
    if (!order || typeof order !== "object" || Array.isArray(order)) return null;
    if (routingKey(order.pid)) return order;
    var audience = Array.isArray(order.audience) ? order.audience : [];
    for (var index = 0; index < audience.length; index += 1) {
      if (routingKey(audience[index] && audience[index].pid) === pid) return audience[index];
    }
    return null;
  }

  function phaseFor(remainingMs) {
    if (remainingMs < 0) return "too_late";
    if (remainingMs === 0) return "now";
    if (remainingMs <= 5000) return "countdown";
    if (remainingMs <= 10000) return "beep";
    if (remainingMs <= 15000) return "prepare";
    return "scheduled";
  }

  function personalOrder(order, pidValue, nowValue) {
    var nowMs = safeInteger(nowValue);
    if (nowMs == null) nowMs = 0;
    var pid = routingKey(pidValue);
    var id = order && routingKey(order.id);
    var revision = order && safeInteger(order.revision);
    var target = pid ? targetFrom(order, pid) : null;
    var targetPid = routingKey(target && target.pid);
    var march = target && safeInteger(target.march);
    var marchRevision = target && safeInteger(target.marchRevision);
    var goAtMs = target && safeInteger(target.goAtMs);
    var completeAtMs = order && safeInteger(order.completeAtMs);
    var canonicalTooLate = target && target.tooLate;
    if (!id || revision == null || revision < 1 || !target || targetPid !== pid ||
        march == null || march < 5 || march > 120 || marchRevision == null || marchRevision < 0 ||
        goAtMs == null || completeAtMs == null || typeof canonicalTooLate !== "boolean") {
      return waiting(nowMs);
    }
    var remainingMs = goAtMs - nowMs;
    var tooLate = canonicalTooLate || remainingMs < 0;
    return Object.freeze({
      captured: true,
      tooLate: tooLate,
      id: id,
      revision: revision,
      pid: pid,
      displayName: String(target.displayName || pid).slice(0, 64),
      march: march,
      marchRevision: marchRevision,
      goAtMs: goAtMs,
      completeAtMs: completeAtMs,
      phase: tooLate ? "too_late" : phaseFor(remainingMs),
      remainingMs: remainingMs,
      observedAtMs: nowMs,
      planId: "defense:" + id + ":" + revision + ":" + pid
    });
  }

  function cuePlan(projection) {
    if (!projection || projection.captured !== true || projection.tooLate === true ||
        !routingKey(projection.planId) && String(projection.planId || "").indexOf("defense:") !== 0 ||
        safeInteger(projection.goAtMs) == null || safeInteger(projection.observedAtMs) == null) return [];
    return CUES.filter(function (event) {
      return projection.goAtMs + event.offsetMs >= projection.observedAtMs;
    }).map(function (event) {
      var copy = { id: event.id, offsetMs: event.offsetMs, kind: event.kind };
      if (event.name) copy.name = event.name;
      return Object.freeze(copy);
    });
  }

  function cueScope(projection) {
    return projection && projection.captured === true ? String(projection.planId || "") : "";
  }

  function matchesTerminal(projection, message) {
    if (!projection || projection.captured !== true || !message ||
        (message.t !== "defenseOrderCancelled" && message.t !== "defenseOrderCompleted")) return false;
    return message.orderId === projection.id && Number.isSafeInteger(message.revision) &&
      message.revision > projection.revision;
  }

  return Object.freeze({
    personalOrder: personalOrder,
    cuePlan: cuePlan,
    cueScope: cueScope,
    matchesTerminal: matchesTerminal
  });
}));
