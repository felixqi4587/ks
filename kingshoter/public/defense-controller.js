(function (root, factory) {
  var api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DefenseController = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  var DRIFT_THRESHOLD_MS = 300;
  var DEFENSE_CUE_WINDOW_MS = 420000;
  var SCHEDULE_RETRY_MS = 1000;

  function callable(value, fallback) {
    return typeof value === "function" ? value : fallback;
  }

  function copy(value) {
    if (!value || typeof value !== "object") return value;
    var result = Array.isArray(value) ? [] : {};
    Object.keys(value).forEach(function (key) {
      var current = value[key];
      result[key] = current && typeof current === "object" ? copy(current) : current;
    });
    return result;
  }

  function publicProfile(profile) {
    if (!profile) return null;
    var result = {
      pid: String(profile.pid || ""),
      identityMode: profile.identityMode === "nickname" ? "nickname" : "playerId",
      name: String(profile.name || profile.pid || ""),
      march: Number(profile.march),
      revision: Number.isInteger(profile.revision) ? profile.revision : 0,
      pendingRemoval: profile.pendingRemoval === true
    };
    if (result.identityMode === "playerId" && profile.playerId) result.playerId = String(profile.playerId);
    return result;
  }

  function publicDraft(draft) {
    if (!draft || typeof draft !== "object") return null;
    var result = {
      identityMode: draft.identityMode === "nickname" ? "nickname" : "playerId",
      name: String(draft.name || ""),
      march: Number(draft.march)
    };
    if (result.identityMode === "playerId") result.playerId = String(draft.playerId || "");
    if (draft.sourceSurface === "rally") result.sourceSurface = "rally";
    return result;
  }

  function audioReady(state) {
    state = state || {};
    return state.userEnabled === true && state.audioContextRunning === true && state.carrierAlive === true;
  }

  function liveRegionProjection(personal, announcement, strings) {
    personal = personal || { captured: false, phase: "waiting" };
    strings = strings || {};
    if (announcement && announcement.kind === "cancelled") {
      return { key: "notice:" + String(announcement.key || "") + ":cancelled", text: String(strings.cancelled || "") };
    }
    if (announcement && announcement.kind === "completed") {
      return { key: "notice:" + String(announcement.key || "") + ":completed", text: "" };
    }
    var planId = personal.captured ? String(personal.planId || "") : "none";
    if (personal.phase === "prepare") {
      return { key: planId + ":prepare", text: String(strings.prepare || "") };
    }
    if (personal.phase === "countdown") {
      var seconds = Math.max(0, Math.ceil(Number(personal.remainingMs || 0) / 1000));
      return { key: planId + ":countdown:" + seconds, text: String(seconds) };
    }
    if (personal.phase === "now") {
      return { key: planId + ":now", text: String(strings.now || "Now") };
    }
    return { key: planId + ":" + String(personal.phase || "waiting"), text: "" };
  }

  function statusPresentation(state, strings) {
    state = state || {};
    strings = strings || {};
    var audioState = state.audio || {};
    var reasons = state.readiness && Array.isArray(state.readiness.reasons) ? state.readiness.reasons : [];
    if (state.connected !== true) return { label: strings.disconnected, level: "danger", mark: "!" };
    if (state.handshakeComplete !== true || reasons.indexOf("handshake_pending") >= 0 ||
        reasons.indexOf("binding_unconfirmed") >= 0) {
      return { label: strings.confirming, level: "warning", mark: "…" };
    }
    if (audioState.userEnabled !== true) return { label: strings.enable, level: "warning", mark: "○" };
    if (audioState.audioContextRunning !== true || audioState.carrierAlive !== true) {
      return { label: strings.restore, level: "warning", mark: "!" };
    }
    if (state.clockFresh !== true) return { label: strings.timeSyncing, level: "warning", mark: "!" };
    if (reasons.indexOf("device_status_unconfirmed") >= 0) {
      return { label: strings.statusUnconfirmed, level: "warning", mark: "!" };
    }
    if (state.readiness && state.readiness.green === true) {
      return { label: strings.ready, level: "ready", mark: "✓" };
    }
    return { label: strings.statusUnconfirmed, level: "warning", mark: "!" };
  }

  function identityModeForKey(currentMode, key) {
    currentMode = currentMode === "nickname" ? "nickname" : "playerId";
    if (key === "Home") return "playerId";
    if (key === "End") return "nickname";
    if (key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown") {
      return currentMode === "playerId" ? "nickname" : "playerId";
    }
    return null;
  }

  function createDefenseController(options) {
    options = options || {};
    var transport = options.transport;
    var identityStore = options.identityStore;
    var identity = options.identity || root.BattleIdentity;
    var status = options.status || root.BattleStatus;
    var domain = options.domain || root.DefenseDomain;
    var audio = options.audio;
    var cues = options.cues;
    var ackQueue = options.ackQueue;
    if (!transport || typeof transport.send !== "function" || typeof transport.serverNowMs !== "function" ||
        !identityStore || !identity || typeof identity.normalizeDraft !== "function" ||
        !status || typeof status.deriveReadiness !== "function" ||
        !domain || typeof domain.personalOrder !== "function" ||
        !audio || typeof audio.state !== "function" || !cues || typeof cues.reconcile !== "function" ||
        !ackQueue || typeof ackQueue.enqueue !== "function") {
      throw new TypeError("Defense controller dependencies are required");
    }

    var onStateChange = callable(options.onStateChange, function () {});
    var randomUUID = callable(options.randomUUID, function () { return root.crypto.randomUUID(); });
    var createNicknamePid = callable(options.createNicknamePid, function () {
      var bytes = root.crypto.getRandomValues(new Uint8Array(11));
      return "n_" + Array.from(bytes, function (byte) { return byte.toString(16).padStart(2, "0"); }).join("");
    });
    var confirmed = identityStore.readConfirmed();
    var prefill = confirmed ? null : identityStore.readRallyPrefill();
    var profile = confirmed ? copy(confirmed) : null;
    var draft = copy(confirmed || prefill || {
      identityMode: "playerId", playerId: "", name: "", march: 90
    });
    var pendingRegistration = null;
    var pendingUpdate = null;
    var handshakeComplete = false;
    var connectionState = { connected: false, generation: 0 };
    var latestAudioState = copy(audio.state());
    var activeRawOrder = null;
    var personal = domain.personalOrder(null, profile && profile.pid, transport.serverNowMs());
    var lastDeviceSignature = "";
    var lastDeviceGeneration = -1;
    var lastRegistrationGeneration = -1;
    var ackOutcomes = Object.create(null);
    var deferredAcks = Object.create(null);
    var lastError = null;
    var deviceStatusHealthy = true;
    var lastScheduleAttemptMs = 0;
    var deliveryBoundGeneration = -1;
    var boundDeviceSignature = "";
    var announcement = null;
    var observedPlanId = "";
    var observedThroughMs = 0;
    var disposed = false;

    function nowMs() { return Math.round(Number(transport.serverNowMs()) || 0); }
    function connected() { return connectionState.connected === true && transport.connected() === true; }
    function clockFresh() { return transport.clockFresh() === true; }
    function currentReadiness() {
      var projected = status.deriveReadiness({
        userEnabled: latestAudioState.userEnabled === true,
        audioContextRunning: latestAudioState.audioContextRunning === true,
        carrierAlive: latestAudioState.carrierAlive === true,
        connected: connected(),
        clockFresh: clockFresh()
      });
      var reasons = projected.reasons.slice();
      if (connected() && !handshakeComplete && reasons.indexOf("handshake_pending") < 0) {
        reasons.push("handshake_pending");
      }
      if (connected() && handshakeComplete && profile &&
          deliveryBoundGeneration !== Number(transport.generation()) &&
          reasons.indexOf("binding_unconfirmed") < 0) {
        reasons.push("binding_unconfirmed");
      }
      if (!deviceStatusHealthy && reasons.indexOf("device_status_unconfirmed") < 0) {
        reasons.push("device_status_unconfirmed");
      }
      if (reasons.length === projected.reasons.length) return projected;
      return Object.freeze({ level: "not_ready", green: false, reasons: Object.freeze(reasons) });
    }

    function presentedPersonal() {
      var value = copy(personal);
      if (value && value.captured === true && value.planId === observedPlanId &&
          observedThroughMs >= value.goAtMs && ackOutcomes[ackKey(value)] === "scheduled") {
        value.phase = observedThroughMs <= value.goAtMs + 1000 ? "now" : "complete";
        value.tooLate = false;
        value.remainingMs = 0;
        return value;
      }
      if (!value || value.captured !== true || value.phase !== "too_late") return value;
      var key = ackKey(value);
      var current = nowMs();
      if (ackOutcomes[key] === "scheduled" && current > value.goAtMs && current <= value.goAtMs + 1000) {
        value.phase = "now";
        value.tooLate = false;
        value.remainingMs = 0;
      } else if (ackOutcomes[key] === "scheduled" && current > value.goAtMs + 1000) {
        value.phase = "complete";
        value.tooLate = false;
        value.remainingMs = 0;
      }
      return value;
    }

    function state() {
      return {
        handshakeComplete: handshakeComplete,
        connected: connected(),
        clockFresh: clockFresh(),
        audio: copy(latestAudioState),
        readiness: copy(currentReadiness()),
        profile: publicProfile(profile),
        draft: publicDraft(draft),
        pendingRegistration: pendingRegistration ? {
          pid: pendingRegistration.pid,
          registrationId: pendingRegistration.registrationId,
          sent: pendingRegistration.sent === true,
          blocked: pendingRegistration.blocked === true
        } : null,
        pendingUpdate: pendingUpdate ? {
          pid: pendingUpdate.pid, mutationId: pendingUpdate.mutationId,
          sent: pendingUpdate.sent === true,
          blocked: pendingUpdate.blocked === true
        } : null,
        personal: presentedPersonal(),
        announcement: copy(announcement),
        lastError: copy(lastError)
      };
    }

    function notify() {
      if (disposed) return;
      try { onStateChange(state()); } catch (_) {}
    }

    function send(message) {
      return !disposed && connected() && transport.send(message) === true;
    }

    function bindingConfirmed() {
      var expected = deviceMessage("defenseDeviceStatus");
      var signature = expected ? [expected.pid, expected.deviceId, expected.soundReady, expected.clockFresh].join(":") : "";
      return connected() && handshakeComplete && !!profile && signature &&
        deliveryBoundGeneration === Number(transport.generation()) && boundDeviceSignature === signature;
    }

    function flushDeferredAcks() {
      Object.keys(deferredAcks).forEach(function (key) {
        var entry = deferredAcks[key];
        delete deferredAcks[key];
        if (entry) queueAck(entry.order, entry.outcome, true);
      });
    }

    function confirmDeviceBinding(message) {
      var expected = deviceMessage("defenseDeviceStatus");
      if (!expected || !message || message.pid !== expected.pid || message.deviceId !== expected.deviceId ||
          message.soundReady !== expected.soundReady || message.clockFresh !== expected.clockFresh) return false;
      var generation = Number(transport.generation());
      deviceStatusHealthy = true;
      if (lastError && (lastError.source === "defenseDeviceStatus" || lastError.source === "hb")) lastError = null;
      if (deliveryBoundGeneration === generation) return true;
      deliveryBoundGeneration = generation;
      boundDeviceSignature = [expected.pid, expected.deviceId, expected.soundReady, expected.clockFresh].join(":");
      if (typeof ackQueue.retryAll === "function") ackQueue.retryAll(true);
      flushDeferredAcks();
      return true;
    }

    function registrationMessage(candidate, registrationId) {
      var message = {
        t: "registerPlayer",
        registrationId: registrationId,
        profileKey: candidate.profileKey,
        pid: candidate.pid,
        identityMode: candidate.identityMode,
        name: candidate.name,
        march: candidate.march
      };
      if (candidate.identityMode === "playerId") message.playerId = candidate.playerId;
      return message;
    }

    function sendPendingRegistration() {
      if (!handshakeComplete || !pendingRegistration || !connected()) return false;
      if (pendingRegistration.blocked === true) return false;
      var generation = Number(transport.generation());
      if (pendingRegistration.sent === true && pendingRegistration.generation === generation) return false;
      var sent = send(registrationMessage(pendingRegistration, pendingRegistration.registrationId));
      if (sent) {
        pendingRegistration.sent = true;
        pendingRegistration.generation = generation;
        lastRegistrationGeneration = generation;
      }
      notify();
      return sent;
    }

    function queueConfirmedRebind() {
      if (!confirmed || !confirmed.pid || !confirmed.profileKey) return false;
      var generation = Number(transport.generation());
      if (lastRegistrationGeneration === generation) return false;
      pendingRegistration = Object.assign(copy(confirmed), {
        registrationId: randomUUID(), sent: false, generation: -1, rebind: true, blocked: false
      });
      return sendPendingRegistration();
    }

    function pendingUpdateMessage() {
      if (!pendingUpdate) return null;
      var message = {
        t: "updateOwnProfile",
        mutationId: pendingUpdate.mutationId,
        profileKey: pendingUpdate.profileKey,
        pid: pendingUpdate.pid,
        baseRevision: pendingUpdate.baseRevision,
        identityMode: pendingUpdate.identityMode,
        name: pendingUpdate.name,
        march: pendingUpdate.march
      };
      if (pendingUpdate.identityMode === "playerId") message.playerId = pendingUpdate.playerId;
      return message;
    }

    function sendPendingUpdate() {
      if (!handshakeComplete || !pendingUpdate || pendingUpdate.blocked || !connected()) return false;
      var generation = Number(transport.generation());
      if (pendingUpdate.sent && pendingUpdate.generation === generation) return false;
      var sent = send(pendingUpdateMessage());
      if (sent) {
        pendingUpdate.sent = true;
        pendingUpdate.everSent = true;
        pendingUpdate.generation = generation;
      }
      notify();
      return sent;
    }

    function deviceMessage(type) {
      if (!profile || !profile.pid || !handshakeComplete) return null;
      return {
        t: type,
        pid: profile.pid,
        deviceId: identityStore.deviceId(),
        soundReady: audioReady(latestAudioState),
        clockFresh: clockFresh()
      };
    }

    function sendDeviceStatus(force) {
      var message = deviceMessage("defenseDeviceStatus");
      if (!message || !connected()) return false;
      var generation = Number(transport.generation());
      var signature = [message.pid, message.deviceId, message.soundReady, message.clockFresh].join(":");
      if (force !== true && signature === lastDeviceSignature && generation === lastDeviceGeneration) return false;
      if (deliveryBoundGeneration !== generation || boundDeviceSignature !== signature) {
        deliveryBoundGeneration = -1;
        boundDeviceSignature = "";
        deviceStatusHealthy = false;
        if (typeof ackQueue.pause === "function") ackQueue.pause();
      }
      if (!send(message)) return false;
      lastDeviceSignature = signature;
      lastDeviceGeneration = generation;
      return true;
    }

    function ackKey(order) {
      return [order.id, order.revision, order.pid, identityStore.deviceId()].join(":");
    }

    function queueAck(order, outcome, fromDeferred) {
      var key = ackKey(order);
      var previous = ackOutcomes[key];
      if (fromDeferred !== true) {
        if (previous === outcome) return false;
        if (previous && outcome !== "scheduled" && !deferredAcks[key] && bindingConfirmed()) return false;
        if (previous && !deferredAcks[key] && typeof ackQueue.cancel === "function") ackQueue.cancel(key);
        if (!bindingConfirmed()) {
          ackOutcomes[key] = outcome;
          deferredAcks[key] = { order: copy(order), outcome: outcome, scope: order.planId };
          return false;
        }
      } else if (!bindingConfirmed()) {
        deferredAcks[key] = { order: copy(order), outcome: outcome, scope: order.planId };
        return false;
      }
      var currentAudioReady = audioReady(latestAudioState);
      var currentClockFresh = clockFresh();
      var payload = {
        t: "defenseOrderAck",
        orderId: order.id,
        orderRevision: order.revision,
        pid: order.pid,
        deviceId: identityStore.deviceId(),
        goAtMs: order.goAtMs,
        outcome: outcome,
        audioReady: currentAudioReady,
        clockFresh: currentClockFresh
      };
      var deadlineAtMs = outcome === "too_late"
        ? Math.max(nowMs() + 1000, Number(order.completeAtMs) || 0)
        : order.goAtMs;
      var queued = ackQueue.enqueue({
        key: key,
        scope: order.planId,
        payload: payload,
        deadlineAtMs: deadlineAtMs
      });
      var accepted = queued || (typeof ackQueue.pending === "function" && !!ackQueue.pending(key));
      if (accepted) ackOutcomes[key] = outcome;
      return !!accepted;
    }

    function cancelActive() {
      if (!personal || personal.captured !== true) {
        activeRawOrder = null;
        personal = domain.personalOrder(null, profile && profile.pid, nowMs());
        observedPlanId = "";
        observedThroughMs = 0;
        return false;
      }
      var scope = domain.cueScope(personal);
      if (scope) {
        try { cues.cancelScope(scope); } catch (_) {}
        try { ackQueue.cancelScope(scope); } catch (_) {}
        Object.keys(deferredAcks).forEach(function (key) {
          var entry = deferredAcks[key];
          if (entry && (entry.scope === scope || String(entry.scope || "").indexOf(scope + ":") === 0)) {
            delete deferredAcks[key];
          }
        });
      }
      activeRawOrder = null;
      personal = domain.personalOrder(null, profile && profile.pid, nowMs());
      observedPlanId = "";
      observedThroughMs = 0;
      return true;
    }

    function observePersonalTime(value) {
      if (!value || value.captured !== true) return 0;
      var observed = Number(value.observedAtMs) || 0;
      if (observedPlanId !== value.planId) {
        observedPlanId = value.planId;
        observedThroughMs = observed;
      } else if (observed > observedThroughMs) {
        observedThroughMs = observed;
      }
      return observedThroughMs;
    }

    function reconcileActive() {
      if (!activeRawOrder || !profile || !profile.pid) {
        cancelActive();
        notify();
        return false;
      }
      var next = domain.personalOrder(activeRawOrder, profile.pid, nowMs());
      if (!next.captured) {
        cancelActive();
        notify();
        return false;
      }
      var firstPlanObservation = observedPlanId !== next.planId;
      if (personal && personal.captured && personal.planId !== next.planId) {
        var previousPlanId = personal.planId;
        try { cues.cancelScope(previousPlanId); } catch (_) {}
        try { ackQueue.cancelScope(previousPlanId); } catch (_) {}
        Object.keys(deferredAcks).forEach(function (key) {
          if (deferredAcks[key] && deferredAcks[key].scope === previousPlanId) delete deferredAcks[key];
        });
      }
      personal = next;
      observePersonalTime(personal);
      announcement = null;
      if (activeRawOrder.tooLate === true) {
        queueAck(personal, "too_late");
        notify();
        return false;
      }
      if (personal.tooLate) {
        notify();
        return false;
      }
      if (!audioReady(latestAudioState)) {
        try { cues.cancelScope(personal.planId); } catch (_) {}
        queueAck(personal, "audio_unready");
        notify();
        return false;
      }
      if (!clockFresh()) {
        queueAck(personal, "clock_stale");
        notify();
        return false;
      }
      var existingScheduledKeys = Object.create(null);
      try {
        if (typeof cues.snapshot === "function") cues.snapshot().forEach(function (entry) {
          if (entry && entry.key && entry.scheduled === true) existingScheduledKeys[entry.key] = true;
        });
      } catch (_) {}
      var events = domain.cuePlan(personal).filter(function (event) {
        var eventAtMs = personal.goAtMs + Number(event.offsetMs || 0);
        var key = personal.planId + ":" + event.id;
        return eventAtMs > observedThroughMs ||
          (eventAtMs === observedThroughMs && (firstPlanObservation || existingScheduledKeys[key] === true));
      });
      var scheduled = false;
      try {
        var plan = {
          id: personal.planId,
          targetAtMs: personal.goAtMs,
          events: events
        };
        lastScheduleAttemptMs = nowMs();
        cues.reconcile([plan], { windowMs: DEFENSE_CUE_WINDOW_MS });
        var registered = typeof cues.snapshot === "function" ? cues.snapshot() : [];
        var keys = Object.create(null);
        registered.forEach(function (entry) {
          if (entry && entry.key && entry.scheduled === true) keys[entry.key] = true;
        });
        scheduled = events.length > 0 && events.every(function (event) {
          return keys[personal.planId + ":" + event.id] === true;
        });
        if (!scheduled) cues.cancelScope(personal.planId);
      } catch (_) { scheduled = false; }
      queueAck(personal, scheduled ? "scheduled" : "schedule_failed");
      notify();
      return scheduled;
    }

    function adoptProfile(canonical, secret) {
      if (!canonical || !canonical.pid) return false;
      var source = secret || confirmed || pendingRegistration || profile || {};
      profile = Object.assign({}, copy(canonical), {
        profileKey: source.profileKey || ""
      });
      confirmed = copy(profile);
      draft = copy(profile);
      identityStore.saveConfirmed(profile);
      pendingRegistration = null;
      pendingUpdate = null;
      lastError = null;
      lastRegistrationGeneration = Number(transport.generation());
      sendDeviceStatus(false);
      return true;
    }

    function adoptProfileSnapshot(canonical) {
      if (!canonical || !canonical.pid) return false;
      var source = confirmed || profile || {};
      profile = Object.assign({}, copy(canonical), { profileKey: source.profileKey || "" });
      confirmed = copy(profile);
      identityStore.saveConfirmed(profile);
      lastRegistrationGeneration = Number(transport.generation());
      sendDeviceStatus(false);
      return true;
    }

    function handleDefenseState(message) {
      handshakeComplete = true;
      if (message.ownProfile && message.ownProfile.pid) {
        if (pendingUpdate) {
          adoptProfileSnapshot(message.ownProfile);
          if (!pendingUpdate.everSent) {
            pendingUpdate.baseRevision = Number.isInteger(message.ownProfile.revision)
              ? message.ownProfile.revision : 0;
            sendPendingUpdate();
          }
        } else adoptProfile(message.ownProfile);
      } else if (pendingRegistration) sendPendingRegistration();
      else queueConfirmedRebind();

      var awaitingAutomaticRebind = !!(pendingRegistration && pendingRegistration.rebind === true && profile);
      var preserveDuringRebind = awaitingAutomaticRebind && personal && personal.captured === true &&
        Number.isInteger(message.orderRevision) && message.orderRevision === personal.revision;

      if (message.activeOrderForOwnProfile && profile &&
          message.activeOrderForOwnProfile.pid === profile.pid) {
        activeRawOrder = copy(message.activeOrderForOwnProfile);
        reconcileActive();
      } else if (!preserveDuringRebind) {
        cancelActive();
      }
      notify();
      return true;
    }

    function handleProfileDelta(message) {
      if (message.removed === true && profile && message.pid === profile.pid) {
        cancelActive();
        profile = null; confirmed = null; pendingRegistration = null; pendingUpdate = null;
        identityStore.saveConfirmed(null);
        notify();
        return true;
      }
      if (!message.profile || !message.profile.pid) return false;
      if (pendingRegistration) {
        if (message.registrationId !== pendingRegistration.registrationId ||
            message.profile.pid !== pendingRegistration.pid) return false;
        adoptProfile(message.profile, pendingRegistration);
      } else if (pendingUpdate) {
        if (message.mutationId !== pendingUpdate.mutationId || message.profile.pid !== pendingUpdate.pid) return false;
        adoptProfile(message.profile, pendingUpdate);
      } else if (profile && message.profile.pid === profile.pid) adoptProfile(message.profile, profile);
      else return false;
      notify();
      return true;
    }

    function clearRejectedAutomaticRebind() {
      var source = draft || profile || confirmed || {};
      var mode = source.identityMode === "nickname" ? "nickname" : "playerId";
      var march = Number(source.march);
      if (!Number.isInteger(march) || march < 5 || march > 120) march = 90;
      var safeName = typeof identity.cleanNickname === "function"
        ? identity.cleanNickname(source.name)
        : String(source.name || "").slice(0, 24);
      cancelActive();
      profile = null;
      confirmed = null;
      pendingRegistration = null;
      pendingUpdate = null;
      draft = { identityMode: mode, name: safeName, march: march };
      if (mode === "playerId") draft.playerId = "";
      identityStore.saveConfirmed(null);
      lastRegistrationGeneration = -1;
      lastDeviceSignature = "";
      lastDeviceGeneration = -1;
      deliveryBoundGeneration = -1;
      boundDeviceSignature = "";
    }

    function handleError(message) {
      var source = String(message.source || "defense");
      var error = String(message.error || "defense_error");
      var retryable = error === "ack_persist_failed" || error === "device_status_persist_failed" ||
        error === "registration_persist_failed" || error === "profile_persist_failed";
      lastError = { source: source, error: error, retryable: retryable };
      if (source === "registerPlayer" && pendingRegistration &&
          (!message.mutationId || message.mutationId === pendingRegistration.registrationId)) {
        if (message.mutationId === pendingRegistration.registrationId &&
            pendingRegistration.rebind === true &&
            (error === "profile_removed" || error === "profile_owner_mismatch")) {
          clearRejectedAutomaticRebind();
        } else {
          pendingRegistration.retryableRebind = pendingRegistration.rebind === true && retryable;
          pendingRegistration.sent = false;
          pendingRegistration.blocked = true;
          if (connected()) transport.send({ t: "hello" });
        }
      } else if ((source === "updateOwnProfile" || source === "updateOwnMarch") && pendingUpdate &&
          (!message.mutationId || message.mutationId === pendingUpdate.mutationId)) {
        pendingUpdate.sent = false;
        pendingUpdate.blocked = true;
        if (connected()) transport.send({ t: "hello" });
      } else if (source === "defenseOrderAck" && personal && personal.captured) {
        var currentAckKey = ackKey(personal);
        var errorRevision = Number.isInteger(message.orderRevision)
          ? message.orderRevision : message.revision;
        var matchesCurrentAck = message.orderId === personal.id &&
          errorRevision === personal.revision && message.pid === personal.pid &&
          message.deviceId === identityStore.deviceId() &&
          message.outcome === ackOutcomes[currentAckKey];
        if (!retryable && matchesCurrentAck && typeof ackQueue.reject === "function") {
          ackQueue.reject(currentAckKey, { error: error, terminal: true });
        }
      } else if (source === "defenseDeviceStatus" || source === "hb") {
        deviceStatusHealthy = false;
        deliveryBoundGeneration = -1;
        boundDeviceSignature = "";
        if (typeof ackQueue.pause === "function") ackQueue.pause();
      }
      notify();
      return true;
    }

    function handleMessage(message) {
      if (disposed || !message || typeof message !== "object") return false;
      if (message.t === "defenseState") return handleDefenseState(message);
      if (!handshakeComplete) return false;
      if (message.t === "error") return handleError(message);
      if (message.t === "defenseProfileDelta") return handleProfileDelta(message);
      if (message.t === "defenseDeviceStatusSaved") {
        if (!confirmDeviceBinding(message)) return false;
        notify();
        return true;
      }
      if (message.t === "defensePresenceDelta" && profile && message.pid === profile.pid) {
        notify();
        return true;
      }
      if (message.t === "defenseOrderAccepted") {
        var candidate = domain.personalOrder(message.order, profile && profile.pid, nowMs());
        if (!candidate.captured) return false;
        activeRawOrder = copy(message.order);
        reconcileActive();
        return true;
      }
      if (message.t === "defenseOrderCancelled" || message.t === "defenseOrderCompleted") {
        if (!domain.matchesTerminal(personal, message)) return false;
        var kind = message.t === "defenseOrderCancelled" ? "cancelled" : "completed";
        cancelActive();
        announcement = { kind: kind, key: String(message.orderId) + ":" + message.revision };
        notify(); return true;
      }
      if (message.t === "defenseAckSaved" && personal && personal.captured &&
          message.orderId === personal.id && message.revision === personal.revision &&
          message.pid === personal.pid && message.deviceId === identityStore.deviceId()) {
        var key = ackKey(personal);
        if (message.outcome !== ackOutcomes[key]) return false;
        ackQueue.confirm(key);
        notify();
        return true;
      }
      return false;
    }

    function connectionChanged(next) {
      next = next || {};
      connectionState = {
        connected: next.connected === true,
        generation: Number.isInteger(next.generation) ? next.generation : Number(transport.generation()) || 0
      };
      deliveryBoundGeneration = -1;
      boundDeviceSignature = "";
      deviceStatusHealthy = false;
      if (typeof ackQueue.pause === "function") ackQueue.pause();
      if (connectionState.connected) {
        handshakeComplete = false;
        lastDeviceSignature = "";
        transport.send({ t: "hello" });
      } else {
        handshakeComplete = false;
        if (pendingUpdate && pendingUpdate.everSent) {
          pendingUpdate.sent = false;
          pendingUpdate.blocked = true;
          lastError = { source: "updateOwnProfile", error: "reconnect_retry_required", retryable: true };
        }
      }
      notify();
    }

    function confirmProfile(input) {
      if ((pendingRegistration && !pendingRegistration.blocked) ||
          (pendingUpdate && !pendingUpdate.blocked)) return { ok: false, error: "operation_pending" };
      var normalized = identity.normalizeDraft(input);
      if (!normalized.ok) return normalized;
      var next = normalized.profile;
      if (pendingRegistration && pendingRegistration.blocked === true &&
          pendingRegistration.rebind === true && pendingRegistration.retryableRebind === true) {
        var retryRegistration = copy(pendingRegistration);
        retryRegistration.march = next.march;
        if (retryRegistration.identityMode === next.identityMode) {
          if (next.identityMode === "nickname") retryRegistration.name = next.name;
          else if (next.playerId === retryRegistration.playerId) retryRegistration.name = next.name;
        }
        pendingRegistration = Object.assign(retryRegistration, {
          registrationId: randomUUID(), sent: false, generation: -1, blocked: false
        });
        draft = copy(next);
        lastError = null;
        sendPendingRegistration();
        notify();
        return { ok: true, pending: true, operation: "rebind" };
      }
      if (profile && confirmed && confirmed.profileKey) {
        pendingUpdate = Object.assign(copy(next), {
          mutationId: randomUUID(),
          profileKey: confirmed.profileKey,
          pid: confirmed.pid,
          baseRevision: Number.isInteger(profile.revision) ? profile.revision : 0,
          sent: false,
          blocked: false,
          everSent: false,
          generation: -1
        });
        if (next.identityMode === "playerId") pendingUpdate.playerId = next.playerId;
        draft = copy(next);
        sendPendingUpdate();
        notify();
        return { ok: true, pending: true, operation: "update" };
      }
      var pid = next.identityMode === "playerId" ? next.playerId : createNicknamePid();
      pendingRegistration = Object.assign(copy(next), {
        pid: pid,
        profileKey: randomUUID(),
        registrationId: randomUUID(),
        sent: false,
        generation: -1,
        rebind: false,
        blocked: false
      });
      draft = copy(next);
      sendPendingRegistration();
      notify();
      return { ok: true, pending: true, operation: "register" };
    }

    function enableAlerts() {
      latestAudioState = copy(audio.enable());
      sendDeviceStatus(true);
      reconcileActive();
      notify();
      return copy(latestAudioState);
    }

    function audioChanged(next) {
      latestAudioState = copy(next || audio.state());
      sendDeviceStatus(false);
      reconcileActive();
      notify();
    }

    function clockChanged(next) {
      var offsetMs = Number(next && next.offsetMs) || 0;
      try { cues.cancelDrifted(offsetMs, DRIFT_THRESHOLD_MS); } catch (_) {}
      sendDeviceStatus(false);
      reconcileActive();
      notify();
    }

    function heartbeat() {
      if (profile && (!bindingConfirmed() || deviceStatusHealthy !== true)) {
        return sendDeviceStatus(true);
      }
      var message = deviceMessage("hb");
      return !!(message && send(message));
    }

    function tick() {
      if (activeRawOrder && profile) {
        personal = domain.personalOrder(activeRawOrder, profile.pid, nowMs());
        observePersonalTime(personal);
      }
      var current = nowMs();
      if (personal && personal.captured && !personal.tooLate && Number(personal.goAtMs) > current &&
          ackOutcomes[ackKey(personal)] === "schedule_failed" &&
          current - lastScheduleAttemptMs >= SCHEDULE_RETRY_MS) {
        reconcileActive();
        return copy(personal);
      }
      notify();
      return copy(personal);
    }

    function dispose() {
      if (disposed) return;
      cancelActive();
      if (typeof ackQueue.clear === "function") ackQueue.clear();
      disposed = true;
    }

    notify();
    return Object.freeze({
      state: state,
      connectionChanged: connectionChanged,
      clockChanged: clockChanged,
      audioChanged: audioChanged,
      handleMessage: handleMessage,
      confirmProfile: confirmProfile,
      enableAlerts: enableAlerts,
      sendDeviceStatus: sendDeviceStatus,
      heartbeat: heartbeat,
      tick: tick,
      dispose: dispose
    });
  }

  var STRINGS = Object.freeze({
    en: Object.freeze({
      title: "Defense Coordination",
      joinTitle: "Enter a Defense room",
      joinHint: "Use the same room name as your alliance.",
      room: "Room",
      enter: "Enter",
      yourInfo: "Your info",
      profileHint: "Enter Player ID or nickname and your march time to the castle.",
      playerId: "Player ID",
      recommended: "Recommended",
      nickname: "Nickname",
      march: "March time to the castle",
      save: "Save",
      saving: "Saving…",
      edit: "Edit",
      you: "You",
      yourMarch: "Your march time",
      scale: "Personal distance scale · maximum 2:00",
      enable: "Enable page alerts",
      ready: "Alerts on · switch to the game",
      restore: "Tap to restore alerts",
      disconnected: "Connection lost · reconnecting",
      confirming: "Connected · confirming this device",
      statusUnconfirmed: "Connected · alert status unconfirmed",
      timeSyncing: "Connected · synchronizing time",
      waiting: "Waiting for the next Defense order",
      waitingSupport: "Keep this page open. Your countdown will appear here.",
      timing: "Personal Defense timing",
      scheduled: "Order received · waiting for your alert",
      prepare: "Prepare",
      getReady: "Get ready",
      now: "Now",
      complete: "Your alert is complete",
      completeSupport: "Waiting for the next Defense order.",
      cancelled: "Order cancelled",
      tooLate: "Too late · wait for the next order",
      noReplay: "No partial alert was replayed on this device.",
      console: "Defense Console",
      settings: "Alert settings",
      test: "Test this device's alert",
      invalidPlayerId: "Enter a valid Player ID.",
      invalidNickname: "Enter a nickname.",
      invalidMarch: "March time must be between 0:05 and 2:00.",
      pending: "Waiting for the room to confirm this profile…",
      roomFull: "This Defense room is full.",
      retrySave: "Connection changed. Review and save again.",
      saveFailed: "Could not save. Review and try again.",
      roomRequired: "Enter a room name.",
      languageLabel: "Switch language",
      identityType: "Identity type",
      decreaseMarch: "Decrease march time",
      increaseMarch: "Increase march time",
      profileLabel: "Your Defense profile",
      localSchedule: "Website timing only · the game does not send live data to this page."
    }),
    zh: Object.freeze({
      title: "防守协调",
      joinTitle: "进入防守房间",
      joinHint: "输入与你的联盟约定的同一个房间名。",
      room: "房间",
      enter: "进入",
      yourInfo: "你的信息",
      profileHint: "输入 Player ID 或昵称，以及你到王城的行军时间。",
      playerId: "Player ID",
      recommended: "推荐",
      nickname: "昵称",
      march: "到王城行军时间",
      save: "保存",
      saving: "保存中…",
      edit: "修改",
      you: "你",
      yourMarch: "你的行军时间",
      scale: "个人距离比例 · 最大 2:00",
      enable: "开启页面提醒",
      ready: "提醒已开启 · 可切换到游戏",
      restore: "点击恢复提醒",
      disconnected: "连接已断开 · 正在重连",
      confirming: "已连接 · 正在确认本设备",
      statusUnconfirmed: "已连接 · 提醒状态尚未确认",
      timeSyncing: "已连接 · 正在同步时间",
      waiting: "等待下一轮防守指令",
      waitingSupport: "保持页面打开，你的个人倒数会显示在这里。",
      timing: "个人防守时间",
      scheduled: "已收到指令 · 等待你的提醒",
      prepare: "准备",
      getReady: "即将行动",
      now: "Now",
      complete: "本轮提醒已完成",
      completeSupport: "正在等待下一轮防守指令。",
      cancelled: "指令已取消",
      tooLate: "已错过 · 等待下一轮",
      noReplay: "本设备不会补播不完整的提醒。",
      console: "防守指挥台",
      settings: "提醒设置",
      test: "测试本设备提醒",
      invalidPlayerId: "请输入有效的 Player ID。",
      invalidNickname: "请输入昵称。",
      invalidMarch: "行军时间必须在 0:05 到 2:00 之间。",
      pending: "正在等待房间确认这个玩家…",
      roomFull: "这个防守房间人数已满。",
      retrySave: "连接已变化，请检查后重新保存。",
      saveFailed: "保存失败，请检查后重试。",
      roomRequired: "请输入房间名。",
      languageLabel: "切换语言",
      identityType: "身份类型",
      decreaseMarch: "减少行军时间",
      increaseMarch: "增加行军时间",
      profileLabel: "你的防守资料",
      localSchedule: "仅为网站时间安排 · 游戏不会把实时数据传到本页面。"
    })
  });

  function normalizeRoom(value) {
    return String(value || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48);
  }

  function formatSeconds(value) {
    value = Math.max(0, Math.round(Number(value) || 0));
    return Math.floor(value / 60) + ":" + String(value % 60).padStart(2, "0");
  }

  function mountDefensePage(options) {
    options = options || {};
    var win = options.window || root;
    var doc = options.document || win.document;
    if (!doc) throw new TypeError("Defense page document is required");
    var qp = new win.URLSearchParams(win.location.search);
    var room = normalizeRoom(qp.get("room"));
    var language = qp.get("lang") === "zh" || qp.get("lang") === "en"
      ? qp.get("lang")
      : (/^zh/i.test(win.navigator && win.navigator.language || "") ? "zh" : "en");
    var text = STRINGS[language];
    var controller = null;
    var connection = null;
    var battleAudio = null;
    var cueScheduler = null;
    var tickTimer = null;
    var heartbeatTimer = null;
    var clockTimer = null;
    var lastState = null;
    var currentMode = "playerId";
    var identityDrafts = { playerId: "", nickname: "" };
    var editing = false;
    var formSeeded = false;
    var lastAnnouncement = "";

    function element(id) { return doc.getElementById(id); }
    function setNodeText(target, value) {
      value = String(value == null ? "" : value);
      if (target && target.textContent !== value) target.textContent = value;
    }
    function setText(id, value) { setNodeText(element(id), value); }
    function updateClock() {
      var target = element("defenseLocalClock");
      if (!target) return;
      setNodeText(target, new Date().toLocaleTimeString([], {
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
      }));
    }

    function applyStrings() {
      text = STRINGS[language];
      doc.documentElement.lang = language === "zh" ? "zh-CN" : "en";
      doc.title = "kingshoter · " + text.title;
      setText("defenseTitle", text.title);
      setText("defenseJoinTitle", text.joinTitle);
      setText("defenseJoinHint", text.joinHint);
      setText("defenseRoomInputLabel", text.room);
      setText("defenseJoinButton", text.enter);
      setText("defenseProfileTitle", text.yourInfo);
      setText("defenseProfileHint", text.profileHint);
      setText("defenseModePlayerId", text.playerId + " · " + text.recommended);
      setText("defenseModeNickname", text.nickname);
      setText("defenseMarchLabel", text.march);
      setText("defenseSaveProfile", text.save);
      setText("defenseYouPrefix", text.you);
      setText("defenseEditProfile", text.edit);
      setText("defenseProgressTitle", text.yourMarch);
      setText("defenseProgressCopy", text.scale);
      setText("defensePersonalEyebrow", text.timing);
      setText("defenseConsoleLabel", text.console);
      setText("defenseSettingsLabel", text.settings);
      setText("defenseTestAlert", text.test);
      setText("defenseLanguage", language === "en" ? "中文" : "EN");
      setText("defenseRoomLabel", room ? text.room + " · " + room : "—");
      element("defenseLanguage").setAttribute("aria-label", text.languageLabel);
      element("defenseIdentityMode").setAttribute("aria-label", text.identityType);
      element("defenseMarchMinus").setAttribute("aria-label", text.decreaseMarch);
      element("defenseMarchPlus").setAttribute("aria-label", text.increaseMarch);
      element("defenseYouCard").setAttribute("aria-label", text.profileLabel);
      syncIdentityMode();
      if (lastState) {
        lastAnnouncement = "";
        render(lastState);
      }
    }

    function syncIdentityMode() {
      var nickname = currentMode === "nickname";
      var playerButton = element("defenseModePlayerId");
      var nicknameButton = element("defenseModeNickname");
      var input = element("defenseIdentityValue");
      if (!playerButton || !nicknameButton || !input) return;
      playerButton.classList.toggle("is-selected", !nickname);
      nicknameButton.classList.toggle("is-selected", nickname);
      playerButton.setAttribute("aria-checked", nickname ? "false" : "true");
      nicknameButton.setAttribute("aria-checked", nickname ? "true" : "false");
      playerButton.tabIndex = nickname ? -1 : 0;
      nicknameButton.tabIndex = nickname ? 0 : -1;
      input.inputMode = nickname ? "text" : "numeric";
      input.maxLength = nickname ? 24 : 16;
      input.value = identityDrafts[currentMode] || "";
      setText("defenseIdentityLabel", nickname ? text.nickname : text.playerId);
    }

    function seedForm(state) {
      if (formSeeded || !state || (!state.draft && !state.profile)) return;
      var source = state.draft || state.profile;
      currentMode = source.identityMode === "nickname" ? "nickname" : "playerId";
      identityDrafts.nickname = currentMode === "nickname" ? String(source.name || "") : "";
      identityDrafts.playerId = currentMode === "playerId" ? String(source.playerId || source.pid || "") : "";
      element("defenseMarchRange").value = Math.min(120, Math.max(5, Number(source.march) || 90));
      formSeeded = true;
      syncIdentityMode();
      paintMarch(Number(element("defenseMarchRange").value));
    }

    function paintMarch(seconds) {
      seconds = Math.min(120, Math.max(5, Math.round(Number(seconds) || 5)));
      if (element("defenseMarchRange")) element("defenseMarchRange").value = seconds;
      setText("defenseMarchValue", formatSeconds(seconds));
    }

    function paintProgress(profile) {
      var march = profile ? Math.min(120, Math.max(5, Number(profile.march) || 5)) : 0;
      var percent = (march / 120 * 100).toFixed(3) + "%";
      var progress = element("defenseProgress");
      if (!progress) return;
      if (profile) {
        progress.setAttribute("aria-valuenow", String(march));
        progress.setAttribute("aria-valuetext", formatSeconds(march) + " " + text.march);
      } else {
        progress.removeAttribute("aria-valuenow");
        progress.removeAttribute("aria-valuetext");
      }
      progress.style.setProperty("--defense-progress", percent);
      var fill = progress.querySelector(".defense-progress__fill");
      if (fill) fill.style.width = percent;
      setText("defenseProgressTime", profile ? formatSeconds(march) : "—:—");
    }

    function paintStatus(state) {
      var strip = element("defenseStatus");
      var presentation = statusPresentation(state, text);
      strip.dataset.level = presentation.level;
      setText("defenseStatusLabel", presentation.label);
      var marker = strip.querySelector(".battle-status-strip__mark");
      setNodeText(marker, presentation.mark);
      var audioButton = element("defenseAudioRow");
      audioButton.dataset.ready = state.readiness.green ? "true" : "false";
      setText("defenseAudioLabel", presentation.label);
    }

    function paintPersonal(personal, notice) {
      personal = personal || { phase: "waiting", captured: false };
      var card = element("defensePersonal");
      card.dataset.phase = personal.phase;
      var title = text.waiting;
      var countdown = "—:—";
      var support = text.waitingSupport;
      if (personal.captured) {
        var seconds = Math.max(0, Math.ceil(Number(personal.remainingMs || 0) / 1000));
        if (personal.phase === "scheduled") {
          title = text.scheduled; countdown = formatSeconds(seconds); support = text.localSchedule;
        } else if (personal.phase === "prepare") {
          title = text.prepare; countdown = formatSeconds(seconds); support = text.localSchedule;
        } else if (personal.phase === "beep") {
          title = text.getReady; countdown = String(seconds); support = text.localSchedule;
        } else if (personal.phase === "countdown") {
          title = text.getReady; countdown = String(seconds); support = text.localSchedule;
        } else if (personal.phase === "now") {
          title = text.now; countdown = text.now; support = text.localSchedule;
        } else if (personal.phase === "complete") {
          title = text.complete; countdown = "✓"; support = text.completeSupport;
        } else if (personal.phase === "too_late") {
          title = text.tooLate; countdown = "—"; support = text.noReplay;
        }
      }
      setText("defensePersonalTitle", title);
      setText("defenseCountdown", countdown);
      setText("defensePersonalSupport", support);

      var live = liveRegionProjection(personal, notice, text);
      if (live.key !== lastAnnouncement) setText("defenseCountdownLive", live.text);
      lastAnnouncement = live.key;
    }

    function profileErrorText(lastError) {
      if (!lastError || (lastError.source !== "registerPlayer" &&
          lastError.source !== "updateOwnProfile" && lastError.source !== "updateOwnMarch")) return "";
      if (lastError.error === "roster_full") return text.roomFull;
      if (lastError.error === "reconnect_retry_required" || lastError.error === "revision_conflict") {
        return text.retrySave;
      }
      return text.saveFailed;
    }

    function render(state) {
      lastState = state;
      updateClock();
      seedForm(state);
      paintStatus(state);
      var hasProfile = !!state.profile;
      var pendingRegistration = state.pendingRegistration;
      var pendingUpdate = state.pendingUpdate;
      var pending = !!(pendingRegistration || pendingUpdate);
      var busy = !!((pendingRegistration && !pendingRegistration.blocked) ||
        (pendingUpdate && !pendingUpdate.blocked));
      var profileError = profileErrorText(state.lastError);
      var displayedProfile = state.personal && state.personal.captured ? {
        pid: state.personal.pid,
        name: state.personal.displayName,
        march: state.personal.march
      } : state.profile;
      element("defenseProfileCard").hidden = hasProfile && !editing;
      element("defenseYouCard").hidden = !hasProfile || editing;
      element("defenseProgressCard").hidden = !hasProfile;
      if (hasProfile) {
        setText("defenseYouName", displayedProfile.name || displayedProfile.pid);
        setText("defenseYouMarch", formatSeconds(displayedProfile.march));
      }
      var save = element("defenseSaveProfile");
      save.disabled = busy;
      save.textContent = busy ? text.saving : text.save;
      setText("defenseProfileStatus", busy ? text.pending : profileError);
      setText("defenseYouStatus", busy ? text.pending : profileError);
      paintProgress(state.personal && state.personal.captured ? state.personal : state.profile);
      paintPersonal(state.personal, state.announcement);
    }

    function setMode(mode, focusRadio) {
      mode = mode === "nickname" ? "nickname" : "playerId";
      var input = element("defenseIdentityValue");
      identityDrafts[currentMode] = input.value;
      currentMode = mode;
      syncIdentityMode();
      if (focusRadio === true) {
        element(mode === "nickname" ? "defenseModeNickname" : "defenseModePlayerId").focus();
      } else input.focus();
    }

    function wireStaticControls() {
      element("defenseLanguage").addEventListener("click", function () {
        language = language === "en" ? "zh" : "en";
        applyStrings();
      });
      element("defenseJoinForm").addEventListener("submit", function (event) {
        event.preventDefault();
        var nextRoom = normalizeRoom(element("defenseRoomInput").value);
        if (!nextRoom) { setText("defenseJoinHint", text.roomRequired); return; }
        var next = new win.URL(win.location.href);
        next.pathname = next.pathname.endsWith(".html") ? next.pathname : "/defense";
        next.search = "?room=" + encodeURIComponent(nextRoom) + "&lang=" + language;
        win.location.assign(next.toString());
      });
      element("defenseModePlayerId").addEventListener("click", function (event) {
        setMode("playerId", event.detail === 0);
      });
      element("defenseModeNickname").addEventListener("click", function (event) {
        setMode("nickname", event.detail === 0);
      });
      element("defenseIdentityMode").addEventListener("keydown", function (event) {
        if (event.target !== element("defenseModePlayerId") && event.target !== element("defenseModeNickname")) return;
        var nextMode = identityModeForKey(currentMode, event.key);
        if (!nextMode) return;
        event.preventDefault();
        setMode(nextMode, true);
      });
      element("defenseIdentityValue").addEventListener("input", function () {
        if (currentMode === "playerId") this.value = this.value.replace(/\D/g, "").slice(0, 16);
        identityDrafts[currentMode] = this.value;
      });
      element("defenseMarchRange").addEventListener("input", function () { paintMarch(this.value); });
      element("defenseMarchMinus").addEventListener("click", function () {
        paintMarch(Number(element("defenseMarchRange").value) - 1);
      });
      element("defenseMarchPlus").addEventListener("click", function () {
        paintMarch(Number(element("defenseMarchRange").value) + 1);
      });
      element("defenseSaveProfile").addEventListener("click", function () {
        identityDrafts[currentMode] = element("defenseIdentityValue").value;
        var value = identityDrafts[currentMode];
        var result = controller.confirmProfile({
          identityMode: currentMode,
          playerId: currentMode === "playerId" ? value : "",
          name: currentMode === "nickname" ? value : value,
          march: Number(element("defenseMarchRange").value)
        });
        if (!result.ok) {
          setText("defenseProfileStatus", result.error === "invalid_player_id" ? text.invalidPlayerId :
            result.error === "invalid_nickname" ? text.invalidNickname : text.invalidMarch);
        } else {
          editing = false;
          render(controller.state());
        }
      });
      element("defenseEditProfile").addEventListener("click", function () {
        editing = true;
        formSeeded = false;
        seedForm(lastState);
        render(lastState);
        element("defenseIdentityValue").focus();
      });
      function enableAndTest() {
        controller.enableAlerts();
        try { battleAudio.playConfirm(); } catch (_) {}
      }
      element("defenseAudioRow").addEventListener("click", enableAndTest);
      element("defenseTestAlert").addEventListener("click", enableAndTest);
      element("defenseConsoleEntry").addEventListener("click", function () {
        element("defenseConsoleEntry").dispatchEvent(new win.CustomEvent("defense:open-console", { bubbles: true }));
      });
    }

    wireStaticControls();
    applyStrings();
    setText("defenseRoomLabel", room ? text.room + " · " + room : "—");
    element("defenseJoin").hidden = !!room;
    element("defenseRoom").hidden = !room;
    if (!room) return Object.freeze({ room: "", controller: null, dispose: function () {} });

    var identityStore = win.BattleIdentity.createIdentityStore({
      room: room, surface: "defense", storage: win.localStorage, rallyPrefill: true
    });
    battleAudio = win.BattleAudio.createAudioEngine({
      language: function () { return language; },
      mediaTitle: "Kingshoter Defense alerts on",
      onStateChange: function (next) { if (controller) controller.audioChanged(next); }
    });
    connection = win.BattleConnection.createRoomConnection({
      room: room,
      surface: "defense",
      clientBuild: Number(options.clientBuild) || 2026071603,
      onMessage: function (message) {
        if (controller) controller.handleMessage(message);
      },
      onConnectionChange: function (next) { if (controller) controller.connectionChanged(next); },
      onClockChange: function (next) { if (controller) controller.clockChanged(next); }
    });
    cueScheduler = win.BattleCues.createCueScheduler({
      audio: battleAudio,
      nowMs: connection.serverNowMs,
      clockOffsetMs: function () { return connection.serverNowMs() - Date.now(); }
    });
    var ackQueue = win.BattleDelivery.createAckQueue({
      send: connection.send,
      nowMs: connection.serverNowMs,
      generation: connection.generation
    });
    controller = createDefenseController({
      transport: connection,
      identityStore: identityStore,
      identity: win.BattleIdentity,
      status: win.BattleStatus,
      domain: win.DefenseDomain,
      audio: battleAudio,
      cues: cueScheduler,
      ackQueue: ackQueue,
      onStateChange: render
    });
    win.defensePageController = controller;
    connection.start();
    tickTimer = win.setInterval(function () {
      if (lastState && lastState.personal && lastState.personal.captured) controller.tick();
      else updateClock();
    }, 100);
    heartbeatTimer = win.setInterval(function () { controller.heartbeat(); }, 25000);
    clockTimer = win.setInterval(updateClock, 1000);
    doc.addEventListener("visibilitychange", function () {
      if (!doc.hidden && lastState && lastState.audio.userEnabled) {
        try { battleAudio.resume(); battleAudio.requestWakeLock(); } catch (_) {}
      }
    });

    function dispose() {
      if (tickTimer) win.clearInterval(tickTimer);
      if (heartbeatTimer) win.clearInterval(heartbeatTimer);
      if (clockTimer) win.clearInterval(clockTimer);
      try { controller.dispose(); } catch (_) {}
      try { cueScheduler.dispose(); } catch (_) {}
      try { battleAudio.dispose(); } catch (_) {}
      try { connection.stop(); } catch (_) {}
    }
    win.addEventListener("pagehide", dispose, { once: true });
    return Object.freeze({ room: room, controller: controller, connection: connection, dispose: dispose });
  }

  /* The browser mount below intentionally consumes the existing shared
     BattleAudio and BattleCues implementations; Defense owns only policy. */
  var api = Object.freeze({
    DRIFT_THRESHOLD_MS: DRIFT_THRESHOLD_MS,
    DEFENSE_CUE_WINDOW_MS: DEFENSE_CUE_WINDOW_MS,
    liveRegionProjection: liveRegionProjection,
    statusPresentation: statusPresentation,
    identityModeForKey: identityModeForKey,
    createDefenseController: createDefenseController,
    mountDefensePage: mountDefensePage
  });
  if (root && root.document) {
    var mount = function () {
      if (!root.__kingshoterDefenseMounted) root.__kingshoterDefenseMounted = mountDefensePage();
    };
    if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", mount, { once: true });
    else mount();
  }
  return api;
}));
