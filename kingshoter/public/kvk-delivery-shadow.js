(function (root) {
  'use strict';

  var VERSION = 1;
  var MAX_FACTS = 32;
  var MAX_CANCELLED = 32;
  var MAX_OBSERVATIONS = 200;
  var QA_ROOM_RE = /^qa-kvk-[a-z0-9](?:[a-z0-9-]{0,39}[a-z0-9])?$/;
  var PID_RE = /^[A-Za-z0-9_-]+$/;
  var DEVICE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  var BASE_OFFSETS = Object.freeze([10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  var PROBE_KEYS = Object.freeze(['t', 'v', 'probeId', 'sentAtMs', 'expiresAtMs']);
  var COMMAND_KEYS = Object.freeze([
    't', 'v', 'shadow', 'commandId', 'pid', 'role', 'kingdom',
    'issuedAtMs', 'fireAtMs', 'audioExpiresAtMs', 'marchSeconds', 'leadSeconds'
  ]);
  var CANCEL_KEYS = Object.freeze(['t', 'v', 'shadow', 'commandId', 'cancelledAtMs']);

  function isQaRoomName(room) {
    return typeof room === 'string' && room.length <= 48 && QA_ROOM_RE.test(room);
  }

  function hasExactKeys(value, expected) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var keys = Object.keys(value);
    if (keys.length !== expected.length) return false;
    for (var index = 0; index < expected.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, expected[index])) return false;
    }
    return true;
  }

  function isSafeNonNegative(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function isBoundedId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 64 && value.trim() === value;
  }

  function isPid(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 24 &&
      value.trim() === value && value !== '__proto__' && value !== 'prototype' &&
      value !== 'constructor' && PID_RE.test(value);
  }

  function isDevice(value) {
    return typeof value === 'string' && DEVICE_RE.test(value);
  }

  function create(options) {
    options = options && typeof options === 'object' ? options : {};
    var enabled = options.enabled === true && isQaRoomName(options.room);
    var send = typeof options.send === 'function' ? options.send : null;
    var readNow = typeof options.now === 'function' ? options.now : null;
    var getIdentity = typeof options.getIdentity === 'function' ? options.getIdentity : null;
    var observe = typeof options.observe === 'function' ? options.observe : null;
    var session = null;
    var facts = new Map();
    var cancelled = new Set();
    var observations = [];

    function currentIdentity() {
      if (!getIdentity) return null;
      try {
        var value = getIdentity();
        if (!value || typeof value !== 'object') return null;
        var pid = value.pid;
        var deviceId = value.deviceId;
        var view = value.view;
        var audioArmed = value.audioArmed;
        if (!isPid(pid) || !isDevice(deviceId) ||
            (view !== 'player' && view !== 'commander') ||
            typeof audioArmed !== 'boolean') return null;
        return {
          pid: pid,
          deviceId: deviceId,
          view: view,
          audioArmed: audioArmed
        };
      } catch (error) {
        return null;
      }
    }

    function pinnedIdentity() {
      if (!session) return null;
      var value = currentIdentity();
      if (!value || value.pid !== session.pid || value.deviceId !== session.deviceId) {
        session = null;
        return null;
      }
      return value;
    }

    function serverNow() {
      if (!readNow) return null;
      var value;
      try {
        value = readNow();
      } catch (error) {
        return null;
      }
      return isSafeNonNegative(value) ? value : null;
    }

    function emit(message) {
      if (!enabled || !send) return false;
      try {
        return send(message) === true;
      } catch (error) {
        return false;
      }
    }

    function copyObservation(value) {
      var copy = { kind: value.kind };
      if (value.commandId) copy.commandId = value.commandId;
      if (value.result) copy.result = value.result;
      if (Number.isInteger(value.count)) copy.count = value.count;
      return copy;
    }

    function recordObservation(value) {
      var stored = copyObservation(value);
      observations.push(stored);
      if (observations.length > MAX_OBSERVATIONS) observations.shift();
      if (observe) {
        try {
          observe(copyObservation(stored));
        } catch (error) {}
      }
    }

    function rememberFact(commandId, value) {
      if (!facts.has(commandId) && facts.size >= MAX_FACTS) {
        facts.delete(facts.keys().next().value);
      }
      facts.set(commandId, value);
    }

    function rememberCancel(commandId) {
      if (cancelled.has(commandId)) return false;
      if (cancelled.size >= MAX_CANCELLED) {
        cancelled.delete(cancelled.values().next().value);
      }
      cancelled.add(commandId);
      return true;
    }

    function commandFingerprint(message) {
      return JSON.stringify([
        message.t, message.v, message.shadow, message.commandId, message.pid,
        message.role, message.kingdom, message.issuedAtMs, message.fireAtMs,
        message.audioExpiresAtMs, message.marchSeconds, message.leadSeconds
      ]);
    }

    function futureCount(message, nowMs) {
      var offsets = BASE_OFFSETS.slice();
      if (offsets.indexOf(message.leadSeconds) < 0) offsets.push(message.leadSeconds);
      var count = 0;
      for (var index = 0; index < offsets.length; index += 1) {
        if (message.fireAtMs - offsets[index] * 1000 > nowMs - 150) count += 1;
      }
      return count;
    }

    function sendAck(commandId, result, count) {
      emit({
        t: 'deliveryShadowAck',
        v: VERSION,
        commandId: commandId,
        result: result,
        futureCueCount: count
      });
    }

    function validProbe(message) {
      return hasExactKeys(message, PROBE_KEYS) &&
        message.t === 'deliveryShadowProbe' && message.v === VERSION &&
        isBoundedId(message.probeId) && isSafeNonNegative(message.sentAtMs) &&
        isSafeNonNegative(message.expiresAtMs) && message.sentAtMs <= message.expiresAtMs;
    }

    function validCommand(message, identity) {
      return hasExactKeys(message, COMMAND_KEYS) &&
        message.t === 'deliveryShadowCommand' && message.v === VERSION &&
        message.shadow === true && isBoundedId(message.commandId) &&
        isPid(message.pid) && message.pid === session.pid && message.pid === identity.pid &&
        (message.role === 'weak' || message.role === 'main') &&
        (message.kingdom === 1 || message.kingdom === 2) &&
        Number.isSafeInteger(message.issuedAtMs) && message.issuedAtMs > 0 &&
        Number.isSafeInteger(message.fireAtMs) && message.fireAtMs > 0 &&
        isSafeNonNegative(message.audioExpiresAtMs) &&
        message.audioExpiresAtMs >= message.fireAtMs &&
        isSafeNonNegative(message.marchSeconds) &&
        Number.isSafeInteger(message.leadSeconds) &&
        message.leadSeconds >= 1 && message.leadSeconds <= 120;
    }

    function validCancel(message) {
      return hasExactKeys(message, CANCEL_KEYS) &&
        message.t === 'deliveryShadowCancel' && message.v === VERSION &&
        message.shadow === true && isBoundedId(message.commandId) &&
        isSafeNonNegative(message.cancelledAtMs);
    }

    function onOpen() {
      session = null;
      if (!enabled) return false;
      var identity = currentIdentity();
      if (!identity) return false;
      var sent = emit({
        t: 'deliveryShadowHello',
        v: VERSION,
        shadow: true,
        pid: identity.pid,
        deviceId: identity.deviceId,
        view: identity.view
      });
      if (!sent) return false;
      session = { pid: identity.pid, deviceId: identity.deviceId };
      return true;
    }

    function handleProbe(message, identity) {
      if (!validProbe(message)) return false;
      var nowMs = serverNow();
      if (nowMs == null || nowMs > message.expiresAtMs) return false;
      emit({
        t: 'deliveryShadowProbeAck',
        v: VERSION,
        probeId: message.probeId,
        audioArmed: identity.audioArmed
      });
      return true;
    }

    function handleCommand(message, identity) {
      if (!validCommand(message, identity)) return false;
      var commandId = message.commandId;
      var fingerprint = commandFingerprint(message);
      var previous = facts.get(commandId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) {
          recordObservation({ kind: 'candidate-conflict', commandId: commandId });
          return false;
        }
        var duplicateCount = previous.result === 'would_schedule' && !previous.cancelled
          ? previous.count : 0;
        sendAck(commandId, 'duplicate', duplicateCount);
        recordObservation({
          kind: 'candidate-duplicate',
          commandId: commandId,
          result: 'duplicate',
          count: duplicateCount
        });
        return true;
      }

      var nowMs = serverNow();
      if (nowMs == null) return false;
      var result = 'expired';
      var count = 0;
      var wasCancelled = cancelled.has(commandId);
      if (!wasCancelled && nowMs < message.audioExpiresAtMs) {
        if (!identity.audioArmed) {
          result = 'audio_unarmed';
        } else {
          count = futureCount(message, nowMs);
          if (count > 0) result = 'would_schedule';
          else count = 0;
        }
      }
      rememberFact(commandId, {
        fingerprint: fingerprint,
        result: result,
        count: count,
        cancelled: wasCancelled
      });
      sendAck(commandId, result, count);
      recordObservation({
        kind: 'candidate',
        commandId: commandId,
        result: result,
        count: count
      });
      return true;
    }

    function handleCancel(message) {
      if (!validCancel(message)) return false;
      var fact = facts.get(message.commandId);
      if (fact && fact.cancelled) return true;
      if (fact) fact.cancelled = true;
      if (rememberCancel(message.commandId)) {
        recordObservation({ kind: 'candidate-cancel', commandId: message.commandId });
      }
      return true;
    }

    function handleMessage(message) {
      if (!enabled || !session) return false;
      var identity = pinnedIdentity();
      if (!identity) return false;
      if (message && message.t === 'deliveryShadowProbe') return handleProbe(message, identity);
      if (message && message.t === 'deliveryShadowCommand') return handleCommand(message, identity);
      if (message && message.t === 'deliveryShadowCancel') return handleCancel(message);
      return false;
    }

    function state() {
      var observationCopies = [];
      for (var index = 0; index < observations.length; index += 1) {
        observationCopies.push(copyObservation(observations[index]));
      }
      return {
        seenCandidate: Array.from(facts.keys()),
        cancelled: Array.from(cancelled.values()),
        observations: observationCopies
      };
    }

    return Object.freeze({
      enabled: enabled,
      onOpen: onOpen,
      handleMessage: handleMessage,
      state: state
    });
  }

  root.KvkDeliveryShadow = Object.freeze({
    isQaRoomName: isQaRoomName,
    create: create
  });
})(typeof window !== 'undefined' ? window : globalThis);
