(function (root, factory) {
  var api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BattleIdentity = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var PLAYER_ID = /^\d{1,16}$/;
  var CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

  function cleanNickname(value) {
    return Array.from(String(value == null ? "" : value)
      .replace(CONTROL_CHARS, "")
      .trim().replace(/\s+/g, " ")).slice(0, 24).join("");
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character];
    });
  }

  function parseMarch(value) {
    if (value === "" || value == null || typeof value === "boolean") return null;
    var parsed = typeof value === "number" ? value : Number(value);
    return Number.isInteger(parsed) && parsed >= 5 && parsed <= 120 ? parsed : null;
  }

  function normalizeDraft(input) {
    input = input || {};
    var march = parseMarch(input.march);
    if (march === null) return { ok: false, error: "invalid_march" };
    var mode = input.identityMode;
    var name = cleanNickname(input.name);
    if (mode === "nickname") {
      if (!name) return { ok: false, error: "invalid_nickname" };
      return { ok: true, profile: { identityMode: "nickname", name: name, march: march } };
    }
    if (mode !== "playerId" || !PLAYER_ID.test(String(input.playerId == null ? "" : input.playerId).trim())) {
      return { ok: false, error: "invalid_player_id" };
    }
    var playerId = String(input.playerId).trim();
    return {
      ok: true,
      profile: { identityMode: "playerId", playerId: playerId, name: name || playerId, march: march }
    };
  }

  function cloneRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    var copy = {};
    Object.keys(value).forEach(function (key) { copy[key] = value[key]; });
    return copy;
  }

  function createIdentityStore(options) {
    options = options || {};
    var room = String(options.room || "");
    var surface = String(options.surface || "");
    if (surface !== "rally" && surface !== "defense") {
      throw new TypeError("BattleIdentity surface must be rally or defense");
    }
    var storage = options.storage || root.localStorage;
    if (!storage) throw new TypeError("BattleIdentity storage is required");
    var rallyConfirmedKey = "kingshoter_r_" + room + "_me";
    var confirmedKey = surface === "rally" ? rallyConfirmedKey : "kingshoter_defense_r_" + room + "_me";
    var deviceKey = surface === "rally" ?
      "kvk:" + room + ":delivery-device:v1" :
      "defense:" + room + ":delivery-device:v1";
    var allowRallyPrefill = surface === "defense" && options.rallyPrefill === true;
    var randomUUID = typeof options.randomUUID === "function" ? options.randomUUID : function () {
      if (!root.crypto || typeof root.crypto.randomUUID !== "function") throw new Error("randomUUID unavailable");
      return root.crypto.randomUUID();
    };

    function readRecord(key) {
      try {
        var raw = storage.getItem(key);
        if (!raw) return null;
        return cloneRecord(JSON.parse(raw));
      } catch (_) { return null; }
    }

    function readConfirmed() {
      return readRecord(confirmedKey);
    }

    function saveConfirmed(profile) {
      try {
        if (!profile) { storage.removeItem(confirmedKey); return null; }
        var copy = cloneRecord(profile);
        if (!copy) throw new TypeError("profile must be an object");
        storage.setItem(confirmedKey, JSON.stringify(copy));
        return copy;
      } catch (_) { return null; }
    }

    function readRallyPrefill() {
      if (!allowRallyPrefill) return null;
      var source = readRecord(rallyConfirmedKey);
      if (!source) return null;
      var draft = Object.assign({}, source, {
        identityMode: source.identityMode === "nickname" ? "nickname" : "playerId"
      });
      if (draft.identityMode === "playerId" && !draft.playerId && PLAYER_ID.test(String(source.pid || ""))) {
        draft.playerId = String(source.pid);
      }
      var normalized = normalizeDraft(draft);
      if (!normalized.ok) return null;
      var prefill = {
        sourceSurface: "rally",
        pid: String(source.pid || ""),
        identityMode: normalized.profile.identityMode,
        name: normalized.profile.name,
        march: normalized.profile.march
      };
      if (normalized.profile.identityMode === "playerId") prefill.playerId = normalized.profile.playerId;
      return prefill;
    }

    function deviceId() {
      var value = "";
      try { value = storage.getItem(deviceKey) || ""; } catch (_) {}
      if (!UUID.test(value)) value = randomUUID();
      if (!UUID.test(value)) throw new Error("randomUUID returned an invalid UUID");
      value = value.toLowerCase();
      try { storage.setItem(deviceKey, value); } catch (_) {}
      return value;
    }

    return Object.freeze({
      readConfirmed: readConfirmed,
      readRallyPrefill: readRallyPrefill,
      saveConfirmed: saveConfirmed,
      deviceId: deviceId,
      keys: function () {
        return { confirmed: confirmedKey, device: deviceKey, rallyConfirmed: rallyConfirmedKey };
      }
    });
  }

  return Object.freeze({
    cleanNickname: cleanNickname,
    escapeHtml: escapeHtml,
    normalizeDraft: normalizeDraft,
    createIdentityStore: createIdentityStore
  });
}));
