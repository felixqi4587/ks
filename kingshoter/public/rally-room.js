(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.RallyRoom = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function kingdomKey(value) {
    return Number(value) === 2 ? 2 : 1;
  }

  function kingdomRecord(sourceRoom, kingdom) {
    var key = kingdomKey(kingdom);
    var names = sourceRoom && sourceRoom.rallyRoom && sourceRoom.rallyRoom.kingdomNames;
    var raw = names && (names[key] || names[String(key)]);
    return {
      name: raw && typeof raw.name === "string" ? raw.name : "",
      revision: raw && Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0
    };
  }

  function kingdomLabel(sourceRoom, kingdom, fallback) {
    var record = kingdomRecord(sourceRoom, kingdom);
    return record.name || String(fallback || ("Kingdom " + kingdomKey(kingdom)));
  }

  function connectedWebsiteDevices(sourceRoom) {
    var value = sourceRoom && sourceRoom.rallyRoom && sourceRoom.rallyRoom.managerMeta &&
      sourceRoom.rallyRoom.managerMeta.connectedWebsiteDevices;
    return Number.isInteger(value) && value >= 0 ? value : 0;
  }

  function cleanName(value) {
    return String(value == null ? "" : value).normalize("NFC")
      .replace(/\s+/g, " ")
      .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
      .trim();
  }

  function graphemeCount(value) {
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
      return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)).length;
    }
    return Array.from(value).length;
  }

  function validateKingdomName(value) {
    if (typeof value !== "string") return { ok: false, error: "invalid_kingdom_name" };
    var name = cleanName(value);
    if (graphemeCount(name) > 24) return { ok: false, error: "invalid_kingdom_name" };
    return { ok: true, name: name };
  }

  function roomURL(locationLike, roomName) {
    var origin = locationLike && typeof locationLike.origin === "string"
      ? locationLike.origin.replace(/\/$/, "") : "";
    var room = String(roomName || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48);
    return origin + "/rally" + (room ? "?room=" + encodeURIComponent(room) : "");
  }

  function frozenCopy(value) {
    return value ? Object.freeze(Object.assign({}, value)) : null;
  }

  function createNameMutation(options) {
    options = options || {};
    var send = typeof options.send === "function" ? options.send : function () { return false; };
    var createMutationId = typeof options.createMutationId === "function"
      ? options.createMutationId : function () { return crypto.randomUUID(); };
    var onChange = typeof options.onChange === "function" ? options.onChange : function () {};
    var pending = null, outcome = null;

    function snapshot() {
      var publicPending = pending ? {
        mutationId: pending.mutationId,
        kingdom: pending.kingdom,
        name: pending.name,
        baseRevision: pending.baseRevision,
        ackSeen: pending.ackSeen,
        stateSeen: pending.stateSeen,
        status: pending.status
      } : null;
      return Object.freeze({ pending: frozenCopy(publicPending), outcome: frozenCopy(outcome) });
    }

    function notify() {
      try { onChange(snapshot()); } catch (error) {}
    }

    function sendPending() {
      if (!pending) return false;
      var sent = false;
      try { sent = send(pending.message) === true; } catch (error) { sent = false; }
      pending.status = sent ? "saving" : "retry";
      notify();
      return sent;
    }

    function finish(nextOutcome) {
      pending = null;
      outcome = Object.freeze(nextOutcome);
      notify();
      return true;
    }

    function settle() {
      if (!pending || !pending.ackSeen || !pending.stateSeen) return false;
      return finish({
        status: "saved", kingdom: pending.kingdom,
        name: pending.name, revision: pending.baseRevision + 1
      });
    }

    function request(input) {
      input = input || {};
      if (pending) return false;
      var valid = validateKingdomName(input.name);
      var baseRevision = Number(input.baseRevision), password = String(input.password || "");
      var mutationId = String(createMutationId() || "");
      var requestedKingdom = Number(input.kingdom);
      if (!valid.ok || (requestedKingdom !== 1 && requestedKingdom !== 2) ||
          !Number.isInteger(baseRevision) || baseRevision < 0 || !password || !mutationId) return false;
      var kingdom = kingdomKey(input.kingdom);
      var message = Object.freeze({
        t: "setKingdomName", mutationId: mutationId, password: password,
        kingdom: kingdom, name: valid.name, baseRevision: baseRevision
      });
      outcome = null;
      pending = {
        mutationId: mutationId, kingdom: kingdom, name: valid.name,
        baseRevision: baseRevision, ackSeen: false, stateSeen: false,
        status: "saving", message: message
      };
      sendPending();
      return true;
    }

    function handleState(sourceRoom) {
      if (!pending) return false;
      var record = kingdomRecord(sourceRoom, pending.kingdom);
      var expectedRevision = pending.baseRevision + 1;
      if (record.revision === expectedRevision && record.name === pending.name) {
        pending.stateSeen = true;
        notify();
        return settle();
      }
      if (record.revision > expectedRevision ||
          (record.revision === expectedRevision && record.name !== pending.name)) {
        return finish({
          status: "conflict", kingdom: pending.kingdom, name: pending.name,
          canonical: record
        });
      }
      return false;
    }

    function handleMessage(message) {
      if (!pending || !message || message.mutationId !== pending.mutationId) return false;
      if (message.t === "kingdomNameSaved") {
        if (Number(message.kingdom) !== pending.kingdom || message.name !== pending.name ||
            message.revision !== pending.baseRevision + 1) return false;
        pending.ackSeen = true;
        notify();
        settle();
        return true;
      }
      if (message.t !== "error") return false;
      if (message.error === "kingdom_name_conflict") {
        var raw = message.record || {};
        var canonical = {
          name: typeof raw.name === "string" ? raw.name : "",
          revision: Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0
        };
        return finish({
          status: "conflict", kingdom: pending.kingdom,
          name: pending.name, canonical: canonical
        });
      }
      if (message.error === "bad_password") {
        return finish({ status: "bad_password", kingdom: pending.kingdom, name: pending.name });
      }
      if (["invalid_kingdom_name", "invalid_mutation", "mutation_id_conflict"].indexOf(message.error) >= 0) {
        return finish({ status: "error", error: message.error, kingdom: pending.kingdom, name: pending.name });
      }
      return false;
    }

    function disconnected() {
      if (!pending) return false;
      pending.status = "retry";
      notify();
      return true;
    }

    function connected() {
      if (!pending) return false;
      return sendPending();
    }

    return Object.freeze({
      request: request,
      handleState: handleState,
      handleMessage: handleMessage,
      disconnected: disconnected,
      connected: connected,
      snapshot: snapshot
    });
  }

  return Object.freeze({
    kingdomRecord: kingdomRecord,
    kingdomLabel: kingdomLabel,
    connectedWebsiteDevices: connectedWebsiteDevices,
    validateKingdomName: validateKingdomName,
    roomURL: roomURL,
    createNameMutation: createNameMutation
  });
});
