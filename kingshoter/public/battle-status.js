(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BattleStatus = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var checks = [
    ["userEnabled", "user_disabled"],
    ["audioContextRunning", "audio_context_not_running"],
    ["carrierAlive", "carrier_not_alive"],
    ["connected", "disconnected"],
    ["clockFresh", "clock_stale"]
  ];

  function deriveReadiness(input) {
    input = input || {};
    var reasons = [];
    for (var index = 0; index < checks.length; index += 1) {
      if (input[checks[index][0]] !== true) reasons.push(checks[index][1]);
    }
    Object.freeze(reasons);
    return Object.freeze({
      level: reasons.length ? "not_ready" : "ready",
      green: reasons.length === 0,
      reasons: reasons
    });
  }

  return Object.freeze({ deriveReadiness: deriveReadiness });
}));
