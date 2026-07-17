(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.RallyTactical = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var ROLE_ORDER = ["weak", "weak2", "main"];

  function finitePositive(value) {
    var number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function scaleMax(selectedMarchSeconds) {
    var values = Array.isArray(selectedMarchSeconds)
      ? selectedMarchSeconds.map(finitePositive).filter(function (value) { return value > 0; })
      : [];
    if (!values.length) return 120;
    return clamp(Math.max.apply(null, values) * 1.08, 5, 120);
  }

  function departureRadius(marchSeconds, scaleMaxSeconds, usableRadius, minimumRadius) {
    var march = finitePositive(marchSeconds);
    var scale = finitePositive(scaleMaxSeconds) || 120;
    var radius = finitePositive(usableRadius);
    var inner = clamp(finitePositive(minimumRadius), 0, radius);
    return inner + (radius - inner) * clamp(march / scale, 0, 1);
  }

  function actorProjection(input) {
    input = input || {};
    var nowMs = Number(input.nowMs);
    var pressAtMs = Number(input.pressAtMs);
    var gatherEndsAtMs = Number(input.gatherEndsAtMs);
    var marchMs = finitePositive(input.marchSeconds) * 1000;
    var startRadius = finitePositive(input.departureRadius);

    if (!Number.isFinite(nowMs) || !Number.isFinite(pressAtMs) || nowMs < pressAtMs) {
      return { phase: "staged", progress: 0, radius: startRadius };
    }
    if (!Number.isFinite(gatherEndsAtMs) || nowMs < gatherEndsAtMs) {
      return { phase: "gathering", progress: 0, radius: startRadius };
    }

    var progress = marchMs > 0 ? clamp((nowMs - gatherEndsAtMs) / marchMs, 0, 1) : 1;
    return {
      phase: progress >= 1 ? "landed" : "marching",
      progress: progress,
      radius: startRadius * (1 - progress)
    };
  }

  function modeFor(room, kingdom, command) {
    if (command && (command.type === "triple_rally" ||
        command.payload && command.payload.rallySize === 3)) return "triple";
    if (command && command.type === "double_rally") return "double";
    var record = room && room.rallyModes && (room.rallyModes[kingdom] || room.rallyModes[String(kingdom)]);
    return record && record.mode === "triple" ? "triple" : "double";
  }

  function commandFor(room, kingdom) {
    var commands = room && room.live && room.live.commands;
    var command = commands && (commands[kingdom] || commands[String(kingdom)]);
    if (!command || (command.type !== "double_rally" && command.type !== "triple_rally")) return null;
    return command;
  }

  function stagedPairsFor(room, kingdom) {
    var staged = room && room.live && room.live.staged;
    var record = staged && (staged[kingdom] || staged[String(kingdom)]);
    if (Array.isArray(record)) return record;
    return record && Array.isArray(record.pairs) ? record.pairs : [];
  }

  function actorsForPairs(pairs, options) {
    var actors = [], seenPid = Object.create(null), seenRole = Object.create(null);
    var roles = options.mode === "triple" ? ROLE_ORDER : ["weak", "main"];
    roles.forEach(function (role) {
      for (var index = 0; index < pairs.length; index += 1) {
        var pair = pairs[index];
        if (!pair || pair.role !== role || seenRole[role]) continue;
        var pid = typeof pair.pid === "string" ? pair.pid.trim() : "";
        if (!pid || seenPid[pid]) continue;

        var player = options.live ? pair : options.players[pid];
        var march = finitePositive(player && player.march);
        if (!player || !march) continue;

        var actor = {
          pid: pid,
          name: typeof player.name === "string" && player.name.trim() ? player.name.trim() : pid,
          march: march,
          role: role,
          kingdom: options.kingdom,
          mine: pid === options.myPid
        };
        if (options.live && Number.isFinite(Number(pair.pressUTC))) actor.pressUTC = Number(pair.pressUTC);
        actors.push(actor);
        seenPid[pid] = true;
        seenRole[role] = true;
        break;
      }
    });
    return actors;
  }

  function selectedGroups(room, myPid) {
    room = room || {};
    var players = room.players && typeof room.players === "object" ? room.players : {};
    return [1, 2].map(function (kingdom) {
      var command = commandFor(room, kingdom);
      var mode = modeFor(room, kingdom, command);
      var pairs = command && command.payload && Array.isArray(command.payload.pairs)
        ? command.payload.pairs
        : stagedPairsFor(room, kingdom);
      return {
        kingdom: kingdom,
        mode: mode,
        required: mode === "triple" ? 3 : 2,
        source: command ? "live" : "staged",
        commandId: command && typeof command.id === "string" ? command.id : "",
        actors: actorsForPairs(pairs, {
          live: !!command,
          mode: mode,
          kingdom: kingdom,
          myPid: typeof myPid === "string" ? myPid : "",
          players: players
        })
      };
    });
  }

  function renderKey(projection) {
    var groups = projection && Array.isArray(projection.groups) ? projection.groups : [];
    return JSON.stringify(groups.map(function (group) {
      return [
        Number(group.kingdom) || 0,
        group.mode === "triple" ? "triple" : "double",
        Number(group.required) || 0,
        group.source === "live" ? "live" : "staged",
        typeof group.commandId === "string" ? group.commandId : "",
        (Array.isArray(group.actors) ? group.actors : []).map(function (actor) {
          return [
            actor.pid,
            actor.name || actor.pid,
            finitePositive(actor.march),
            actor.role,
            Number(actor.kingdom) || 0,
            actor.mine === true,
            Number.isFinite(Number(actor.pressUTC)) ? Number(actor.pressUTC) : null
          ];
        })
      ];
    }));
  }

  return Object.freeze({
    scaleMax: scaleMax,
    departureRadius: departureRadius,
    actorProjection: actorProjection,
    selectedGroups: selectedGroups,
    renderKey: renderKey
  });
});
