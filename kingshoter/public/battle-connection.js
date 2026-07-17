(function (root, factory) {
  var api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BattleConnection = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  var CLOCK_SYNC_INTERVAL_MS = 180000;
  var CLOCK_STALE_AFTER_MS = 360000;

  function callable(value, fallback) {
    return typeof value === "function" ? value : fallback;
  }

  function normalizedBuild(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  }

  function createRoomConnection(options, overrides) {
    options = options || {};
    overrides = overrides || {};
    var surface = String(options.surface || "");
    if (surface !== "rally" && surface !== "defense") {
      throw new TypeError("BattleConnection surface must be rally or defense");
    }

    var room = String(options.room || "");
    var clientBuild = normalizedBuild(options.clientBuild);
    var locationValue = overrides.location || root.location || { protocol: "https:", host: "" };
    var WebSocketValue = overrides.WebSocket || root.WebSocket;
    var fetchValue = callable(overrides.fetch, callable(root.fetch, function () { return Promise.reject(new Error("fetch unavailable")); }));
    var now = callable(overrides.now, function () { return Date.now(); });
    var random = callable(overrides.random, Math.random);
    var setTimeoutValue = callable(overrides.setTimeout, root.setTimeout ? root.setTimeout.bind(root) : setTimeout);
    var clearTimeoutValue = callable(overrides.clearTimeout, root.clearTimeout ? root.clearTimeout.bind(root) : clearTimeout);
    var setIntervalValue = callable(overrides.setInterval, root.setInterval ? root.setInterval.bind(root) : setInterval);
    var clearIntervalValue = callable(overrides.clearInterval, root.clearInterval ? root.clearInterval.bind(root) : clearInterval);
    var onMessage = callable(options.onMessage, function () {});
    var onConnectionChange = callable(options.onConnectionChange, function () {});
    var onClockChange = callable(options.onClockChange, function () {});
    var manageClock = options.manageClock !== false;

    var socket = null;
    var connectionGeneration = 0;
    var reconnectTimer = null;
    var clockInterval = null;
    var started = false;
    var stopped = false;
    var clockOffsetMs = 0;
    var clockSampleAtMs = null;
    var clockAttempt = 0;

    function safeCallback(callback, value) {
      try { callback(value); } catch (_) {}
    }

    function generationCurrent(candidate, generation) {
      return !stopped && socket === candidate && connectionGeneration === generation;
    }

    function connectionState(connected, connecting, reason, generation) {
      return {
        connected: connected === true,
        connecting: connecting === true,
        reason: reason,
        generation: generation
      };
    }

    function clearReconnect() {
      if (reconnectTimer === null) return;
      clearTimeoutValue(reconnectTimer);
      reconnectTimer = null;
    }

    function socketUrl() {
      var protocol = locationValue.protocol === "https:" ? "wss" : "ws";
      return protocol + "://" + locationValue.host + "/api/ws?room=" + encodeURIComponent(room) +
        "&surface=" + encodeURIComponent(surface) + "&clientBuild=" + clientBuild;
    }

    function connectSocket() {
      if (stopped) return false;
      clearReconnect();
      var generation = ++connectionGeneration;
      var candidate = new WebSocketValue(socketUrl());
      socket = candidate;
      safeCallback(onConnectionChange, connectionState(false, true, "connecting", generation));
      candidate.onopen = function () {
        if (!generationCurrent(candidate, generation)) return;
        safeCallback(onConnectionChange, connectionState(true, false, "open", generation));
      };
      candidate.onmessage = function (event) {
        if (!generationCurrent(candidate, generation)) return;
        var message;
        try { message = JSON.parse(event.data); } catch (_) { return; }
        safeCallback(onMessage, message);
      };
      candidate.onclose = function () {
        if (!generationCurrent(candidate, generation)) return;
        safeCallback(onConnectionChange, connectionState(false, false, "closed", generation));
        if (!generationCurrent(candidate, generation)) return;
        reconnectTimer = setTimeoutValue(function () {
          if (!generationCurrent(candidate, generation)) return;
          reconnectTimer = null;
          connectSocket();
        }, 1000 + random() * 2000);
      };
      return true;
    }

    function clockFresh() {
      if (clockSampleAtMs === null) return false;
      var ageMs = now() - clockSampleAtMs;
      return ageMs >= 0 && ageMs < CLOCK_STALE_AFTER_MS;
    }

    function clockResult(rttMs) {
      return {
        offsetMs: clockOffsetMs,
        rttMs: rttMs,
        sampledAtMs: clockSampleAtMs,
        fresh: clockFresh(),
        offset: clockOffsetMs,
        rtt: rttMs
      };
    }

    async function syncClock() {
      if (stopped) return clockResult(null);
      var attempt = ++clockAttempt;
      var best = null;
      for (var index = 0; index < 4; index += 1) {
        var startedAtMs = now();
        try {
          var response = await fetchValue("/api/time", { cache: "no-store" });
          var body = await response.json();
          var finishedAtMs = now();
          var rttMs = finishedAtMs - startedAtMs;
          var offsetMs = Number(body.t) - (startedAtMs + finishedAtMs) / 2;
          if (Number.isFinite(offsetMs) && (!best || rttMs < best.rttMs)) {
            best = { rttMs: rttMs, offsetMs: offsetMs };
          }
        } catch (_) {}
        if (stopped || attempt !== clockAttempt) return clockResult(null);
      }
      if (best) {
        clockOffsetMs = Math.round(best.offsetMs);
        clockSampleAtMs = now();
      }
      var result = clockResult(best ? best.rttMs : null);
      safeCallback(onClockChange, result);
      return result;
    }

    function start() {
      if (stopped || started) return api;
      started = true;
      connectSocket();
      if (manageClock) {
        clockInterval = setIntervalValue(function () { syncClock(); }, CLOCK_SYNC_INTERVAL_MS);
        syncClock();
      }
      return api;
    }

    function connect() {
      if (stopped) return false;
      if (!started) { start(); return true; }
      return connectSocket();
    }

    function send(message) {
      try {
        if (!stopped && socket && socket.readyState === 1) {
          socket.send(JSON.stringify(message));
          return true;
        }
      } catch (_) {}
      return false;
    }

    function refresh() {
      if (stopped) return false;
      if (!started) { start(); return true; }
      var previous = socket;
      connectSocket();
      try { if (previous && previous.readyState < 2) previous.close(); } catch (_) {}
      return true;
    }

    function kick() {
      if (stopped) return false;
      if (!socket || socket.readyState > 1) return connect();
      return false;
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      clearReconnect();
      if (clockInterval !== null) {
        clearIntervalValue(clockInterval);
        clockInterval = null;
      }
      clockAttempt += 1;
      try { if (socket) socket.close(); } catch (_) {}
      safeCallback(onConnectionChange,
        connectionState(false, false, "stopped", connectionGeneration));
    }

    var api = {
      start: start,
      connect: connect,
      send: send,
      refresh: refresh,
      kick: kick,
      stop: stop,
      syncClock: syncClock,
      serverNowMs: function () { return now() + clockOffsetMs; },
      clockFresh: clockFresh,
      generation: function () { return connectionGeneration; },
      connected: function () { return !!(!stopped && socket && socket.readyState === 1); },
      socket: function () { return socket; },
      clientBuild: clientBuild,
      room: room,
      surface: surface
    };
    return api;
  }

  return {
    CLOCK_SYNC_INTERVAL_MS: CLOCK_SYNC_INTERVAL_MS,
    CLOCK_STALE_AFTER_MS: CLOCK_STALE_AFTER_MS,
    createRoomConnection: createRoomConnection
  };
});
