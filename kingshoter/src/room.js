/* Room Durable Object — one per "<kingdom>:<room>".
   Holds the room's live state (config + players + current command) in DO storage,
   fans out the full state snapshot to every connected WebSocket on any change.
   Edits/commands require the room password (sha256) or the MASTER override. */

import {
  activeCommandPids,
  applyOwnProfileUpdate,
  applyPlayerMarchUpdate,
  freezeDoubleRally,
  normalizeMarchRevision,
  normalizeMutationId,
  normalizePlayerRecords,
  normalizePlayerRecordsWithMigration,
  normalizeRoutingKey,
  profilePlayerId,
  projectDefensePlayerPurges,
  registerPlayer,
  removePlayerAtomic
} from "./room-player.js";
import {
  bindCoreSocketIdentity,
  coreAttachmentMatchesAck,
  deliveryAckError,
  normalizeCoreSocketAttachment,
  normalizeDeviceId,
  projectLiveCoreDevices,
  pruneDevices,
  recordCommandAck,
  registryMatchesAck,
  removePlayerDelivery,
  startCommandDelivery,
  touchDevice
} from "./room-delivery.js";
import {
  cancelDeliveryRecord,
  createDeliveryRecord,
  DELIVERY_ACK_WINDOW_MS,
  DELIVERY_ARMED_LEASE_MS,
  DELIVERY_PROBE_INTERVAL_MS,
  DELIVERY_RETRY_DELAYS_MS,
  DELIVERY_STORAGE_KEY,
  DELIVERY_VERSION,
  defaultDeliveryState,
  dueDeliveryTargets,
  isQaRoomName,
  normalizeDeliveryAttachment,
  normalizeDeliveryState,
  nextDeliveryWakeAt,
  pruneDeliveryState,
  publicDeliverySummary,
  recordClassicAck,
  recordDeliveryAttempt,
  recordShadowAck,
  upsertDeliveryTarget
} from "./delivery.js";
import {
  disableTripleModes,
  isTripleAllowed,
  newRallyModes,
  normalizeRallyModes,
  transitionRallyMode,
  validateStagedPairs
} from "./rally-mode.js";
import { buildTripleRallyCommand } from "./rally-targets.js";
import { MIN_TRIPLE_BUILD, parseClientBuild, projectRoomForClient } from "./client-build.js";
import {
  DEFENSE_SURFACE,
  RALLY_SURFACE,
  inspectSocketSurface,
  mergeSocketSurface,
  parseRequestedSurface
} from "./room-surface.js";
import {
  cancelDefenseOrder,
  completeDefenseOrder,
  createDefenseOrder,
  defaultDefenseState,
  nextDefenseWakeAt,
  normalizeDefenseState,
  removeDefensePlayer,
  setDefensePlayerMarch,
  updateDefenseConfig
} from "./defense-domain.js";
import {
  aggregateDefenseDelivery,
  normalizeDefenseDevice,
  recordDefenseAck
} from "./defense-delivery.js";

function deserializeSocketAttachment(ws) {
  try { return ws.deserializeAttachment(); }
  catch (error) { return { surface: null }; }
}

function sendSurfaceError(ws, error) {
  try { ws.send(JSON.stringify({ t: "error", error })); } catch (sendError) {}
}

function socketSurfaceError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function attachmentNeedsAcceptedSocket(error) {
  return /requires an accepted WebSocket/i.test(String(error && error.message || ""));
}

function closeFailedSocket(ws) {
  try { ws.close(1011, "attachment_failed"); } catch (error) {}
}

function defaultRoom() {
  return {
    pwHash: null,
    config: { castleName: "", rallyAllies: [], enemyWhales: [] },
    players: {},
    rallyModes: newRallyModes(),
    // per-kingdom command + staged slots so two commanders (one per kingdom) never clobber each other
    live: { mode: "idle", commands: { 1: null, 2: null }, staged: { 1: null, 2: null }, sim: null },
    updatedAt: null,
    updatedBy: null
  };
}

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

const PROFILE_OWNERS_STORAGE_KEY = "profileOwners";
const DEFENSE_STORAGE_KEY = "defense:v1";
const DEFENSE_PROFILE_OWNERS_STORAGE_KEY = "defenseProfileOwners:v1";
const DEFENSE_DEVICES_STORAGE_KEY = "defenseDevices:v1";
const DEFENSE_ACKS_STORAGE_KEY = "defenseAcks:v1";
const DEFENSE_REMOVED_OWNERS_STORAGE_KEY = "defenseRemovedOwners:v1";
const DEFENSE_STORAGE_KEYS = [
  DEFENSE_STORAGE_KEY,
  DEFENSE_PROFILE_OWNERS_STORAGE_KEY,
  DEFENSE_DEVICES_STORAGE_KEY,
  DEFENSE_ACKS_STORAGE_KEY,
  DEFENSE_REMOVED_OWNERS_STORAGE_KEY
];
const DEFENSE_MANAGER_LEASE_MS = 70_000;
const DEFENSE_PERSIST_RETRY_DELAYS_MS = [500, 1_500, 5_000, 15_000, 30_000];
const DEFENSE_MANAGER_PAGE_SIZE = 50;
const MAX_DEFENSE_REMOVED_OWNERS = 300;
const MAX_OPERATIONAL_FRAME_BYTES = 64 * 1024;
const MAX_PASSWORD_LENGTH = 256;
const DEFENSE_MESSAGE_TYPES = new Set([
  "hello", "registerPlayer", "updateOwnProfile", "updateOwnMarch",
  "defenseDeviceStatus", "defenseUnlock", "defenseManagerStatus",
  "getDefenseManagerPlayersPage",
  "setDefenseConfig", "setDefensePlayerMarch", "fireDefense", "cancelDefense", "removeDefensePlayer",
  "defenseOrderAck", "hb"
]);
const DEFENSE_ONLY_MESSAGE_TYPES = new Set([
  "defenseDeviceStatus", "defenseUnlock", "defenseManagerStatus",
  "getDefenseManagerPlayersPage",
  "setDefenseConfig", "setDefensePlayerMarch", "fireDefense", "cancelDefense", "removeDefensePlayer",
  "defenseOrderAck"
]);
const RALLY_CANONICAL_MESSAGE_TYPES = new Set([
  "setRallyMode", "deviceStatus", "deliveryAck", "setMarch", "registerPlayer",
  "updateOwnProfile", "updateOwnMarch", "setPlayerMarch", "removePlayer",
  "setConfig", "cmd", "stage", "ready", "sim", "hb"
]);

function normalizeProfileOwners(value) {
  const source = value && typeof value === "object" ? value : {};
  const owners = Object.create(null);
  for (const rawPid of Object.keys(source)) {
    const pid = normalizeRoutingKey(rawPid);
    const hash = String(source[rawPid] || "").trim().toLowerCase();
    if (pid && /^[0-9a-f]{64}$/.test(hash)) owners[pid] = hash;
  }
  return owners;
}

function normalizeRemovedOwners(value) {
  const entries = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const pid = normalizeRoutingKey(raw && raw.pid);
    const ownerHash = String(raw && raw.ownerHash || "").trim().toLowerCase();
    if (!pid || !/^[0-9a-f]{64}$/.test(ownerHash)) continue;
    const previous = entries.findIndex(entry =>
      entry.pid === pid && entry.ownerHash === ownerHash
    );
    if (previous >= 0) entries.splice(previous, 1);
    entries.push({ pid, ownerHash });
  }
  return entries.slice(-MAX_DEFENSE_REMOVED_OWNERS);
}

function validNewPassword(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PASSWORD_LENGTH;
}

function validPresentedPassword(value) {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_OPERATIONAL_FRAME_BYTES;
}

function normalizeDefenseDevices(value) {
  const byIdentity = new Map();
  for (const raw of Array.isArray(value) ? value : []) {
    const device = normalizeDefenseDevice(raw);
    if (!device) continue;
    const key = `${device.pid}\u0000${device.deviceId}`;
    const current = byIdentity.get(key);
    if (!current || device.lastSeenMs >= current.lastSeenMs) byIdentity.set(key, device);
  }
  return Array.from(byIdentity.values()).slice(-1200);
}

function defenseProfileProjection(state, pidValue) {
  const pid = normalizeRoutingKey(pidValue);
  const player = state && state.players && state.players[pid];
  if (!pid || !player) return null;
  const identityMode = player.identityMode === "nickname" ? "nickname" : "playerId";
  const profile = {
    pid,
    identityMode,
    name: typeof player.name === "string" && player.name ? player.name : pid,
    march: player.march,
    revision: normalizeMarchRevision(player.marchRevision),
    profileGeneration: player.profileGeneration,
    pendingRemoval: Array.isArray(state.pendingRemovalPids) && state.pendingRemovalPids.includes(pid)
  };
  const playerId = identityMode === "playerId" ? profilePlayerId(pid, player) : "";
  if (playerId) profile.playerId = playerId;
  return profile;
}

function personalDefenseOrder(order, pidValue) {
  const pid = normalizeRoutingKey(pidValue);
  const target = order && Array.isArray(order.audience)
    ? order.audience.find(profile => profile && profile.pid === pid) : null;
  if (!target) return null;
  return {
    id: order.id,
    revision: order.revision,
    signalAtMs: order.signalAtMs,
    acceptedAtMs: order.acceptedAtMs,
    tapAnchorSeconds: order.tapAnchorSeconds,
    enemyMarchSeconds: order.enemyMarchSeconds,
    enemyLaunchAtMs: order.enemyLaunchAtMs,
    enemyImpactAtMs: order.enemyImpactAtMs,
    completeAtMs: order.completeAtMs,
    pid: target.pid,
    displayName: target.displayName,
    march: target.march,
    marchRevision: target.marchRevision,
    goAtMs: target.goAtMs,
    tooLate: target.tooLate === true
  };
}

function defenseOrderCounts(order) {
  const roster = order && Array.isArray(order.rosterAtAcceptance) ? order.rosterAtAcceptance : [];
  const audience = order && Array.isArray(order.audience) ? order.audience : [];
  return {
    registeredAtAcceptance: roster.length,
    targetedProfiles: audience.length,
    offlineRosterProfiles: roster.filter(profile => profile && profile.connectedAtAcceptance !== true).length,
    invalidTimeProfiles: roster.filter(profile => profile && profile.validAtAcceptance !== true).length,
    tooLateProfiles: audience.filter(profile => profile && profile.tooLate === true).length
  };
}

function defenseDeliverySummary(delivery) {
  if (!delivery) return null;
  return {
    targetedProfiles: delivery.targetedProfiles,
    deliveredScheduledProfiles: delivery.deliveredScheduledProfiles,
    audioReadyProfiles: delivery.audioReadyProfiles,
    redUnconfirmedProfiles: delivery.redUnconfirmedProfiles,
    offlineRosterProfiles: delivery.offlineRosterProfiles,
    invalidTimeProfiles: delivery.invalidTimeProfiles,
    tooLateProfiles: delivery.tooLateProfiles
  };
}

function defenseProfileDeliveryProjection(order, ackRecords, pidValue) {
  const pid = normalizeRoutingKey(pidValue);
  const profile = aggregateDefenseDelivery(order, ackRecords).profiles
    .find(candidate => candidate.pid === pid);
  return profile ? {
    pid: profile.pid,
    goAtMs: profile.goAtMs,
    tooLate: profile.tooLate,
    acknowledgedDevices: profile.acknowledgedDevices,
    scheduledDevices: profile.scheduledDevices,
    deliveredScheduled: profile.deliveredScheduled,
    audioReady: profile.audioReady,
    outcome: profile.outcome
  } : null;
}

function managerDefenseProfileRows(order, ackRecords) {
  if (!order) return [];
  const delivery = aggregateDefenseDelivery(order, ackRecords);
  const deliveryByPid = new Map(delivery.profiles.map(profile => [profile.pid, profile]));
  const audienceByPid = new Map((Array.isArray(order.audience) ? order.audience : [])
    .filter(profile => profile && profile.pid)
    .map(profile => [profile.pid, profile]));
  return (Array.isArray(order.rosterAtAcceptance) ? order.rosterAtAcceptance : [])
    .filter(profile => profile && profile.pid)
    .map(profile => {
      const target = audienceByPid.get(profile.pid) || null;
      const aggregate = deliveryByPid.get(profile.pid) || null;
      const projected = {
        pid: profile.pid,
        displayName: profile.displayName,
        identityMode: profile.identityMode,
        march: profile.march == null ? null : profile.march,
        marchRevision: profile.marchRevision,
        connectedAtAcceptance: profile.connectedAtAcceptance === true,
        validAtAcceptance: profile.validAtAcceptance === true,
        targeted: target != null,
        goAtMs: target ? target.goAtMs : null,
        tooLate: target ? target.tooLate === true : false,
        outcome: aggregate ? aggregate.outcome : null,
        acknowledgedDevices: aggregate ? aggregate.acknowledgedDevices : 0,
        scheduledDevices: aggregate ? aggregate.scheduledDevices : 0,
        deliveredScheduled: aggregate ? aggregate.deliveredScheduled === true : false,
        audioReady: aggregate ? aggregate.audioReady === true : false
      };
      if (profile.playerId) projected.playerId = profile.playerId;
      return projected;
    });
}

function managerDefenseOrder(order, ackRecords) {
  if (!order) return null;
  const delivery = aggregateDefenseDelivery(order, ackRecords);
  return {
    id: order.id,
    revision: order.revision,
    signalAtMs: order.signalAtMs,
    acceptedAtMs: order.acceptedAtMs,
    tapAnchorSeconds: order.tapAnchorSeconds,
    enemyMarchSeconds: order.enemyMarchSeconds,
    enemyLaunchAtMs: order.enemyLaunchAtMs,
    enemyImpactAtMs: order.enemyImpactAtMs,
    completeAtMs: order.completeAtMs,
    counts: defenseOrderCounts(order),
    delivery: defenseDeliverySummary(delivery)
  };
}

const DEFENSE_ACK_OUTCOMES = new Set([
  "scheduled", "audio_unready", "clock_stale", "schedule_failed", "too_late"
]);

function defenseAckErrorContext(message) {
  const source = message && typeof message === "object" ? message : {};
  const context = {};
  const orderId = typeof source.orderId === "string" ? source.orderId.trim() : "";
  if (orderId && orderId.length <= 64) context.orderId = orderId;
  if (Number.isSafeInteger(source.orderRevision) && source.orderRevision >= 0) {
    context.orderRevision = source.orderRevision;
    context.revision = source.orderRevision;
  }
  const pid = normalizeRoutingKey(source.pid);
  if (pid) context.pid = pid;
  const deviceId = normalizeDeviceId(source.deviceId);
  if (deviceId) context.deviceId = deviceId;
  if (DEFENSE_ACK_OUTCOMES.has(source.outcome)) context.outcome = source.outcome;
  return context;
}

function defenseError(source, result, fallbackMutationId = "") {
  const message = {
    t: "error",
    source,
    mutationId: normalizeMutationId(result && result.mutationId) || normalizeMutationId(fallbackMutationId),
    error: String(result && result.error || "defense_error")
  };
  if (!message.mutationId) delete message.mutationId;
  const canonicalRevision = Number.isInteger(result && result.canonicalRevision)
    ? result.canonicalRevision
    : Number.isInteger(result && result.latest && result.latest.revision)
      ? result.latest.revision
      : Number.isInteger(result && result.profile && result.profile.revision)
        ? result.profile.revision
        : null;
  if (canonicalRevision != null) {
    message.canonicalRevision = canonicalRevision;
  }
  for (const key of [
    "canonicalProfileGeneration", "canonicalRosterRevision", "canonicalOrderRevision"
  ]) {
    if (Number.isSafeInteger(result && result[key]) && result[key] >= 0) {
      message[key] = result[key];
    }
  }
  return message;
}

function sendJSON(ws, value) {
  try { ws.send(JSON.stringify(value)); return true; }
  catch (error) { return false; }
}

async function profileOwnerMatches(readProfileOwners, pid, profileKey) {
  const key = normalizeDeviceId(profileKey);
  if (!key) return false;
  const presented = await sha256(key);
  const profileOwners = typeof readProfileOwners === "function"
    ? readProfileOwners() : readProfileOwners;
  const expected = profileOwners && profileOwners[pid];
  return typeof expected === "string" && expected.length === 64 && presented === expected;
}

function playerRegisteredMessage(registrationId, pid, player, created, editable) {
  const identityMode = player && player.identityMode === "nickname" ? "nickname" : "playerId";
  const message = {
    t: "playerRegistered",
    registrationId,
    pid,
    created: created === true,
    editable: editable === true,
    identityMode,
    name: player && player.name || pid,
    march: player && player.march,
    revision: normalizeMarchRevision(player && player.marchRevision)
  };
  const playerId = identityMode === "playerId" ? profilePlayerId(pid, player) : "";
  if (playerId) message.playerId = playerId;
  return message;
}

function registrationError(error, registrationId, pid = "") {
  const message = { t: "error", error, registrationId };
  if (pid) message.pid = pid;
  return message;
}

function deliveryAckReceiptKey(value) {
  return JSON.stringify([
    String(value && value.commandId || ""),
    normalizeRoutingKey(value && value.pid),
    normalizeDeviceId(value && value.deviceId),
    value && value.outcome === "expired" ? "expired" : value && value.outcome === "scheduled" ? "scheduled" : "",
    Number(value && value.targetUTC),
    Number(value && value.scheduledAtMs)
  ]);
}

function clampStr(s, n) { return (s == null ? "" : String(s)).slice(0, n); }
function clampInt(v, lo, hi) { v = parseInt(v, 10); if (isNaN(v)) v = lo; return Math.max(lo, Math.min(hi, v)); }

function sanitizeConfig(c) {
  c = c || {};
  const allies = (Array.isArray(c.rallyAllies) ? c.rallyAllies : []).slice(0, 4).map(a => ({
    name: clampStr(a && a.name, 24),
    caps: (Array.isArray(a && a.caps) ? a.caps : []).slice(0, 4).map(cap => ({
      nm: clampStr(cap && cap.nm, 24),
      m: clampInt(cap && cap.m, 0, 36000),
      role: (cap && cap.role) === "main" ? "main" : "weak"
    }))
  }));
  const whales = (Array.isArray(c.enemyWhales) ? c.enemyWhales : []).slice(0, 30).map(w => ({
    name: clampStr(w && w.name, 24),
    mm: clampInt(w && w.mm, 0, 600),
    ss: clampInt(w && w.ss, 0, 59)
  }));
  return { castleName: clampStr(c.castleName, 40), rallyAllies: allies, enemyWhales: whales };
}

function crossKingdomLiveCaptain(live, kingdom, pairs, nowSec) {
  const otherKingdom = kingdom === 1 ? 2 : 1;
  const otherCommand = live && live.commands && live.commands[otherKingdom];
  const activePids = activeCommandPids({ commands: { [otherKingdom]: otherCommand } }, nowSec);
  const conflict = (Array.isArray(pairs) ? pairs : []).find(pair =>
    activePids.has(normalizeRoutingKey(pair && pair.pid))
  );
  return conflict ? { pid: normalizeRoutingKey(conflict.pid), kingdom: otherKingdom } : null;
}

function cancelledRallyStage(room, kingdom, command, nowSec) {
  if (!command || !['double_rally', 'triple_rally'].includes(command.type)) return undefined;
  const modeRecord = room.rallyModes[kingdom];
  const commandRoles = new Set(command.type === 'triple_rally'
    ? ['weak', 'weak2', 'main'] : ['weak', 'main']);
  const allowedRoles = new Set((modeRecord.mode === 'triple'
    ? ['weak', 'weak2', 'main'] : ['weak', 'main']).filter(role => commandRoles.has(role)));
  const otherKingdom = kingdom === 1 ? 2 : 1;
  const otherPairs = room.live.staged[otherKingdom] &&
    Array.isArray(room.live.staged[otherKingdom].pairs) ? room.live.staged[otherKingdom].pairs : [];
  const otherStaged = new Set(otherPairs
    .map(pair => normalizeRoutingKey(pair && pair.pid)).filter(Boolean));
  const otherLive = activeCommandPids({
    commands: { [otherKingdom]: room.live.commands[otherKingdom] }
  }, nowSec);
  const seenPids = new Set();
  const seenRoles = new Set();
  const pairs = [];
  const commandPairs = command.payload && Array.isArray(command.payload.pairs)
    ? command.payload.pairs : [];

  for (const sourcePair of commandPairs) {
    const pid = normalizeRoutingKey(sourcePair && sourcePair.pid);
    const role = sourcePair && sourcePair.role;
    if (!pid || !allowedRoles.has(role) || seenPids.has(pid) || seenRoles.has(role)) continue;
    if (!Object.prototype.hasOwnProperty.call(room.players, pid)) continue;
    if (otherStaged.has(pid) || otherLive.has(pid)) continue;
    seenPids.add(pid);
    seenRoles.add(role);
    pairs.push({ pid, role });
  }

  const validated = validateStagedPairs({
    modeRecord, modeRevision: modeRecord.revision, pairs, players: room.players
  });
  return validated.ok && validated.pairs.length
    ? { kingdom, pairs: validated.pairs }
    : null;
}

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.room = defaultRoom();
    const durableRoomName = String(state && state.id && state.id.name || "");
    this.roomName = (durableRoomName.startsWith("r:") ? durableRoomName.slice(2) : durableRoomName).slice(0, 48);
    this.delivery = defaultDeliveryState(this.roomName);
    this.devices = [];
    this.deliveryAcks = [];
    this._deliveryLoaded = false;
    this._deliveryLoadPromise = null;
    this._rallyLoaded = false;
    this._rallyLoadPromise = null;
    let loadRallyAtConstruction = typeof state.getWebSockets !== "function";
    if (!loadRallyAtConstruction) {
      try {
        loadRallyAtConstruction = state.getWebSockets().some(ws => {
          const surface = inspectSocketSurface(deserializeSocketAttachment(ws));
          return surface.ok && surface.surface === RALLY_SURFACE;
        });
      } catch (error) {
        loadRallyAtConstruction = false;
      }
    }
    state.blockConcurrencyWhile(async () => {
      if (!loadRallyAtConstruction) return;
      await this.ensureRallyLoaded();
    });
  }

  async ensureRallyLoaded() {
    return this.runSharedPasswordExclusive(() => this.ensureRallyLoadedUnlocked());
  }

  async ensureRallyLoadedUnlocked() {
    if (this._rallyLoaded !== false) return;
    if (!this._rallyLoadPromise) this._rallyLoadPromise = (async () => {
      const storedRoom = (await this.state.storage.get("room")) || defaultRoom();
      const playerMigration = normalizePlayerRecordsWithMigration(storedRoom.players);
      if (playerMigration.changed) {
        await this.state.storage.put("room", Object.assign({}, storedRoom, { players: playerMigration.players }));
      }
      this.room = storedRoom;
      this.room.players = playerMigration.players;
      this.normalizeLive();
      delete this.room.delivery;
      delete this.room.deliveryShadow;
      this._rallyLoaded = true;
    })();
    try { await this._rallyLoadPromise; }
    finally { if (!this._rallyLoaded) this._rallyLoadPromise = null; }
  }

  // migrate older single-slot live state to the per-kingdom shape
  normalizeLive() {
    const l = this.room.live = this.room.live || {};
    if (!l.commands || typeof l.commands !== "object") l.commands = { 1: l.command || null, 2: null };
    if (!l.staged || typeof l.staged !== "object" || "pairs" in l.staged || !("1" in l.staged)) l.staged = { 1: null, 2: null };
    delete l.command;
    l.mode = l.mode || "idle";
    if (!("sim" in l)) l.sim = null;
    this.room.rallyModes = normalizeRallyModes(this.room.rallyModes);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const requestedSurface = parseRequestedSurface(url.searchParams);
    if (!requestedSurface.ok) {
      return new Response(JSON.stringify({ t: "error", error: requestedSurface.error }), {
        status: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" }
      });
    }
    const isWebSocket = request.headers.get("Upgrade") === "websocket";
    if (requestedSurface.surface === DEFENSE_SURFACE) {
      if (!isWebSocket) {
        return new Response(JSON.stringify({ t: "error", error: "websocket_required" }), {
          status: 426,
          headers: { "Content-Type": "application/json; charset=utf-8" }
        });
      }
      await this.ensureDefenseLoaded();
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.attachSocket(server, this.roomName, DEFENSE_SURFACE);
      this.sendDefenseState(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    await this.ensureRallyLoaded();
    await this.ensureDeliveryLoaded();
    await this.runSharedPasswordExclusive(() => this.applyTripleGate());
    if (isWebSocket) {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const clientBuild = parseClientBuild(url.searchParams.get("clientBuild"));
      this.attachSocket(server, this.roomName, RALLY_SURFACE);      // Hibernation API + merge-safe identity base
      this.initializeReliableAttachment(server);
      this.writeSocketAttachment(server, { clientBuild });
      server.send(this.stateMsg(clientBuild));
      return new Response(null, { status: 101, webSocket: client });
    }
    // plain GET → public read-only snapshot (handy for debugging / SSR)
    return Response.json(JSON.parse(this.stateMsg(MIN_TRIPLE_BUILD)));
  }

  snapshot() {
    const sockets = this.liveCoreSockets();
    const players = Object.fromEntries(Object.entries(this.room.players || {}).map(([pid, player]) => [
      pid, { ...(player && typeof player === "object" ? player : {}) }
    ]));
    const liveSeen = new Date(this.nowMs()).toISOString();
    for (const device of this.liveCoreDevices()) {
      if (Object.prototype.hasOwnProperty.call(players, device.pid)) players[device.pid].lastSeen = liveSeen;
    }
    const r = { ...this.room, players, presence: sockets.length };
    delete r.delivery;
    delete r.deliveryShadow;
    r.hasPw = !!r.pwHash; delete r.pwHash;   // clients only need "is this room claimed?" — never ship the hash itself
    // auto-expire finished commands per kingdom so late joiners / reconnects never get a phantom GO
    const nowS = Math.floor(Date.now() / 1000);
    const cmds = Object.assign({}, r.live.commands);
    let changed = false;
    for (const k of [1, 2]) { const c = cmds[k]; if (c && c.expiresUTC && nowS >= c.expiresUTC) { cmds[k] = null; changed = true; } }
    if (changed) r.live = Object.assign({}, r.live, { commands: cmds, mode: r.live.sim ? r.live.mode : ((cmds[1] || cmds[2]) ? "live" : "idle") });
    if (isQaRoomName(this.roomName) && this.delivery) {
      const summary = publicDeliverySummary(this.delivery, this.nowMs());
      if (summary.commands.length) r.deliveryShadow = summary;
    }
    return r;
  }
  // wake the DO at the soonest command expiry so connected idle clients get a fresh "back to idle" broadcast (not just on the next mutation)
  nextProbeWakeAt(nowMs) {
    if (!isQaRoomName(this.roomName) || !this.state ||
        typeof this.state.getWebSockets !== "function") return null;
    let next = null;
    for (const ws of this.liveCoreSockets()) {
      const attachment = this.readReliableAttachment(ws);
      if (attachment.roomName !== this.roomName || !attachment.shadow) continue;
      const coreReady = !!attachment.pid && !!attachment.deviceId &&
        attachment.soundReady === true;
      const wakeups = [];
      if (attachment.lastProbeId && attachment.probeExpiresAtMs) {
        wakeups.push(attachment.probeExpiresAtMs + 1);
      } else if (coreReady && attachment.nextProbeAtMs) {
        wakeups.push(attachment.nextProbeAtMs);
      }
      if (attachment.audioArmed && attachment.armedUntilMs) {
        wakeups.push(attachment.armedUntilMs);
      }
      for (const atMs of wakeups) {
        if (!Number.isFinite(atMs) || atMs <= 0) continue;
        next = next == null ? atMs : Math.min(next, atMs);
      }
    }
    return next;
  }
  async scheduleExpiry(defenseState = null) {
    const previousSchedule = this._scheduleExpiryTail || Promise.resolve();
    let releaseSchedule;
    const scheduleGate = new Promise(resolve => { releaseSchedule = resolve; });
    const scheduleTail = previousSchedule.then(() => scheduleGate);
    this._scheduleExpiryTail = scheduleTail;
    await previousSchedule;
    try {
      const scheduledDefense = defenseState || this._pendingDefenseScheduleState ||
        (this._defenseLoaded === true ? this.defense : null);
      const defenseKnown = scheduledDefense != null;
      const rallyLoaded = this._rallyLoaded !== false;
      const nowMs = this.nowMs();
      const rallyFailureNotBeforeMs = Math.max(
        Number.isFinite(this._rallyLoadFailureNotBeforeMs)
          ? this._rallyLoadFailureNotBeforeMs : 0,
        Number.isFinite(this._rallyTransitionFailureNotBeforeMs)
          ? this._rallyTransitionFailureNotBeforeMs : 0
      );
      const deliveryFailureNotBeforeMs = Number.isFinite(this._deliveryFailureNotBeforeMs)
        ? this._deliveryFailureNotBeforeMs : 0;
      const reliableKnown = !isQaRoomName(this.roomName) || this._deliveryLoaded === true;
      const classic = rallyLoaded ? [1, 2]
        .map(k => this.room.live.commands[k])
        .filter(c => c && c.expiresUTC)
        .map(c => Number(c.expiresUTC) * 1000 + 600)
        .filter(atMs => Number.isFinite(atMs) && atMs > 0)
        .map(atMs => atMs <= nowMs && rallyFailureNotBeforeMs > nowMs
          ? rallyFailureNotBeforeMs : atMs) : [];
      const reliable = [];
      if (rallyLoaded && isQaRoomName(this.roomName) && reliableKnown) {
        const deliveryAt = this.delivery ? nextDeliveryWakeAt(this.delivery, nowMs) : null;
        const hasActiveDelivery = !!(this.delivery && Array.isArray(this.delivery.commands) && this.delivery.commands.length);
        const probeAt = hasActiveDelivery ? this.nextProbeWakeAt(nowMs) : null;
        if (Number.isFinite(deliveryAt) && deliveryAt > 0) {
          reliable.push(deliveryAt <= nowMs
            ? Math.max(nowMs + 1, deliveryFailureNotBeforeMs)
            : deliveryAt);
        }
        if (Number.isFinite(probeAt) && probeAt > 0) {
          reliable.push(probeAt <= nowMs
            ? Math.max(nowMs + 1, deliveryFailureNotBeforeMs)
            : probeAt);
        }
      }
      const defenseAt = defenseKnown ? nextDefenseWakeAt(scheduledDefense) : null;
      const defenseFailureNotBeforeMs = Number.isFinite(this._defenseFailureNotBeforeMs)
        ? this._defenseFailureNotBeforeMs : 0;
      const defenseWakeups = Number.isFinite(defenseAt) && defenseAt > 0
        ? [defenseAt <= nowMs
            ? Math.max(nowMs + 1, defenseFailureNotBeforeMs)
            : defenseAt]
        : [];
      const retryWakeups = [];
      if (Number.isFinite(this._rallyLoadFailureNotBeforeMs) &&
          this._rallyLoadFailureNotBeforeMs > 0) {
        retryWakeups.push(Math.max(nowMs + 1, this._rallyLoadFailureNotBeforeMs));
      }
      if (Number.isFinite(this._rallyTransitionFailureNotBeforeMs) &&
          this._rallyTransitionFailureNotBeforeMs > 0) {
        retryWakeups.push(Math.max(nowMs + 1, this._rallyTransitionFailureNotBeforeMs));
      }
      if (Number.isFinite(this._rallyScheduleFailureNotBeforeMs) &&
          this._rallyScheduleFailureNotBeforeMs > 0) {
        retryWakeups.push(Math.max(nowMs + 1, this._rallyScheduleFailureNotBeforeMs));
      }
      if (Number.isFinite(this._deliveryFailureNotBeforeMs) &&
          this._deliveryFailureNotBeforeMs > 0) {
        retryWakeups.push(Math.max(nowMs + 1, this._deliveryFailureNotBeforeMs));
      }
      if (!defenseKnown && Number.isFinite(this._defenseLoadFailureNotBeforeMs) &&
          this._defenseLoadFailureNotBeforeMs > 0) {
        retryWakeups.push(Math.max(nowMs + 1, this._defenseLoadFailureNotBeforeMs));
      }
      const candidates = classic.concat(reliable, defenseWakeups, retryWakeups);
      const storage = this.state && this.state.storage;
      if (!storage || typeof storage.getAlarm !== "function") {
        if (candidates.length && storage && typeof storage.setAlarm === "function") {
          await storage.setAlarm(Math.min(...candidates));
        } else if (!candidates.length && storage && typeof storage.deleteAlarm === "function") {
          await storage.deleteAlarm();
        }
        return;
      }
      let existingAlarm;
      try { existingAlarm = await storage.getAlarm(); }
      catch (error) {
        if (candidates.length) throw error;
        return;
      }
      const unknownSurface = !rallyLoaded || !reliableKnown || !defenseKnown;
      if (unknownSurface && Number.isFinite(existingAlarm) && existingAlarm > 0) {
        candidates.push(existingAlarm <= nowMs ? nowMs + 1 : existingAlarm);
      }
      if (candidates.length) {
        const target = Math.min(...candidates);
        if (!Number.isFinite(existingAlarm) || existingAlarm !== target) {
          await storage.setAlarm(target);
        }
      } else if (!unknownSurface && Number.isFinite(existingAlarm) && existingAlarm > 0) {
        await storage.deleteAlarm();
      }
    } finally {
      releaseSchedule();
      if (this._scheduleExpiryTail === scheduleTail) this._scheduleExpiryTail = null;
    }
  }
  async ensureReliableWakeForReadySocket(ws) {
    const attachment = this.readReliableAttachment(ws);
    if (!isQaRoomName(this.roomName) || attachment.roomName !== this.roomName ||
        attachment.qa !== true || attachment.shadow !== true ||
        attachment.soundReady !== true) return false;
    try {
      await this.scheduleExpiry();
      for (const socket of this.liveCoreSockets()) {
        const sibling = this.readReliableAttachment(socket);
        if (sibling.roomName !== this.roomName || sibling.qa !== true ||
            sibling.shadow !== true || sibling.reliableWakeRetryNeeded !== true) continue;
        try { this.writeSocketAttachment(socket, { reliableWakeRetryNeeded: false }); } catch (error) {}
      }
      return true;
    } catch (error) {
      try { this.writeSocketAttachment(ws, { reliableWakeRetryNeeded: true }); } catch (attachmentError) {}
      return false;
    }
  }
  async runDeliveryWake(nowMs) {
    if (!isQaRoomName(this.roomName)) return false;
    if (Number.isFinite(this._deliveryFailureNotBeforeMs) &&
        this._deliveryFailureNotBeforeMs > nowMs) return false;
    const sockets = this.state && typeof this.state.getWebSockets === "function"
      ? this.liveCoreSockets() : [];
    let attachmentChanged = false;

    for (const ws of sockets) {
      const attachment = this.readReliableAttachment(ws);
      if (attachment.roomName !== this.roomName || !attachment.shadow) continue;
      const challengeExpired = !!attachment.lastProbeId && !!attachment.probeExpiresAtMs &&
        nowMs > attachment.probeExpiresAtMs;
      const leaseExpired = attachment.audioArmed && attachment.armedUntilMs <= nowMs;
      if (challengeExpired) {
        this.writeReliableAttachment(ws, {
          audioArmed: false,
          armedUntilMs: 0,
          lastProbeId: "",
          probeExpiresAtMs: 0
        });
        attachmentChanged = true;
      } else if (leaseExpired) {
        this.writeReliableAttachment(ws, { audioArmed: false, armedUntilMs: 0 });
        attachmentChanged = true;
      }
    }

    for (const ws of sockets) {
      const attachment = this.readReliableAttachment(ws);
      if (attachment.roomName !== this.roomName || !attachment.shadow ||
          !attachment.pid || !attachment.deviceId || attachment.soundReady !== true ||
          attachment.lastProbeId || !attachment.nextProbeAtMs ||
          attachment.nextProbeAtMs > nowMs) continue;
      this.issueDeliveryProbe(ws, attachment, nowMs);
      attachmentChanged = true;
    }

    const previousDelivery = this.delivery;
    const nextDelivery = normalizeDeliveryState(previousDelivery, 0);
    nextDelivery.roomName = this.roomName;
    this.delivery = nextDelivery;
    const dueActions = dueDeliveryTargets(this.delivery, nowMs);
    let deliveryChanged = false;
    for (const action of dueActions) {
      deliveryChanged = recordDeliveryAttempt(this.delivery, action, nowMs) || deliveryChanged;
    }
    deliveryChanged = pruneDeliveryState(this.delivery, nowMs) || deliveryChanged;
    if (!deliveryChanged) {
      this.delivery = previousDelivery;
      return attachmentChanged;
    }
    try {
      await this.persistDelivery();
    } catch (error) {
      this.delivery = previousDelivery;
      const failure = new Error("delivery_wake_persist_failed");
      failure.cause = error;
      failure.deliveryWakePersistenceFailure = true;
      throw failure;
    }
    for (const action of dueActions) {
      const ws = this.deliverySocketFor(action, nowMs);
      if (!ws) continue;
      try { ws.send(JSON.stringify(action.envelope)); } catch (error) {}
    }
    return true;
  }
  async alarm() {
    const nowMs = this.nowMs();
    if (Number.isFinite(this._rallyScheduleFailureNotBeforeMs) &&
        this._rallyScheduleFailureNotBeforeMs <= nowMs) {
      this._rallyScheduleFailureNotBeforeMs = 0;
      this._rallyScheduleFailures = 0;
    }
    let rallyShouldBroadcast = false;
    try {
      await this.ensureRallyLoaded();
      this._rallyLoadFailures = 0;
      this._rallyLoadFailureNotBeforeMs = 0;
      await this.runSharedPasswordExclusive(async () => {
        this.normalizeLive();
        const nowS = Math.floor(nowMs / 1000);
        let changed = false;
        const rallyTransitionBlocked = Number.isFinite(this._rallyTransitionFailureNotBeforeMs) &&
          this._rallyTransitionFailureNotBeforeMs > nowMs;
        if (!rallyTransitionBlocked) {
          const commands = { ...this.room.live.commands };
          for (const k of [1, 2]) {
            const command = commands[k];
            if (command && command.expiresUTC && nowS >= command.expiresUTC) {
              commands[k] = null;
              changed = true;
            }
          }
          if (changed) {
            const candidate = {
              ...this.room,
              live: {
                ...this.room.live,
                commands,
                mode: this.room.live.sim ? "sim" :
                  ((commands[1] || commands[2]) ? "live" : "idle")
              }
            };
            try {
              await this.persist(candidate);
              this.room = candidate;
              this._rallyTransitionFailureNotBeforeMs = 0;
              this._rallyTransitionFailures = 0;
            } catch (error) {
              changed = false;
              this.deferRallyTransitionRetry(nowMs);
            }
          } else {
            this._rallyTransitionFailureNotBeforeMs = 0;
            this._rallyTransitionFailures = 0;
          }
        }
        rallyShouldBroadcast = changed;
        const deliveryRetryBlocked = Number.isFinite(this._deliveryFailureNotBeforeMs) &&
          this._deliveryFailureNotBeforeMs > nowMs;
        if (!deliveryRetryBlocked) {
          try {
            await this.ensureDeliveryLoaded();
            rallyShouldBroadcast = (await this.runDeliveryWake(nowMs)) || rallyShouldBroadcast;
            this._deliveryFailureNotBeforeMs = 0;
            this._deliveryFailures = 0;
          } catch (error) {
            rallyShouldBroadcast = true;
            this.deferDeliveryRetry(nowMs);
          }
        }
      });
    } catch (error) {
      const failures = Number.isSafeInteger(this._rallyLoadFailures) &&
        this._rallyLoadFailures >= 0 ? this._rallyLoadFailures + 1 : 1;
      this._rallyLoadFailures = failures;
      this._rallyLoadFailureNotBeforeMs = nowMs + DEFENSE_PERSIST_RETRY_DELAYS_MS[
        Math.min(failures - 1, DEFENSE_PERSIST_RETRY_DELAYS_MS.length - 1)
      ];
    }
    try {
      await this.ensureDefenseLoaded();
      this._defenseLoadFailures = 0;
      this._defenseLoadFailureNotBeforeMs = 0;
      await this.runDefenseExclusive(async () => {
      const activeDefenseOrder = this.defense.activeOrder;
      const defenseRetryBlocked = Number.isFinite(this._defenseFailureNotBeforeMs) &&
        this._defenseFailureNotBeforeMs > nowMs;
      if (activeDefenseOrder && nowMs >= activeDefenseOrder.completeAtMs && !defenseRetryBlocked) {
        const result = completeDefenseOrder(this.defense, {
          orderId: activeDefenseOrder.id,
          orderRevision: activeDefenseOrder.revision,
          completedAtMs: nowMs
        });
        if (!result.ok) {
          this.deferDefenseRetry(nowMs);
        } else if (!result.replayed) {
          const projected = this.projectDefensePurges(
            result.state,
            this.defenseProfileOwners,
            this.defenseDevices,
            this.defenseAcks,
            result.purgePids
          );
          projected.acks = [];
          try {
            await this.persistDefenseBundle(projected);
            this.defense = projected.defense;
            this.defenseProfileOwners = projected.profileOwners;
            this.defenseDevices = projected.devices;
            this.defenseAcks = projected.acks;
            this.defenseRemovedOwners = projected.removedOwners;
            this._defenseFailureNotBeforeMs = 0;
            this._defensePersistenceFailures = 0;
            this.sendDefenseTerminal("defenseOrderCompleted", result.orderId, result.revision);
            this.closePurgedDefenseSockets(projected.pids);
          } catch (error) {
            this.deferDefenseRetry(nowMs);
          }
        }
      }
      });
    } catch (error) {
      const failures = Number.isSafeInteger(this._defenseLoadFailures) &&
        this._defenseLoadFailures >= 0 ? this._defenseLoadFailures + 1 : 1;
      this._defenseLoadFailures = failures;
      this._defenseLoadFailureNotBeforeMs = nowMs + DEFENSE_PERSIST_RETRY_DELAYS_MS[
        Math.min(failures - 1, DEFENSE_PERSIST_RETRY_DELAYS_MS.length - 1)
      ];
    }
    if (rallyShouldBroadcast && this._rallyLoaded === true) this.broadcast();
    await this.scheduleExpiry();
  }
  stateMsg(clientBuild = MIN_TRIPLE_BUILD, canonicalSnapshot = null) {
    const snapshot = canonicalSnapshot || this.snapshot();
    const withCapabilities = {
      ...snapshot,
      capabilities: {
        ...(snapshot.capabilities || {}),
        tripleRally: isTripleAllowed(this.env, this.roomName) &&
          parseClientBuild(clientBuild) >= MIN_TRIPLE_BUILD
      }
    };
    return JSON.stringify({
      t: "state",
      room: projectRoomForClient(withCapabilities, clientBuild)
    });
  }
  broadcast() {
    const canonicalSnapshot = this.snapshot();
    for (const ws of this.liveCoreSockets()) {
      try {
        const attachment = this.readSocketAttachment(ws);
        ws.send(this.stateMsg(attachment.clientBuild, canonicalSnapshot));
      } catch (e) {}
    }
  }
  async applyTripleGate() {
    if (isTripleAllowed(this.env, this.roomName)) return false;
    const result = disableTripleModes({
      rallyModes: this.room.rallyModes,
      staged: this.room.live.staged
    });
    if (!result.changed) return false;
    const previousModes = this.room.rallyModes;
    const previousStaged = this.room.live.staged;
    this.room.rallyModes = result.rallyModes;
    this.room.live.staged = result.staged;
    try {
      await this.persist();
    } catch (error) {
      this.room.rallyModes = previousModes;
      this.room.live.staged = previousStaged;
      throw error;
    }
    this.broadcast();
    return true;
  }
  async persist(room = this.room) { await this.state.storage.put("room", room); }
  async persistAll() {
    this.profileOwners = normalizeProfileOwners(this.profileOwners);
    await this.state.storage.put({
      room: this.room,
      devices: this.devices,
      deliveryAcks: this.deliveryAcks,
      [PROFILE_OWNERS_STORAGE_KEY]: this.profileOwners
    });
  }
  async persistDevices() {
    await this.state.storage.put("devices", this.devices);
  }
  async ensureDeliveryLoaded() {
    this.profileOwners = normalizeProfileOwners(this.profileOwners);
    if (this._deliveryLoaded) return;
    if (!this.state || !this.state.storage) { this._deliveryLoaded = true; return; }
    if (!this._deliveryLoadPromise) {
      this._deliveryLoadPromise = (async () => {
        const stored = await this.state.storage.get([
          DELIVERY_STORAGE_KEY, "devices", "deliveryAcks", PROFILE_OWNERS_STORAGE_KEY
        ]);
        const get = key => stored && typeof stored.get === "function" ? stored.get(key) : null;
        const delivery = normalizeDeliveryState(get(DELIVERY_STORAGE_KEY) || this.delivery, this.nowMs());
        const devices = Array.isArray(get("devices")) ? get("devices") : [];
        const deliveryAcks = Array.isArray(get("deliveryAcks")) ? get("deliveryAcks") : [];
        const profileOwners = normalizeProfileOwners(
          stored && typeof stored.get === "function" ? stored.get(PROFILE_OWNERS_STORAGE_KEY) : null
        );
        this.delivery = delivery;
        this.devices = devices;
        this.deliveryAcks = deliveryAcks;
        this.profileOwners = profileOwners;
        this._deliveryLoaded = true;
      })();
    }
    try { await this._deliveryLoadPromise; } finally { if (!this._deliveryLoaded) this._deliveryLoadPromise = null; }
  }
  async ensureDefenseLoaded() {
    if (this._defenseLoaded === true) return;
    if (!this.state || !this.state.storage || typeof this.state.storage.get !== "function") {
      this.defense = normalizeDefenseState(this.defense || defaultDefenseState());
      this.defenseProfileOwners = normalizeProfileOwners(this.defenseProfileOwners);
      this.defenseDevices = normalizeDefenseDevices(this.defenseDevices);
      this.defenseAcks = Array.isArray(this.defenseAcks) ? this.defenseAcks.slice(-1200) : [];
      this.defenseRemovedOwners = normalizeRemovedOwners(this.defenseRemovedOwners);
      this._defenseLoaded = true;
      return;
    }
    if (!this._defenseLoadPromise) {
      this._defenseLoadPromise = (async () => {
        const stored = await this.state.storage.get(DEFENSE_STORAGE_KEYS);
        const get = key => stored && typeof stored.get === "function" ? stored.get(key) : null;
        this.defense = normalizeDefenseState(get(DEFENSE_STORAGE_KEY) || defaultDefenseState());
        this.defenseProfileOwners = normalizeProfileOwners(get(DEFENSE_PROFILE_OWNERS_STORAGE_KEY));
        this.defenseDevices = normalizeDefenseDevices(get(DEFENSE_DEVICES_STORAGE_KEY));
        this.defenseAcks = Array.isArray(get(DEFENSE_ACKS_STORAGE_KEY))
          ? get(DEFENSE_ACKS_STORAGE_KEY).slice(-1200) : [];
        this.defenseRemovedOwners = normalizeRemovedOwners(get(DEFENSE_REMOVED_OWNERS_STORAGE_KEY));
        this._defenseLoaded = true;
      })();
    }
    try { await this._defenseLoadPromise; }
    finally { if (!this._defenseLoaded) this._defenseLoadPromise = null; }
  }
  async persistDefenseBundle(values = {}) {
    const defense = values.defense || this.defense;
    const profileOwners = normalizeProfileOwners(
      Object.prototype.hasOwnProperty.call(values, "profileOwners")
        ? values.profileOwners : this.defenseProfileOwners
    );
    const devices = normalizeDefenseDevices(
      Object.prototype.hasOwnProperty.call(values, "devices")
        ? values.devices : this.defenseDevices
    );
    const acks = Array.isArray(values.acks) ? values.acks.slice(-1200)
      : Array.isArray(this.defenseAcks) ? this.defenseAcks.slice(-1200) : [];
    const removedOwners = normalizeRemovedOwners(
      Object.prototype.hasOwnProperty.call(values, "removedOwners")
        ? values.removedOwners : this.defenseRemovedOwners
    );
    await this.state.storage.put({
      [DEFENSE_STORAGE_KEY]: defense,
      [DEFENSE_PROFILE_OWNERS_STORAGE_KEY]: profileOwners,
      [DEFENSE_DEVICES_STORAGE_KEY]: devices,
      [DEFENSE_ACKS_STORAGE_KEY]: acks,
      [DEFENSE_REMOVED_OWNERS_STORAGE_KEY]: removedOwners
    });
  }
  async persistDefenseState(defense = this.defense) {
    await this.state.storage.put(DEFENSE_STORAGE_KEY, defense);
  }
  async persistDefenseDevices(devices = this.defenseDevices) {
    await this.state.storage.put(DEFENSE_DEVICES_STORAGE_KEY, normalizeDefenseDevices(devices));
  }
  async persistDefenseAcks(acks = this.defenseAcks) {
    await this.state.storage.put(DEFENSE_ACKS_STORAGE_KEY, Array.isArray(acks) ? acks.slice(-1200) : []);
  }
  async ensureSharedPasswordLoaded() {
    return this.runSharedPasswordExclusive(() => this.ensureSharedPasswordLoadedUnlocked());
  }

  async ensureSharedPasswordLoadedUnlocked() {
    if (this._sharedPasswordLoaded === true) return;
    if (this._rallyLoaded === true) {
      this._sharedPasswordLoaded = true;
      this._sharedRoomRecord = null;
      return;
    }
    const stored = await this.state.storage.get("room");
    const record = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : null;
    this._sharedRoomRecord = record;
    const hash = record && typeof record.pwHash === "string" ? record.pwHash.toLowerCase() : "";
    this.room.pwHash = /^[0-9a-f]{64}$/.test(hash) ? hash : null;
    this._sharedPasswordLoaded = true;
  }
  async persistSharedPassword(hash) {
    if (this._rallyLoaded === true) {
      const previous = this.room.pwHash;
      this.room.pwHash = hash;
      try { await this.persist(); }
      catch (error) { this.room.pwHash = previous; throw error; }
      return;
    }
    const base = this._sharedRoomRecord || defaultRoom();
    const next = { ...base, pwHash: hash };
    await this.state.storage.put("room", next);
    this._sharedRoomRecord = next;
    this.room.pwHash = hash;
  }
  async runDefenseExclusive(task) {
    const previous = this._defenseWriteLock || Promise.resolve();
    let release;
    this._defenseWriteLock = new Promise(resolve => { release = resolve; });
    await previous.catch(() => {});
    try { return await task(); }
    finally { release(); }
  }
  async runSharedPasswordExclusive(task) {
    const previous = this._sharedPasswordWriteLock || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    this._sharedPasswordWriteLock = current;
    await previous.catch(() => {});
    try { return await task(); }
    finally {
      release();
      if (this._sharedPasswordWriteLock === current) this._sharedPasswordWriteLock = null;
    }
  }
  deferDefenseRetry(nowMs) {
    const failures = Number.isSafeInteger(this._defensePersistenceFailures) &&
      this._defensePersistenceFailures >= 0 ? this._defensePersistenceFailures + 1 : 1;
    this._defensePersistenceFailures = failures;
    const delay = DEFENSE_PERSIST_RETRY_DELAYS_MS[
      Math.min(failures - 1, DEFENSE_PERSIST_RETRY_DELAYS_MS.length - 1)
    ];
    this._defenseFailureNotBeforeMs = nowMs + delay;
  }
  deferDeliveryRetry(nowMs) {
    const failures = Number.isSafeInteger(this._deliveryFailures) &&
      this._deliveryFailures >= 0 ? this._deliveryFailures + 1 : 1;
    this._deliveryFailures = failures;
    const delay = DEFENSE_PERSIST_RETRY_DELAYS_MS[
      Math.min(failures - 1, DEFENSE_PERSIST_RETRY_DELAYS_MS.length - 1)
    ];
    this._deliveryFailureNotBeforeMs = nowMs + delay;
  }
  deferRallyScheduleRetry(nowMs) {
    const failures = Number.isSafeInteger(this._rallyScheduleFailures) &&
      this._rallyScheduleFailures >= 0 ? this._rallyScheduleFailures + 1 : 1;
    this._rallyScheduleFailures = failures;
    const delay = DEFENSE_PERSIST_RETRY_DELAYS_MS[
      Math.min(failures - 1, DEFENSE_PERSIST_RETRY_DELAYS_MS.length - 1)
    ];
    this._rallyScheduleFailureNotBeforeMs = nowMs + delay;
  }
  deferRallyTransitionRetry(nowMs) {
    const failures = Number.isSafeInteger(this._rallyTransitionFailures) &&
      this._rallyTransitionFailures >= 0 ? this._rallyTransitionFailures + 1 : 1;
    this._rallyTransitionFailures = failures;
    const delay = DEFENSE_PERSIST_RETRY_DELAYS_MS[
      Math.min(failures - 1, DEFENSE_PERSIST_RETRY_DELAYS_MS.length - 1)
    ];
    this._rallyTransitionFailureNotBeforeMs = nowMs + delay;
  }
  async tryScheduleCommittedRally(nowMs) {
    try {
      await this.scheduleExpiry();
      return true;
    } catch (error) {
      this.deferRallyScheduleRetry(nowMs);
      return false;
    }
  }
  liveDefenseSockets(excludeSocket = null) {
    return this.state.getWebSockets().filter(socket =>
      socket !== excludeSocket &&
      (typeof socket.readyState !== "number" || socket.readyState === 1) &&
      (() => {
        const surface = inspectSocketSurface(deserializeSocketAttachment(socket));
        return surface.ok && surface.surface === DEFENSE_SURFACE;
      })()
    );
  }
  readDefenseAttachment(ws) {
    const core = this.readSocketAttachment(ws);
    if (core.surface !== DEFENSE_SURFACE) throw socketSurfaceError("wrong_surface");
    return {
      ...core,
      defenseProfilePid: normalizeRoutingKey(core.defenseProfilePid),
      clockFresh: core.clockFresh === true,
      managerAuthorized: core.managerAuthorized === true,
      managerDeviceId: normalizeDeviceId(core.managerDeviceId),
      managerClockFresh: core.managerClockFresh === true,
      managerStatusAtMs: Number.isSafeInteger(core.managerStatusAtMs) && core.managerStatusAtMs >= 0
        ? core.managerStatusAtMs : 0,
      managerClockSampleAtMs: Number.isSafeInteger(core.managerClockSampleAtMs)
        ? core.managerClockSampleAtMs : 0,
      managerClockOffsetMs: Number.isSafeInteger(core.managerClockOffsetMs)
        ? core.managerClockOffsetMs : 0
    };
  }
  writeDefenseAttachment(ws, patch) {
    const current = this.readDefenseAttachment(ws);
    const nextPatch = { ...patch };
    if (Object.prototype.hasOwnProperty.call(nextPatch, "defenseProfilePid")) {
      const pid = normalizeRoutingKey(nextPatch.defenseProfilePid);
      if (current.defenseProfilePid && current.defenseProfilePid !== pid) {
        throw socketSurfaceError("defense_profile_immutable");
      }
      nextPatch.defenseProfilePid = pid;
    }
    return this.writeSocketAttachment(ws, nextPatch);
  }
  defenseManagerClockFresh(ws, nowMs = this.nowMs()) {
    const attachment = this.readDefenseAttachment(ws);
    return attachment.managerAuthorized && attachment.managerClockFresh &&
      Number.isSafeInteger(nowMs) && nowMs >= attachment.managerStatusAtMs &&
      nowMs - attachment.managerStatusAtMs < DEFENSE_MANAGER_LEASE_MS;
  }
  defensePresence(pidValue, excludeSocket = null) {
    const pid = normalizeRoutingKey(pidValue);
    const devices = new Map();
    for (const ws of this.liveDefenseSockets(excludeSocket)) {
      let attachment;
      try { attachment = this.readDefenseAttachment(ws); } catch (error) { continue; }
      if (!pid || attachment.defenseProfilePid !== pid || attachment.pid !== pid || !attachment.deviceId) continue;
      const current = devices.get(attachment.deviceId) || {
        soundReady: false, clockFresh: false, ready: false
      };
      current.soundReady = current.soundReady || attachment.soundReady === true;
      current.clockFresh = current.clockFresh || attachment.clockFresh === true;
      current.ready = current.ready ||
        (attachment.soundReady === true && attachment.clockFresh === true);
      devices.set(attachment.deviceId, current);
    }
    const values = Array.from(devices.values());
    return {
      pid,
      connectedDevices: values.length,
      audioReadyDevices: values.filter(device => device.soundReady).length,
      clockFreshDevices: values.filter(device => device.clockFresh).length,
      readyDevices: values.filter(device => device.ready).length
    };
  }
  defenseConnectedPids() {
    const result = new Set();
    for (const ws of this.liveDefenseSockets()) {
      let attachment;
      try { attachment = this.readDefenseAttachment(ws); } catch (error) { continue; }
      if (attachment.pid && attachment.pid === attachment.defenseProfilePid &&
          this.defense.players[attachment.pid]) result.add(attachment.pid);
    }
    return Array.from(result);
  }
  defensePlayerSnapshot(ws) {
    const attachment = this.readDefenseAttachment(ws);
    const ownProfile = defenseProfileProjection(this.defense, attachment.defenseProfilePid);
    const personalOrder = ownProfile
      ? personalDefenseOrder(this.defense.activeOrder, ownProfile.pid) : null;
    const restorableOrder = personalOrder && personalOrder.goAtMs > this.nowMs()
      ? personalOrder : null;
    return {
      t: "defenseState",
      config: { ...this.defense.config },
      ownProfile,
      activeOrderForOwnProfile: restorableOrder,
      readiness: ownProfile ? this.defensePresence(ownProfile.pid) : {
        pid: "", connectedDevices: 0, audioReadyDevices: 0, clockFreshDevices: 0,
        readyDevices: 0
      },
      orderRevision: this.defense.orderRevision
    };
  }
  defenseManagerPlayerRows() {
    const activeRoundByPid = new Map(managerDefenseProfileRows(
      this.defense.activeOrder,
      this.defenseAcks
    ).map(profile => [profile.pid, profile]));
    return Object.keys(this.defense.players).sort().map(pid => {
      const frozen = activeRoundByPid.get(pid) || null;
      let activeRound = null;
      if (frozen) {
        const { pid: frozenPid, ...frozenFacts } = frozen;
        if (frozenPid === pid) activeRound = frozenFacts;
      }
      return {
        ...defenseProfileProjection(this.defense, pid),
        ...this.defensePresence(pid),
        activeRound
      };
    });
  }
  defenseManagerPlayersPage(pageValue = 1) {
    const page = Number.isSafeInteger(pageValue) ? pageValue : 0;
    if (page < 1) return null;
    const items = this.defenseManagerPlayerRows();
    const totalPages = Math.max(1, Math.ceil(items.length / DEFENSE_MANAGER_PAGE_SIZE));
    if (page > totalPages) return null;
    const start = (page - 1) * DEFENSE_MANAGER_PAGE_SIZE;
    return {
      page,
      pageSize: DEFENSE_MANAGER_PAGE_SIZE,
      total: items.length,
      totalPages,
      rosterRevision: this.defense.rosterRevision,
      baseRosterRevision: this.defense.rosterRevision,
      baseOrderRevision: this.defense.orderRevision,
      items: items.slice(start, start + DEFENSE_MANAGER_PAGE_SIZE)
    };
  }
  defenseManagerSnapshot(ws) {
    const attachment = this.readDefenseAttachment(ws);
    const items = this.defenseManagerPlayerRows();
    const playersPage = {
      page: 1,
      pageSize: DEFENSE_MANAGER_PAGE_SIZE,
      total: items.length,
      totalPages: Math.max(1, Math.ceil(items.length / DEFENSE_MANAGER_PAGE_SIZE)),
      rosterRevision: this.defense.rosterRevision,
      baseRosterRevision: this.defense.rosterRevision,
      baseOrderRevision: this.defense.orderRevision,
      items: items.slice(0, DEFENSE_MANAGER_PAGE_SIZE)
    };
    const connectedProfiles = items.filter(profile => profile.connectedDevices > 0).length;
    const audioReadyProfiles = items.filter(profile => profile.audioReadyDevices > 0).length;
    const readyProfiles = items.filter(profile => profile.readyDevices > 0).length;
    const activeOrder = managerDefenseOrder(this.defense.activeOrder, this.defenseAcks);
    const issues = [];
    if (activeOrder) {
      if (activeOrder.counts.offlineRosterProfiles) issues.push({ code: "offline_roster", count: activeOrder.counts.offlineRosterProfiles });
      if (activeOrder.counts.invalidTimeProfiles) issues.push({ code: "invalid_time", count: activeOrder.counts.invalidTimeProfiles });
      if (activeOrder.counts.tooLateProfiles) issues.push({ code: "too_late", count: activeOrder.counts.tooLateProfiles });
      if (activeOrder.delivery.redUnconfirmedProfiles) issues.push({ code: "red_unconfirmed", count: activeOrder.delivery.redUnconfirmedProfiles });
    }
    const distribution = [];
    if (this.defense.activeOrder) {
      const grouped = new Map();
      for (const profile of this.defense.activeOrder.audience) {
        const key = `${profile.goAtMs}:${profile.tooLate === true}`;
        const value = grouped.get(key) || {
          goAtMs: profile.goAtMs, tooLate: profile.tooLate === true, profiles: 0
        };
        value.profiles += 1;
        grouped.set(key, value);
      }
      distribution.push(...Array.from(grouped.values()).sort((a, b) => a.goAtMs - b.goAtMs));
    }
    return {
      t: "defenseManagerState",
      config: { ...this.defense.config },
      counts: {
        registeredProfiles: items.length,
        connectedProfiles,
        audioReadyProfiles,
        readyProfiles,
        pendingRemovalProfiles: this.defense.pendingRemovalPids.length
      },
      issues,
      distribution,
      activeOrder,
      playersPage,
      managerClockFresh: this.defenseManagerClockFresh(ws),
      managerLeaseUntilMs: attachment.managerStatusAtMs
        ? attachment.managerStatusAtMs + DEFENSE_MANAGER_LEASE_MS : 0,
      rosterRevision: this.defense.rosterRevision,
      orderRevision: this.defense.orderRevision
    };
  }
  sendDefenseManagerPlayersPage(ws, page) {
    const attachment = this.readDefenseAttachment(ws);
    if (!attachment.managerAuthorized) return false;
    const playersPage = this.defenseManagerPlayersPage(page);
    if (!playersPage) return false;
    const activeOrder = this.defense.activeOrder;
    return sendJSON(ws, {
      t: "defenseManagerPlayersPage",
      playersPage,
      rosterRevision: this.defense.rosterRevision,
      orderRevision: this.defense.orderRevision,
      activeOrderId: activeOrder ? activeOrder.id : null,
      activeOrderRevision: activeOrder ? activeOrder.revision : null
    });
  }
  sendDefenseState(ws) {
    return sendJSON(ws, this.defensePlayerSnapshot(ws));
  }
  sendDefenseManagerState(ws) {
    const attachment = this.readDefenseAttachment(ws);
    if (!attachment.managerAuthorized) return false;
    return sendJSON(ws, this.defenseManagerSnapshot(ws));
  }
  sendDefenseManagerStatusSaved(ws) {
    const attachment = this.readDefenseAttachment(ws);
    if (!attachment.managerAuthorized) return false;
    return sendJSON(ws, {
      t: "defenseManagerStatusSaved",
      managerClockFresh: this.defenseManagerClockFresh(ws),
      managerLeaseUntilMs: attachment.managerStatusAtMs
        ? attachment.managerStatusAtMs + DEFENSE_MANAGER_LEASE_MS : 0,
      orderRevision: this.defense.orderRevision
    });
  }
  sendDefenseProfileDelta(pid, extras = {}) {
    const profile = defenseProfileProjection(this.defense, pid);
    for (const socket of this.liveDefenseSockets()) {
      let attachment;
      try { attachment = this.readDefenseAttachment(socket); } catch (error) { continue; }
      if (!attachment.managerAuthorized && attachment.defenseProfilePid !== pid) continue;
      sendJSON(socket, {
        t: "defenseProfileDelta",
        ...extras,
        rosterRevision: this.defense.rosterRevision,
        profile
      });
    }
  }
  sendDefensePresenceDelta(pid, excludeSocket = null) {
    const message = { t: "defensePresenceDelta", ...this.defensePresence(pid, excludeSocket) };
    for (const socket of this.liveDefenseSockets(excludeSocket)) {
      let attachment;
      try { attachment = this.readDefenseAttachment(socket); } catch (error) { continue; }
      if (!attachment.managerAuthorized && attachment.defenseProfilePid !== message.pid) continue;
      sendJSON(socket, message);
    }
  }
  sendDefenseSnapshots() {
    for (const socket of this.liveDefenseSockets()) {
      try {
        this.sendDefenseState(socket);
        this.sendDefenseManagerState(socket);
      } catch (error) {}
    }
  }
  sendDefenseOrderAccepted(order, onlySocket = null) {
    const sockets = onlySocket ? [onlySocket] : this.liveDefenseSockets();
    for (const socket of sockets) {
      let attachment;
      try { attachment = this.readDefenseAttachment(socket); } catch (error) { continue; }
      const personal = personalDefenseOrder(order, attachment.defenseProfilePid);
      const projection = personal || (attachment.managerAuthorized
        ? managerDefenseOrder(order, this.defenseAcks) : null);
      if (projection) sendJSON(socket, { t: "defenseOrderAccepted", order: projection });
      this.sendDefenseState(socket);
      if (attachment.managerAuthorized) this.sendDefenseManagerState(socket);
    }
  }
  sendDefenseTerminal(type, orderId, revision, onlySocket = null) {
    const sockets = onlySocket ? [onlySocket] : this.liveDefenseSockets();
    for (const socket of sockets) {
      try {
        sendJSON(socket, { t: type, orderId, revision });
        this.sendDefenseState(socket);
        this.sendDefenseManagerState(socket);
      } catch (error) {}
    }
  }
  sendDefenseAckSaved(savedAck, changed = true) {
    const profileDelivery = defenseProfileDeliveryProjection(
      this.defense.activeOrder,
      this.defenseAcks,
      savedAck.pid
    );
    const message = {
      t: "defenseAckSaved",
      orderId: savedAck.orderId,
      revision: savedAck.orderRevision,
      pid: savedAck.pid,
      deviceId: savedAck.deviceId,
      outcome: savedAck.outcome,
      profileDelivery
    };
    for (const socket of this.liveDefenseSockets()) {
      let attachment;
      try { attachment = this.readDefenseAttachment(socket); } catch (error) { continue; }
      if (!attachment.managerAuthorized && attachment.defenseProfilePid !== savedAck.pid) continue;
      sendJSON(socket, message);
    }
  }
  projectDefensePurges(defense, owners, devices, acks, purgePids) {
    const projected = projectDefensePlayerPurges(defense.players, owners, devices, purgePids);
    const removed = new Set(projected.pids);
    const removedOwners = normalizeRemovedOwners(this.defenseRemovedOwners);
    for (const pid of projected.pids) {
      const ownerHash = owners && owners[pid];
      if (!/^[0-9a-f]{64}$/.test(String(ownerHash || ""))) continue;
      const previous = removedOwners.findIndex(entry =>
        entry.pid === pid && entry.ownerHash === ownerHash
      );
      if (previous >= 0) removedOwners.splice(previous, 1);
      removedOwners.push({ pid, ownerHash });
    }
    return {
      defense: { ...defense, players: projected.players },
      profileOwners: projected.profileOwners,
      devices: projected.devices,
      acks: (Array.isArray(acks) ? acks : []).filter(ack => !removed.has(normalizeRoutingKey(ack && ack.pid))),
      removedOwners: normalizeRemovedOwners(removedOwners),
      pids: projected.pids
    };
  }
  closePurgedDefenseSockets(pids) {
    const removed = new Set((Array.isArray(pids) ? pids : []).map(normalizeRoutingKey));
    if (!removed.size) return;
    for (const socket of this.liveDefenseSockets()) {
      let attachment;
      try { attachment = this.readDefenseAttachment(socket); } catch (error) { continue; }
      if (!removed.has(attachment.defenseProfilePid)) continue;
      try { socket.close(1008, "defense_profile_removed"); } catch (error) {}
    }
  }
  async updateDefenseDevice(ws, message, persistStatus) {
    const pid = normalizeRoutingKey(message && message.pid);
    const deviceId = normalizeDeviceId(message && message.deviceId);
    const attachment = this.readDefenseAttachment(ws);
    if (!pid || !this.defense.players[pid]) {
      return { ok: false, error: "player_missing" };
    }
    if (attachment.defenseProfilePid !== pid) {
      return { ok: false, error: "profile_identity_mismatch" };
    }
    if (!deviceId || typeof message.soundReady !== "boolean" ||
        typeof message.clockFresh !== "boolean") {
      return { ok: false, error: "invalid_device_status" };
    }
    if ((attachment.pid && attachment.pid !== pid) ||
        (attachment.deviceId && attachment.deviceId !== deviceId)) {
      return { ok: false, error: "device_identity_mismatch" };
    }
    const before = this.defensePresence(pid);
    const previousAttachment = deserializeSocketAttachment(ws);
    const nowMs = this.nowMs();
    this.writeDefenseAttachment(ws, {
      pid,
      deviceId,
      soundReady: message.soundReady,
      clockFresh: message.clockFresh,
      lastSeenMs: nowMs
    });
    const live = normalizeDefenseDevice({
      pid,
      deviceId,
      soundReady: message.soundReady,
      clockFresh: message.clockFresh,
      lastSeenMs: nowMs
    });
    const previousDevices = this.defenseDevices;
    let changed = false;
    if (persistStatus) {
      const current = previousDevices.find(device =>
        device.pid === pid && device.deviceId === deviceId
      );
      changed = !current || current.soundReady !== live.soundReady ||
        current.clockFresh !== live.clockFresh;
      if (changed) {
        const candidate = normalizeDefenseDevices(previousDevices
          .filter(device => !(device.pid === pid && device.deviceId === deviceId))
          .concat(live));
        try { await this.persistDefenseDevices(candidate); }
        catch (error) {
          try {
            ws.serializeAttachment(previousAttachment);
          } catch (attachmentError) {
            closeFailedSocket(ws);
          }
          this.sendDefensePresenceDelta(pid);
          return { ok: false, error: "device_status_persist_failed" };
        }
        this.defenseDevices = candidate;
      }
    }
    const after = this.defensePresence(pid);
    const presenceChanged = JSON.stringify(before) !== JSON.stringify(after);
    if (presenceChanged) this.sendDefensePresenceDelta(pid);
    return {
      ok: true,
      changed,
      presenceChanged,
      presence: after,
      status: {
        pid,
        deviceId,
        soundReady: live.soundReady,
        clockFresh: live.clockFresh
      }
    };
  }
  async handleDefenseMessage(ws, message) {
    if (!message || typeof message !== "object" || Array.isArray(message) ||
        typeof message.t !== "string" || !DEFENSE_MESSAGE_TYPES.has(message.t)) {
      return sendJSON(ws, { t: "error", source: "defense", error: "wrong_surface" });
    }
    if (message.t === "hello") {
      this.sendDefenseState(ws);
      this.sendDefenseManagerState(ws);
      return;
    }
    if (message.t === "registerPlayer") {
      return this.runDefenseExclusive(async () => {
        const registrationId = normalizeMutationId(message.registrationId);
        const pid = normalizeRoutingKey(message.pid);
        const profileKey = normalizeDeviceId(message.profileKey);
        if (!pid) return sendJSON(ws, defenseError("registerPlayer", {
          error: "invalid_pid", mutationId: registrationId
        }));
        const existing = this.defense.players[pid];
        if (existing) {
          if (!profileKey || !(await profileOwnerMatches(
            () => this.defenseProfileOwners, pid, profileKey
          ))) {
            return sendJSON(ws, defenseError("registerPlayer", {
              error: "profile_owner_mismatch", mutationId: registrationId
            }));
          }
          try { this.writeDefenseAttachment(ws, { defenseProfilePid: pid }); }
          catch (error) {
            return sendJSON(ws, defenseError("registerPlayer", {
              error: error.code || "defense_profile_immutable", mutationId: registrationId
            }));
          }
          this.sendDefenseProfileDelta(pid, { registrationId });
          this.sendDefenseState(ws);
          return;
        }
        if (!profileKey) return sendJSON(ws, defenseError("registerPlayer", {
          error: "invalid_profile_key", mutationId: registrationId
        }));
        const profileKeyHash = await sha256(profileKey);
        if (normalizeRemovedOwners(this.defenseRemovedOwners).some(entry =>
          entry.pid === pid && entry.ownerHash === profileKeyHash
        )) {
          return sendJSON(ws, defenseError("registerPlayer", {
            error: "profile_removed", mutationId: registrationId
          }));
        }
        const registrationAttachment = this.readDefenseAttachment(ws);
        if (registrationAttachment.defenseProfilePid &&
            registrationAttachment.defenseProfilePid !== pid) {
          return sendJSON(ws, defenseError("registerPlayer", {
            error: "defense_profile_immutable", mutationId: registrationId
          }));
        }
        const next = normalizeDefenseState(this.defense);
        const result = registerPlayer(next.players, message, this.now());
        if (!result.ok) return sendJSON(ws, defenseError("registerPlayer", {
          ...result, mutationId: registrationId
        }));
        if (Object.keys(next.players).length > 150) {
          return sendJSON(ws, defenseError("registerPlayer", {
            error: "roster_full", mutationId: registrationId
          }));
        }
        if (next.profileGenerationCounter >= Number.MAX_SAFE_INTEGER) {
          return sendJSON(ws, defenseError("registerPlayer", {
            error: "profile_generation_exhausted", mutationId: registrationId
          }));
        }
        if (next.rosterRevision >= Number.MAX_SAFE_INTEGER) {
          return sendJSON(ws, defenseError("registerPlayer", {
            error: "roster_revision_exhausted", mutationId: registrationId
          }));
        }
        next.profileGenerationCounter += 1;
        next.players[result.pid] = {
          ...next.players[result.pid],
          profileGeneration: next.profileGenerationCounter
        };
        next.rosterRevision += 1;
        const owners = normalizeProfileOwners(this.defenseProfileOwners);
        owners[result.pid] = profileKeyHash;
        const removedOwners = normalizeRemovedOwners(this.defenseRemovedOwners);
        const previousAttachment = deserializeSocketAttachment(ws);
        try { this.writeDefenseAttachment(ws, { defenseProfilePid: result.pid }); }
        catch (error) {
          return sendJSON(ws, defenseError("registerPlayer", {
            error: error.code || "attachment_failed", mutationId: registrationId
          }));
        }
        try {
          await this.persistDefenseBundle({
            defense: next, profileOwners: owners, removedOwners
          });
        } catch (error) {
          try { ws.serializeAttachment(previousAttachment); }
          catch (attachmentError) { closeFailedSocket(ws); }
          return sendJSON(ws, defenseError("registerPlayer", {
            error: "registration_persist_failed", mutationId: registrationId
          }));
        }
        this.defense = next;
        this.defenseProfileOwners = owners;
        this.defenseRemovedOwners = removedOwners;
        this.sendDefenseProfileDelta(result.pid, { registrationId });
        this.sendDefenseState(ws);
      });
    }
    if (message.t === "updateOwnProfile" || message.t === "updateOwnMarch") {
      return this.runDefenseExclusive(async () => {
        const mutationId = normalizeMutationId(message.mutationId);
        const pid = normalizeRoutingKey(message.pid);
        const attachment = this.readDefenseAttachment(ws);
        if (!pid || attachment.defenseProfilePid !== pid) {
          return sendJSON(ws, defenseError(message.t, {
            error: "profile_identity_mismatch", mutationId
          }));
        }
        if (!(await profileOwnerMatches(
          () => this.defenseProfileOwners, pid, message.profileKey
        ))) {
          return sendJSON(ws, defenseError(message.t, {
            error: "profile_owner_mismatch", mutationId
          }));
        }
        const next = normalizeDefenseState(this.defense);
        const result = message.t === "updateOwnProfile"
          ? applyOwnProfileUpdate(next.players, message, { touchLastSeen: true, nowISO: this.now() })
          : applyPlayerMarchUpdate(next.players, message, { touchLastSeen: true, nowISO: this.now() });
        if (!result.ok) return sendJSON(ws, defenseError(message.t, result, mutationId));
        try { await this.persistDefenseState(next); }
        catch (error) {
          return sendJSON(ws, defenseError(message.t, {
            error: "profile_persist_failed", mutationId
          }));
        }
        this.defense = next;
        this.sendDefenseProfileDelta(pid, {
          mutationId,
          appliesNextRound: Boolean(this.defense.activeOrder)
        });
        this.sendDefenseState(ws);
      });
    }
    if (message.t === "defenseDeviceStatus") {
      return this.runDefenseExclusive(async () => {
        const result = await this.updateDefenseDevice(ws, message, true);
        if (!result.ok) return sendJSON(ws, defenseError("defenseDeviceStatus", result));
        sendJSON(ws, { t: "defenseDeviceStatusSaved", ...result.status });
      });
    }
    if (message.t === "hb") {
      return this.runDefenseExclusive(async () => {
        const result = await this.updateDefenseDevice(ws, message, false);
        if (!result.ok) sendJSON(ws, defenseError("hb", result));
      });
    }
    if (message.t === "defenseUnlock") {
      return this.runDefenseExclusive(async () => {
        return this.runSharedPasswordExclusive(async () => {
          await this.ensureSharedPasswordLoadedUnlocked();
          const password = message.password;
          if (!this.room.pwHash) {
            if (!password) return sendJSON(ws, defenseError("defenseUnlock", { error: "need_password" }));
            if (!validNewPassword(password)) {
              return sendJSON(ws, defenseError("defenseUnlock", { error: "bad_password" }));
            }
            const hash = await sha256(password);
            try { await this.persistSharedPassword(hash); }
            catch (error) {
              return sendJSON(ws, defenseError("defenseUnlock", { error: "password_persist_failed" }));
            }
          } else if (!(await this.authOK(password))) {
            return sendJSON(ws, defenseError("defenseUnlock", { error: "bad_password" }));
          }
          this.writeDefenseAttachment(ws, {
            managerAuthorized: true,
            managerClockFresh: false,
            managerStatusAtMs: 0,
            managerDeviceId: "",
            managerClockSampleAtMs: 0,
            managerClockOffsetMs: 0
          });
          this.sendDefenseManagerState(ws);
        });
      });
    }
    if (message.t === "defenseManagerStatus") {
      return this.runDefenseExclusive(async () => {
        const attachment = this.readDefenseAttachment(ws);
        if (!attachment.managerAuthorized) {
          return sendJSON(ws, defenseError("defenseManagerStatus", { error: "manager_locked" }));
        }
        const deviceId = normalizeDeviceId(message.deviceId);
        if (!deviceId || typeof message.clockFresh !== "boolean" ||
            !Number.isSafeInteger(message.clockSampleAtMs) ||
            !Number.isSafeInteger(message.clockOffsetMs)) {
          return sendJSON(ws, defenseError("defenseManagerStatus", { error: "invalid_manager_status" }));
        }
        const nowMs = this.nowMs();
        this.writeDefenseAttachment(ws, {
          managerDeviceId: deviceId,
          managerClockFresh: message.clockFresh,
          managerStatusAtMs: nowMs,
          managerClockSampleAtMs: message.clockSampleAtMs,
          managerClockOffsetMs: message.clockOffsetMs
        });
        this.sendDefenseManagerStatusSaved(ws);
      });
    }
    if (message.t === "getDefenseManagerPlayersPage") {
      return this.runDefenseExclusive(async () => {
        const attachment = this.readDefenseAttachment(ws);
        if (!attachment.managerAuthorized) {
          return sendJSON(ws, defenseError("getDefenseManagerPlayersPage", {
            error: "manager_locked"
          }));
        }
        const page = Number.isSafeInteger(message.page) ? message.page : 0;
        if (page > 1 && (!Number.isSafeInteger(message.baseRosterRevision) ||
            message.baseRosterRevision !== this.defense.rosterRevision)) {
          return sendJSON(ws, defenseError("getDefenseManagerPlayersPage", {
            error: "roster_conflict",
            canonicalRosterRevision: this.defense.rosterRevision
          }));
        }
        if (page > 1 && (!Number.isSafeInteger(message.baseOrderRevision) ||
            message.baseOrderRevision !== this.defense.orderRevision)) {
          return sendJSON(ws, defenseError("getDefenseManagerPlayersPage", {
            error: "order_conflict",
            canonicalRevision: this.defense.orderRevision,
            canonicalOrderRevision: this.defense.orderRevision,
            canonicalRosterRevision: this.defense.rosterRevision
          }));
        }
        if (!this.sendDefenseManagerPlayersPage(ws, message.page)) {
          return sendJSON(ws, defenseError("getDefenseManagerPlayersPage", {
            error: "invalid_manager_page",
            canonicalRevision: this.defense.orderRevision
          }));
        }
      });
    }
    if (message.t === "setDefenseConfig") {
      return this.runDefenseExclusive(async () => {
        await this.ensureSharedPasswordLoaded();
        if (!(await this.authOK(message.password))) {
          return sendJSON(ws, defenseError("setDefenseConfig", {
            error: "bad_password", mutationId: message.mutationId
          }));
        }
        const result = updateDefenseConfig(this.defense, {
          ...message,
          updatedAt: this.now()
        });
        if (!result.ok) return sendJSON(ws, defenseError("setDefenseConfig", result, message.mutationId));
        if (!result.replayed) {
          try { await this.persistDefenseState(result.state); }
          catch (error) {
            return sendJSON(ws, defenseError("setDefenseConfig", {
              error: "config_persist_failed", mutationId: result.mutationId
            }));
          }
          this.defense = result.state;
        }
        sendJSON(ws, {
          t: "defenseConfigSaved",
          mutationId: result.mutationId,
          config: { ...result.config },
          revision: result.revision
        });
        this.sendDefenseSnapshots();
      });
    }
    if (message.t === "setDefensePlayerMarch") {
      return this.runDefenseExclusive(async () => {
        await this.ensureSharedPasswordLoaded();
        if (!(await this.authOK(message.password))) {
          return sendJSON(ws, defenseError("setDefensePlayerMarch", {
            error: "bad_password", mutationId: message.mutationId
          }));
        }
        const result = setDefensePlayerMarch(this.defense, message);
        if (!result.ok) {
          return sendJSON(ws, defenseError("setDefensePlayerMarch", result, message.mutationId));
        }
        if (!result.replayed) {
          try { await this.persistDefenseState(result.state); }
          catch (error) {
            return sendJSON(ws, defenseError("setDefensePlayerMarch", {
              error: "profile_persist_failed", mutationId: result.mutationId
            }));
          }
          this.defense = result.state;
        }
        const appliesNextRound = Boolean(this.defense.activeOrder);
        this.sendDefenseProfileDelta(result.pid, {
          mutationId: result.mutationId,
          appliesNextRound
        });
      });
    }
    if (message.t === "fireDefense") {
      return this.runDefenseExclusive(async () => {
        await this.ensureSharedPasswordLoaded();
        if (!(await this.authOK(message.password))) {
          return sendJSON(ws, defenseError("fireDefense", {
            error: "bad_password", mutationId: message.mutationId
          }));
        }
        const nowMs = this.nowMs();
        const replayResult = createDefenseOrder(this.defense, {
          ...message,
          orderId: crypto.randomUUID(),
          acceptedAtMs: nowMs,
          connectedPids: []
        });
        if (replayResult.replayed) {
          if (!replayResult.ok) {
            return sendJSON(ws, defenseError("fireDefense", replayResult, message.mutationId));
          }
          if (!replayResult.order) {
            return sendJSON(ws, defenseError("fireDefense", {
              error: "stale_order", mutationId: replayResult.mutationId,
              canonicalRevision: this.defense.orderRevision
            }));
          }
          try { await this.scheduleExpiry(); }
          catch (error) {
            return sendJSON(ws, defenseError("fireDefense", {
              error: "alarm_schedule_failed", mutationId: replayResult.mutationId,
              canonicalRevision: replayResult.revision
            }));
          }
          this.sendDefenseOrderAccepted(replayResult.order, ws);
          return;
        }
        if (!this.defenseManagerClockFresh(ws, nowMs)) {
          return sendJSON(ws, defenseError("fireDefense", {
            error: "manager_clock_stale", mutationId: message.mutationId
          }));
        }
        if (!Number.isSafeInteger(message.signalAtMs) ||
            message.signalAtMs < nowMs - 5_000 || message.signalAtMs > nowMs + 1_000) {
          return sendJSON(ws, defenseError("fireDefense", {
            error: "signal_out_of_bounds", mutationId: message.mutationId
          }));
        }
        const result = createDefenseOrder(this.defense, {
          ...message,
          orderId: crypto.randomUUID(),
          acceptedAtMs: nowMs,
          connectedPids: this.defenseConnectedPids()
        });
        if (!result.ok) {
          if (result.error === "order_active" && !result.replayed) {
            try { await this.persistDefenseState(result.state); }
            catch (error) {
              return sendJSON(ws, defenseError("fireDefense", {
                error: "order_persist_failed", mutationId: result.mutationId
              }));
            }
            this.defense = result.state;
          }
          return sendJSON(ws, defenseError("fireDefense", result, message.mutationId));
        }
        if (result.replayed) {
          if (!result.order) {
            return sendJSON(ws, defenseError("fireDefense", {
              error: "stale_order", mutationId: result.mutationId,
              canonicalRevision: this.defense.orderRevision
            }));
          }
          try { await this.scheduleExpiry(); }
          catch (error) {
            return sendJSON(ws, defenseError("fireDefense", {
              error: "alarm_schedule_failed", mutationId: result.mutationId,
              canonicalRevision: result.revision
            }));
          }
          this.sendDefenseOrderAccepted(result.order, ws);
          return;
        }
        this._pendingDefenseScheduleState = result.state;
        try { await this.scheduleExpiry(); }
        catch (error) {
          this._pendingDefenseScheduleState = null;
          try { await this.scheduleExpiry(); } catch (scheduleError) {}
          return sendJSON(ws, defenseError("fireDefense", {
            error: "alarm_schedule_failed", mutationId: result.mutationId,
            canonicalRevision: this.defense.orderRevision
          }));
        }
        try { await this.persistDefenseState(result.state); }
        catch (error) {
          this._pendingDefenseScheduleState = null;
          try { await this.scheduleExpiry(); } catch (scheduleError) {}
          return sendJSON(ws, defenseError("fireDefense", {
            error: "order_persist_failed", mutationId: result.mutationId
          }));
        }
        this.defense = result.state;
        this._pendingDefenseScheduleState = null;
        this._defenseFailureNotBeforeMs = 0;
        this._defensePersistenceFailures = 0;
        this.sendDefenseOrderAccepted(result.order);
      });
    }
    if (message.t === "cancelDefense") {
      return this.runDefenseExclusive(async () => {
        await this.ensureSharedPasswordLoaded();
        if (!(await this.authOK(message.password))) {
          return sendJSON(ws, defenseError("cancelDefense", {
            error: "bad_password", mutationId: message.mutationId
          }));
        }
        const result = cancelDefenseOrder(this.defense, {
          ...message,
          cancelledAtMs: this.nowMs()
        });
        if (!result.ok) return sendJSON(ws, defenseError("cancelDefense", result, message.mutationId));
        const projected = this.projectDefensePurges(
          result.state,
          this.defenseProfileOwners,
          this.defenseDevices,
          this.defenseAcks,
          result.purgePids
        );
        if (!result.replayed) {
          projected.acks = [];
          try { await this.persistDefenseBundle(projected); }
          catch (error) {
            return sendJSON(ws, defenseError("cancelDefense", {
              error: "cancel_persist_failed", mutationId: result.mutationId
            }));
          }
          this.defense = projected.defense;
          this.defenseProfileOwners = projected.profileOwners;
          this.defenseDevices = projected.devices;
          this.defenseAcks = projected.acks;
          this.defenseRemovedOwners = projected.removedOwners;
          this._defenseFailureNotBeforeMs = 0;
          this._defensePersistenceFailures = 0;
          try { await this.scheduleExpiry(); } catch (error) {}
        }
        if (result.replayed) {
          this.sendDefenseTerminal("defenseOrderCancelled", result.orderId, result.revision, ws);
        } else {
          this.sendDefenseTerminal("defenseOrderCancelled", result.orderId, result.revision);
        }
        this.closePurgedDefenseSockets(projected.pids);
      });
    }
    if (message.t === "removeDefensePlayer") {
      return this.runDefenseExclusive(async () => {
        await this.ensureSharedPasswordLoaded();
        if (!(await this.authOK(message.password))) {
          return sendJSON(ws, defenseError("removeDefensePlayer", {
            error: "bad_password", mutationId: message.mutationId
          }));
        }
        const result = removeDefensePlayer(this.defense, message);
        if (!result.ok) return sendJSON(ws, defenseError("removeDefensePlayer", result, message.mutationId));
        const projected = this.projectDefensePurges(
          result.state,
          this.defenseProfileOwners,
          this.defenseDevices,
          this.defenseAcks,
          result.purgePids
        );
        if (!result.replayed) {
          try { await this.persistDefenseBundle(projected); }
          catch (error) {
            return sendJSON(ws, defenseError("removeDefensePlayer", {
              error: "remove_persist_failed", mutationId: result.mutationId
            }));
          }
          this.defense = projected.defense;
          this.defenseProfileOwners = projected.profileOwners;
          this.defenseDevices = projected.devices;
          this.defenseAcks = projected.acks;
          this.defenseRemovedOwners = projected.removedOwners;
        }
        if (result.replayed) {
          sendJSON(ws, {
            t: "defenseProfileDelta",
            mutationId: result.mutationId,
            pid: result.pid,
            removed: result.removed === true,
            pending: result.pending,
            rosterRevision: this.defense.rosterRevision,
            profile: defenseProfileProjection(this.defense, result.pid)
          });
        } else {
          this.sendDefenseProfileDelta(result.pid, {
            mutationId: result.mutationId,
            pid: result.pid,
            removed: result.removed === true,
            pending: result.pending
          });
        }
        if (!result.pending) this.closePurgedDefenseSockets(projected.pids);
      });
    }
    if (message.t === "defenseOrderAck") {
      return this.runDefenseExclusive(async () => {
        const sendAckError = result => sendJSON(ws, {
          ...defenseError("defenseOrderAck", result),
          ...defenseAckErrorContext(message)
        });
        const attachment = this.readDefenseAttachment(ws);
        if (!attachment.pid || attachment.pid !== attachment.defenseProfilePid ||
            attachment.pid !== normalizeRoutingKey(message.pid) ||
            attachment.deviceId !== normalizeDeviceId(message.deviceId)) {
          return sendAckError({ error: "bad_ack_identity" });
        }
        if (message.audioReady !== attachment.soundReady ||
            message.clockFresh !== attachment.clockFresh) {
          return sendAckError({
            error: "ack_readiness_mismatch"
          });
        }
        const result = recordDefenseAck(
          this.defense.activeOrder,
          this.defenseAcks,
          {
            ...message,
            audioReady: attachment.soundReady,
            clockFresh: attachment.clockFresh
          },
          this.nowMs()
        );
        if (!result.ok) return sendAckError(result);
        if (result.changed) {
          try { await this.persistDefenseAcks(result.ackRecords); }
          catch (error) {
            return sendAckError({ error: "ack_persist_failed" });
          }
          this.defenseAcks = result.ackRecords;
        }
        this.sendDefenseAckSaved(result.savedAck, result.changed);
      });
    }
  }
  attachSocket(server, roomName, surface = RALLY_SURFACE) {
    const base = mergeSocketSurface({}, {
      roomName, surface, pid: "", deviceId: "", soundReady: false
    });
    const next = {
      ...base,
      ...normalizeCoreSocketAttachment(base, roomName || this.roomName),
      surface
    };
    try {
      server.serializeAttachment(next);
    } catch (error) {
      if (!attachmentNeedsAcceptedSocket(error)) {
        closeFailedSocket(server);
        throw error;
      }
      this.state.acceptWebSocket(server);
      try { server.serializeAttachment(next); }
      catch (retryError) {
        closeFailedSocket(server);
        throw retryError;
      }
      return next;
    }
    try { this.state.acceptWebSocket(server); }
    catch (error) {
      closeFailedSocket(server);
      throw error;
    }
    return next;
  }
  readSocketAttachment(ws) {
    const source = deserializeSocketAttachment(ws);
    const surface = inspectSocketSurface(source);
    if (!surface.ok) throw socketSurfaceError(surface.error);
    return {
      ...source,
      ...normalizeCoreSocketAttachment(source, source.roomName || this.roomName),
      surface: surface.surface
    };
  }
  writeSocketAttachment(ws, patch) {
    const source = deserializeSocketAttachment(ws);
    const current = this.readSocketAttachment(ws);
    const surfaceMerged = mergeSocketSurface(source, patch);
    const merged = { ...current, ...surfaceMerged };
    if (current.pid || current.deviceId) {
      merged.pid = current.pid;
      merged.deviceId = current.deviceId;
    }
    const next = { ...merged, ...normalizeCoreSocketAttachment(merged, merged.roomName || this.roomName) };
    ws.serializeAttachment(next);
    return next;
  }
  liveCoreSockets(excludeSocket = null) {
    return this.state.getWebSockets().filter(socket =>
      socket !== excludeSocket &&
      (typeof socket.readyState !== "number" || socket.readyState === 1) &&
      (() => {
        const surface = inspectSocketSurface(deserializeSocketAttachment(socket));
        return surface.ok && surface.surface === RALLY_SURFACE;
      })()
    );
  }
  liveCoreDevices(excludeSocket = null) {
    const attachments = this.liveCoreSockets(excludeSocket)
      .map(socket => this.readSocketAttachment(socket));
    return projectLiveCoreDevices(attachments, this.nowMs());
  }
  coreDeliveryDevices() {
    // Canonical devices remain useful for short-lived identity conflict and
    // history checks, but only a currently attached socket can receive a new
    // command or acknowledge it. Never count a recently closed stored device.
    return this.liveCoreDevices();
  }
  readReliableAttachment(ws) {
    const core = this.readSocketAttachment(ws);
    return { ...core, ...normalizeDeliveryAttachment(core, core.roomName || this.roomName) };
  }
  writeReliableAttachment(ws, patch) {
    const current = this.readReliableAttachment(ws);
    const allowed = {};
    for (const field of [
      "view", "shadow", "audioArmed", "armedUntilMs", "lastProbeId", "probeExpiresAtMs", "nextProbeAtMs"
    ]) {
      if (patch && typeof patch === "object" && Object.prototype.hasOwnProperty.call(patch, field)) allowed[field] = patch[field];
    }
    const normalized = normalizeDeliveryAttachment({ ...current, ...allowed }, current.roomName || this.roomName);
    this.writeSocketAttachment(ws, {
      v: normalized.v,
      qa: normalized.qa,
      view: normalized.view,
      shadow: normalized.shadow,
      audioArmed: normalized.audioArmed,
      armedUntilMs: normalized.armedUntilMs,
      lastProbeId: normalized.lastProbeId,
      probeExpiresAtMs: normalized.probeExpiresAtMs,
      nextProbeAtMs: normalized.nextProbeAtMs
    });
    return this.readReliableAttachment(ws);
  }
  initializeReliableAttachment(ws) {
    return this.writeReliableAttachment(ws, {
      view: "player",
      shadow: false,
      audioArmed: false,
      armedUntilMs: 0,
      lastProbeId: "",
      probeExpiresAtMs: 0,
      nextProbeAtMs: 0
    });
  }
  deliveryError(ws, error) {
    try { return ws.send(JSON.stringify({ t: "error", error })); } catch (sendError) {}
  }
  async persistDelivery() {
    await this.state.storage.put(DELIVERY_STORAGE_KEY, this.delivery);
  }
  issueDeliveryProbe(ws, attachment, nowMs) {
    const probeId = crypto.randomUUID();
    const expiresAtMs = nowMs + DELIVERY_ACK_WINDOW_MS;
    const next = this.writeReliableAttachment(ws, {
      lastProbeId: probeId,
      probeExpiresAtMs: expiresAtMs,
      nextProbeAtMs: nowMs + DELIVERY_PROBE_INTERVAL_MS
    });
    try {
      ws.send(JSON.stringify({
        t: "deliveryShadowProbe",
        v: DELIVERY_VERSION,
        probeId,
        sentAtMs: nowMs,
        expiresAtMs
      }));
    } catch (error) {}
    return next;
  }
  deliverySocketFor(action, nowMs) {
    for (const ws of this.liveCoreSockets()) {
      const attachment = this.readReliableAttachment(ws);
      if (attachment.qa && attachment.soundReady === true && attachment.shadow &&
          attachment.audioArmed && attachment.armedUntilMs > nowMs &&
          attachment.pid === action.pid && attachment.deviceId === action.deviceId) return ws;
    }
    return null;
  }
  flushDeliveryTargets(nowMs) {
    let changed = false;
    for (const action of dueDeliveryTargets(this.delivery, nowMs)) {
      const ws = this.deliverySocketFor(action, nowMs);
      if (ws) {
        try { ws.send(JSON.stringify(action.envelope)); } catch (error) {}
      }
      changed = recordDeliveryAttempt(this.delivery, action, nowMs) || changed;
    }
    return changed;
  }
  markReliableWakeRetryTargets(record) {
    const targets = new Set((record && Array.isArray(record.targets) ? record.targets : [])
      .map(target => `${target.pid}\n${target.deviceId}`));
    if (!targets.size) return;
    for (const ws of this.liveCoreSockets()) {
      const attachment = this.readReliableAttachment(ws);
      if (!attachment.qa || !attachment.shadow || attachment.soundReady !== true ||
          !targets.has(`${attachment.pid}\n${attachment.deviceId}`)) continue;
      try { this.writeSocketAttachment(ws, { reliableWakeRetryNeeded: true }); } catch (error) {}
    }
  }
  async dispatchDeliveryForCommand(command, nowMs) {
    if (!isQaRoomName(this.roomName)) return false;
    const record = createDeliveryRecord(command, nowMs);
    if (!record) return false;
    const previousDelivery = this.delivery;
    this.delivery = normalizeDeliveryState(previousDelivery, nowMs);
    this.delivery.roomName = this.roomName;
    this.delivery.commands.push(record);
    for (const ws of this.liveCoreSockets()) {
      upsertDeliveryTarget(
        this.delivery, record.commandId, this.readReliableAttachment(ws), nowMs
      );
    }
    this.flushDeliveryTargets(nowMs);
    pruneDeliveryState(this.delivery, nowMs);
    try {
      await this.persistDelivery();
    } catch (error) {
      this.delivery = previousDelivery;
      throw error;
    }
    try {
      await this.scheduleExpiry();
    } catch (error) {
      this.markReliableWakeRetryTargets(record);
      throw error;
    }
    return true;
  }
  async cancelDeliveryCommand(commandId, nowMs) {
    if (!isQaRoomName(this.roomName) || !commandId) return false;
    const previousDelivery = this.delivery;
    const nextDelivery = normalizeDeliveryState(previousDelivery, 0);
    nextDelivery.roomName = this.roomName;
    const record = nextDelivery.commands.find(item => item.commandId === commandId);
    if (!record || !cancelDeliveryRecord(nextDelivery, commandId, nowMs)) return false;
    this.delivery = nextDelivery;
    try {
      await this.persistDelivery();
    } catch (error) {
      this.delivery = previousDelivery;
      throw error;
    }
    const message = JSON.stringify({
      t: "deliveryShadowCancel",
      v: DELIVERY_VERSION,
      shadow: true,
      commandId,
      cancelledAtMs: record.cancelledAtMs
    });
    for (const target of record.targets) {
      const ws = this.deliverySocketFor(target, nowMs);
      if (!ws) continue;
      try { ws.send(message); } catch (error) {}
    }
    this.broadcast();
    await this.scheduleExpiry();
    return true;
  }
  async recordReliableClassicAck(ws, canonicalIdentity, message, nowMs) {
    const attachment = this.readReliableAttachment(ws);
    if (!canonicalIdentity || canonicalIdentity.pid !== attachment.pid ||
        canonicalIdentity.deviceId !== attachment.deviceId ||
        attachment.soundReady !== true) return false;
    const previousDelivery = this.delivery;
    const nextDelivery = normalizeDeliveryState(previousDelivery, nowMs);
    if (!recordClassicAck(nextDelivery, attachment, message, nowMs)) return false;
    this.delivery = nextDelivery;
    try {
      await this.persistDelivery();
    } catch (error) {
      this.delivery = previousDelivery;
      throw error;
    }
    this.broadcast();
    await this.scheduleExpiry();
    return true;
  }
  async handleDeliveryShadowMessage(ws, message) {
    const attachment = this.readReliableAttachment(ws);
    if (!attachment.qa) return this.deliveryError(ws, "qa_room_required");
    if (message.t === "deliveryShadowHello") {
      if (!attachment.pid || !attachment.deviceId || attachment.soundReady !== true ||
          message.pid !== attachment.pid || message.deviceId !== attachment.deviceId) {
        return this.deliveryError(ws, "core_identity_mismatch");
      }
      if (message.v !== DELIVERY_VERSION || message.shadow !== true) {
        return this.deliveryError(ws, "bad_delivery_hello");
      }
      const previousDelivery = this.delivery;
      this.delivery = { ...previousDelivery, roomName: attachment.roomName };
      try {
        await this.persistDelivery();
      } catch (error) {
        this.delivery = previousDelivery;
        return this.deliveryError(ws, "delivery_persist_failed");
      }
      const initialized = this.writeReliableAttachment(ws, {
        view: message.view,
        shadow: true,
        audioArmed: false,
        armedUntilMs: 0,
        lastProbeId: "",
        probeExpiresAtMs: 0,
        nextProbeAtMs: 0
      });
      this.issueDeliveryProbe(ws, initialized, this.nowMs());
      await this.scheduleExpiry();
      return;
    }
    if (message.t === "deliveryShadowProbeAck") {
      const nowMs = this.nowMs();
      if (!attachment.shadow || message.v !== DELIVERY_VERSION || !attachment.lastProbeId ||
          message.probeId !== attachment.lastProbeId || nowMs > attachment.probeExpiresAtMs) return;
      const audioArmed = message.audioArmed === true;
      const armed = this.writeReliableAttachment(ws, {
        audioArmed,
        armedUntilMs: audioArmed ? nowMs + DELIVERY_ARMED_LEASE_MS : 0,
        lastProbeId: "",
        probeExpiresAtMs: 0
      });
      const previousDelivery = this.delivery;
      let deliveryChanged = false;
      if (audioArmed) {
        this.delivery = normalizeDeliveryState(previousDelivery, nowMs);
        for (const record of this.delivery.commands) {
          deliveryChanged = !!upsertDeliveryTarget(
            this.delivery, record.commandId, armed, nowMs
          ) || deliveryChanged;
        }
        for (const ack of Array.isArray(this.deliveryAcks) ? this.deliveryAcks : []) {
          if (!ack || ack.pid !== armed.pid || ack.deviceId !== armed.deviceId) continue;
          deliveryChanged = recordClassicAck(
            this.delivery, armed, ack, nowMs
          ) || deliveryChanged;
        }
        deliveryChanged = this.flushDeliveryTargets(nowMs) || deliveryChanged;
        deliveryChanged = pruneDeliveryState(this.delivery, nowMs) || deliveryChanged;
      }
      if (deliveryChanged) {
        try {
          await this.persistDelivery();
        } catch (error) {
          this.delivery = previousDelivery;
          return this.deliveryError(ws, "delivery_persist_failed");
        }
        this.broadcast();
      } else if (audioArmed) {
        this.delivery = previousDelivery;
      }
      await this.scheduleExpiry();
      return;
    }
    if (message.t === "deliveryShadowAck") {
      if (typeof message.commandId !== "string" || !message.commandId ||
          !Number.isInteger(message.futureCueCount) || message.futureCueCount < 0 ||
          message.futureCueCount > 12) return;
      const nowMs = this.nowMs();
      const previousDelivery = this.delivery;
      const nextDelivery = normalizeDeliveryState(previousDelivery, nowMs);
      if (!recordShadowAck(nextDelivery, attachment, message, nowMs)) return;
      this.delivery = nextDelivery;
      try {
        await this.persistDelivery();
      } catch (error) {
        this.delivery = previousDelivery;
        return this.deliveryError(ws, "delivery_persist_failed");
      }
      this.broadcast();
      await this.scheduleExpiry();
      return;
    }
    return this.deliveryError(ws, "unsupported_delivery_message");
  }
  observeDevice(ws, message) {
    const pid = normalizeRoutingKey(message && message.pid);
    if (!pid || !Object.prototype.hasOwnProperty.call(this.room.players, pid)) {
      return { ok: false, error: 'player_missing' };
    }
    const nowMs = this.nowMs();
    const attachmentBefore = this.readSocketAttachment(ws);
    const devicesBefore = this.devices.slice();
    const registry = pruneDevices(devicesBefore, nowMs).concat(this.liveCoreDevices());
    const result = bindCoreSocketIdentity(attachmentBefore, registry, message, nowMs);
    if (!result.ok) return result;
    this.writeSocketAttachment(ws, { ...result.attachment, lastSeenMs: nowMs });
    const attachmentAfter = this.readSocketAttachment(ws);
    const presenceChanged = (!attachmentBefore.pid || !attachmentBefore.deviceId) &&
      !!attachmentAfter.pid && !!attachmentAfter.deviceId;
    const liveDevice = this.liveCoreDevices().find(device => device.deviceId === attachmentAfter.deviceId);
    const canonicalBefore = (Array.isArray(devicesBefore) ? devicesBefore : [])
      .find(device => normalizeDeviceId(device.deviceId) === attachmentAfter.deviceId);
    const changed = !!liveDevice && (!canonicalBefore ||
      normalizeRoutingKey(canonicalBefore.pid) !== liveDevice.pid ||
      (canonicalBefore.soundReady === true) !== liveDevice.soundReady);
    const devicesAfter = changed ? touchDevice(devicesBefore, liveDevice, nowMs) : devicesBefore;
    this.devices = devicesAfter;
    return {
      ok: true,
      changed,
      presenceChanged,
      attachmentBefore,
      attachmentAfter,
      devicesBefore,
      devicesAfter
    };
  }
  failClosedSocketReadiness(ws, observation) {
    const attachment = observation && observation.attachmentAfter
      ? observation.attachmentAfter : this.readSocketAttachment(ws);
    try {
      this.writeSocketAttachment(ws, {
        pid: attachment.pid,
        deviceId: attachment.deviceId,
        soundReady: false,
        lastSeenMs: attachment.lastSeenMs
      });
    } catch (error) {}
  }
  async releaseSocketDevice(ws) {
    // Presence/readiness is projected from OPEN socket attachments. Keep the
    // fresh canonical record untouched so ownership rules stay identical
    // before and after Durable Object hibernation; normal TTL pruning owns it.
  }
  async authOK(pw) {
    if (!validPresentedPassword(pw)) return false;
    if (pw === this.env.MASTER) return true;
    return !!this.room.pwHash && (await sha256(pw)) === this.room.pwHash;
  }
  now() { return new Date().toISOString(); }
  nowMs() { return Date.now(); }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_OPERATIONAL_FRAME_BYTES ||
        new TextEncoder().encode(raw).byteLength > MAX_OPERATIONAL_FRAME_BYTES) {
      try { ws.close(typeof raw === "string" ? 1009 : 1003, "invalid_frame"); } catch (error) {}
      return;
    }
    const socketSurface = inspectSocketSurface(deserializeSocketAttachment(ws));
    if (!socketSurface.ok) return sendSurfaceError(ws, socketSurface.error);
    if (socketSurface.needsMigration) {
      try { this.writeSocketAttachment(ws, { surface: RALLY_SURFACE }); }
      catch (error) { return sendSurfaceError(ws, "invalid_surface"); }
    }
    if (socketSurface.surface === DEFENSE_SURFACE) {
      await this.ensureDefenseLoaded();
      let message;
      try { message = JSON.parse(raw); }
      catch (error) {
        return sendJSON(ws, { t: "error", source: "defense", error: "invalid_message" });
      }
      return this.handleDefenseMessage(ws, message);
    }
    await this.ensureRallyLoaded();
    await this.ensureDeliveryLoaded();
    let m; try { m = JSON.parse(raw); } catch (e) { return; }

    if (DEFENSE_ONLY_MESSAGE_TYPES.has(m && m.t)) {
      return sendJSON(ws, {
        t: "error",
        source: "rally",
        ...(normalizeMutationId(m.mutationId) ? { mutationId: normalizeMutationId(m.mutationId) } : {}),
        error: "wrong_surface"
      });
    }

    if (typeof m.t === "string" && m.t.startsWith("deliveryShadow")) {
      return this.runSharedPasswordExclusive(() => this.handleDeliveryShadowMessage(ws, m));
    }

    if (RALLY_CANONICAL_MESSAGE_TYPES.has(m.t)) {
      return this.runSharedPasswordExclusive(() => this.handleRallyMessage(ws, m));
    }
    return this.handleRallyMessage(ws, m);
  }

  async handleRallyMessage(ws, m) {

    if (m.t === "setRallyMode") {
      const mutationId = normalizeMutationId(m.mutationId);
      if (!(await this.authOK(m.password))) {
        return ws.send(JSON.stringify({ t: "error", error: "bad_password", mutationId }));
      }
      await this.applyTripleGate();
      if (!mutationId) return ws.send(JSON.stringify({ t: "error", error: "invalid_mutation" }));
      if (m.mode === "triple" && !isTripleAllowed(this.env, this.roomName)) {
        return ws.send(JSON.stringify({ t: "error", error: "triple_disabled", mutationId }));
      }
      const result = transitionRallyMode({
        rallyModes: this.room.rallyModes,
        staged: this.room.live.staged
      }, {
        kingdom: m.kingdom,
        mode: m.mode,
        baseRevision: m.baseRevision
      });
      if (!result.ok) {
        return ws.send(JSON.stringify({
          t: "error", error: result.error, mutationId,
          kingdom: Number(m.kingdom), record: result.record || null
        }));
      }
      const previousModes = this.room.rallyModes;
      const previousStaged = this.room.live.staged;
      this.room.rallyModes = result.rallyModes;
      this.room.live.staged = result.staged;
      try {
        await this.persist();
      } catch (error) {
        this.room.rallyModes = previousModes;
        this.room.live.staged = previousStaged;
        throw error;
      }
      try {
        ws.send(JSON.stringify({
          t: "rallyModeSaved", mutationId, kingdom: Number(m.kingdom),
          mode: result.record.mode, revision: result.record.revision
        }));
      } catch (e) {}
      this.broadcast();
      return;
    }

    if (m.t === "deviceStatus") {
      const observation = this.observeDevice(ws, m);
      if (!observation.ok) return ws.send(JSON.stringify({ t: "error", source: "deviceStatus", error: observation.error }));
      if (observation.changed) {
        try {
          await this.persistDevices();
        } catch (error) {
          this.devices = observation.devicesBefore;
          this.failClosedSocketReadiness(ws, observation);
          return ws.send(JSON.stringify({
            t: "error", source: "deviceStatus", error: "device_status_persist_failed"
          }));
        }
      }
      const attachment = this.readSocketAttachment(ws);
      ws.send(JSON.stringify({
        t: "deviceStatusSaved", pid: attachment.pid, deviceId: attachment.deviceId, soundReady: attachment.soundReady
      }));
      if (observation.changed || observation.presenceChanged) this.broadcast();
      const activeDelivery = !!(this.delivery && Array.isArray(this.delivery.commands) && this.delivery.commands.length);
      const reliableAttachment = this.readReliableAttachment(ws);
      if (activeDelivery && reliableAttachment.shadow && reliableAttachment.soundReady &&
          (observation.changed || observation.presenceChanged || reliableAttachment.reliableWakeRetryNeeded === true)) {
        await this.ensureReliableWakeForReadySocket(ws);
      }
      return;
    }

    if (m.t === "deliveryAck") {
      const attachment = this.readSocketAttachment(ws);
      const receiptKey = deliveryAckReceiptKey(m);
      const receiptKeys = Array.isArray(attachment.deliveryAckReceiptKeys)
        ? attachment.deliveryAckReceiptKeys.filter(value => typeof value === "string").slice(-8) : [];
      const sameSocketReceipt = receiptKeys.includes(receiptKey);
      if (!sameSocketReceipt &&
          (!coreAttachmentMatchesAck(attachment, m) || !registryMatchesAck(this.coreDeliveryDevices(), attachment, this.nowMs()))) {
        return ws.send(JSON.stringify(deliveryAckError(m, "bad_delivery_identity")));
      }
      let command = null;
      for (const kingdom of [1, 2]) {
        const candidate = this.room.live.commands[kingdom];
        if (candidate && candidate.id === String(m.commandId || "")) { command = candidate; break; }
      }
      const previousAcks = this.deliveryAcks;
      const previousDelivery = command && Array.isArray(command.delivery) ? command.delivery.map(value => ({ ...value })) : command && command.delivery;
      const result = recordCommandAck(command, this.deliveryAcks, m, this.nowMs());
      if (!result.ok) return ws.send(JSON.stringify(deliveryAckError(m, result.error)));
      if (result.changed) {
        this.deliveryAcks = result.ackRecords;
        try {
          await this.persistAll();
        } catch (error) {
          this.deliveryAcks = previousAcks;
          command.delivery = previousDelivery;
          return ws.send(JSON.stringify(deliveryAckError(m, "delivery_persist_failed")));
        }
        try { this.broadcast(); } catch (error) {}
      }
      if (!sameSocketReceipt) {
        this.writeSocketAttachment(ws, {
          deliveryAckReceiptKeys: receiptKeys.concat(receiptKey).slice(-8)
        });
      }
      const { atMs, ...savedAck } = result.savedAck;
      try { ws.send(JSON.stringify({ t: "deliveryAckSaved", ...savedAck })); } catch (error) {}
      try {
        await this.recordReliableClassicAck(ws, {
          pid: result.savedAck.pid,
          deviceId: result.savedAck.deviceId
        }, result.savedAck, this.nowMs());
      } catch (error) {}
      return;
    }

    if (m.t === "setMarch" || m.t === "registerPlayer") {
      const pid = normalizeRoutingKey(m.pid);
      const registrationId = normalizeMutationId(m.registrationId);
      const recoverOnly = m.recoverOnly === true;
      if (recoverOnly && (!pid || !Object.prototype.hasOwnProperty.call(this.room.players, pid))) {
        return ws.send(JSON.stringify(registrationError("player_missing", registrationId, pid)));
      }
      const profileKey = normalizeDeviceId(m.profileKey);
      const ownerHash = profileKey ? await sha256(profileKey) : "";
      if (pid && Object.prototype.hasOwnProperty.call(this.room.players, pid)) {
        const expectedOwner = this.profileOwners && this.profileOwners[pid];
        const editable = !!ownerHash && typeof expectedOwner === "string" &&
          expectedOwner.length === 64 && expectedOwner === ownerHash;
        return ws.send(JSON.stringify(playerRegisteredMessage(
          registrationId, pid, this.room.players[pid], false, editable
        )));
      }
      if (recoverOnly) {
        return ws.send(JSON.stringify(registrationError("player_missing", registrationId, pid)));
      }
      if (!profileKey) return ws.send(JSON.stringify(registrationError("invalid_profile_key", registrationId)));
      const nextPlayers = normalizePlayerRecords(this.room.players);
      const result = registerPlayer(nextPlayers, m, this.now());
      if (!result.ok) return ws.send(JSON.stringify(Object.assign({ t: "error", registrationId }, result)));
      if (Object.keys(nextPlayers).length > 150) {
        return ws.send(JSON.stringify(registrationError("roster_full", registrationId)));
      }
      const nextOwners = normalizeProfileOwners(this.profileOwners);
      nextOwners[result.pid] = ownerHash;
      const previousPlayers = this.room.players;
      const previousOwners = this.profileOwners;
      this.room.players = nextPlayers;
      this.profileOwners = nextOwners;
      try {
        await this.persistAll();
      } catch (error) {
        this.room.players = previousPlayers;
        this.profileOwners = previousOwners;
        return ws.send(JSON.stringify(registrationError(
          "registration_persist_failed", registrationId, result.pid
        )));
      }
      try {
        ws.send(JSON.stringify(playerRegisteredMessage(
          registrationId, result.pid, result.player, true, true
        )));
      } catch (error) {}
      this.broadcast(); return;
    }

    if (m.t === "updateOwnProfile") {
      const mutationId = normalizeMutationId(m.mutationId);
      const pid = normalizeRoutingKey(m.pid);
      const attachment = this.readSocketAttachment(ws);
      if (!attachment.pid || attachment.pid !== pid) {
        return ws.send(JSON.stringify({ t: "error", error: "core_identity_mismatch", mutationId, pid }));
      }
      if (!(await profileOwnerMatches(() => this.profileOwners, pid, m.profileKey))) {
        return ws.send(JSON.stringify({ t: "error", error: "profile_owner_mismatch", mutationId, pid }));
      }
      const previousPlayer = this.room.players[pid];
      const result = applyOwnProfileUpdate(this.room.players, m, { touchLastSeen: true, nowISO: this.now() });
      if (!result.ok) return ws.send(JSON.stringify(Object.assign({ t: "error" }, result)));
      try {
        await this.persist();
      } catch (error) {
        this.room.players[pid] = previousPlayer;
        return ws.send(JSON.stringify({
          t: "error", error: "profile_persist_failed", mutationId: result.mutationId, pid: result.pid
        }));
      }
      try {
        ws.send(JSON.stringify(Object.assign({
          t: "playerProfileSaved", mutationId: result.mutationId
        }, result.profile)));
      } catch (e) {}
      this.broadcast(); return;
    }

    if (m.t === "updateOwnMarch") {
      const mutationId = normalizeMutationId(m.mutationId);
      const pid = normalizeRoutingKey(m.pid);
      const attachment = this.readSocketAttachment(ws);
      if (!attachment.pid || attachment.pid !== pid) {
        return ws.send(JSON.stringify({ t: "error", error: "core_identity_mismatch", mutationId, pid }));
      }
      if (!(await profileOwnerMatches(() => this.profileOwners, pid, m.profileKey))) {
        return ws.send(JSON.stringify({ t: "error", error: "profile_owner_mismatch", mutationId, pid }));
      }
      const previousPlayer = this.room.players[pid] && { ...this.room.players[pid] };
      const result = applyPlayerMarchUpdate(this.room.players, m, { touchLastSeen: true, nowISO: this.now() });
      if (!result.ok) return ws.send(JSON.stringify(Object.assign({ t: "error" }, result)));
      try {
        await this.persist();
      } catch (error) {
        if (previousPlayer) this.room.players[pid] = previousPlayer;
        return ws.send(JSON.stringify({
          t: "error", error: "profile_persist_failed", mutationId: result.mutationId, pid: result.pid
        }));
      }
      ws.send(JSON.stringify({
        t: "playerMarchSaved", mutationId: result.mutationId, pid: result.pid, march: result.march, revision: result.revision
      }));
      this.broadcast(); return;
    }

    if (m.t === "setPlayerMarch") {
      const mutationId = normalizeMutationId(m.mutationId);
      if (!(await this.authOK(m.password))) return ws.send(JSON.stringify({ t: "error", error: "bad_password", mutationId }));
      const pid = normalizeRoutingKey(m.pid);
      const previousPlayer = this.room.players[pid] && { ...this.room.players[pid] };
      const result = applyPlayerMarchUpdate(this.room.players, m);
      if (!result.ok) return ws.send(JSON.stringify(Object.assign({ t: "error" }, result)));
      try {
        await this.persist();
      } catch (error) {
        if (previousPlayer) this.room.players[pid] = previousPlayer;
        return ws.send(JSON.stringify({
          t: "error", error: "profile_persist_failed", mutationId: result.mutationId, pid: result.pid
        }));
      }
      try {
        ws.send(JSON.stringify({
          t: "playerMarchSaved", mutationId: result.mutationId, pid: result.pid, march: result.march, revision: result.revision
        }));
      } catch (e) {}
      this.broadcast(); return;
    }

    if (m.t === "removePlayer") {
      // Authenticate before checking whether the pid exists, so the roster cannot be probed through errors.
      if (!(await this.authOK(m.password))) return ws.send(JSON.stringify({ t: "error", error: "bad_password" }));
      const previousRoom = this.room;
      this.room = {
        ...previousRoom,
        players: normalizePlayerRecords(previousRoom.players),
        live: {
          ...previousRoom.live,
          staged: { ...previousRoom.live.staged }
        }
      };
      const result = removePlayerAtomic(this.room, m.pid, Math.floor(this.nowMs() / 1000));
      if (!result.ok) {
        this.room = previousRoom;
        if (result.error === "player_missing") return;   // idempotent cleanup: another commander may have removed it already
        return ws.send(JSON.stringify({ t: "error", error: result.error, pid: result.pid }));
      }
      const previousDevices = this.devices;
      const previousDeliveryAcks = this.deliveryAcks;
      const previousOwners = this.profileOwners;
      const privateState = removePlayerDelivery(this.devices, this.deliveryAcks, result.pid);
      this.devices = privateState.devices; this.deliveryAcks = privateState.ackRecords;
      this.profileOwners = normalizeProfileOwners(this.profileOwners);
      delete this.profileOwners[result.pid];
      try {
        await this.persistAll();
      } catch (error) {
        this.room = previousRoom;
        this.devices = previousDevices;
        this.deliveryAcks = previousDeliveryAcks;
        this.profileOwners = previousOwners;
        return ws.send(JSON.stringify({ t: "error", error: "remove_persist_failed", pid: result.pid }));
      }
      this.broadcast(); return;
    }

    if (m.t === "setConfig") {
      const first = !this.room.pwHash;
      let claimedHash = this.room.pwHash;
      if (first) {
        if (!m.password) return ws.send(JSON.stringify({ t: "error", error: "need_password" }));
        if (!validNewPassword(m.password)) {
          return ws.send(JSON.stringify({ t: "error", error: "bad_password" }));
        }
        claimedHash = await sha256(m.password);
      } else if (!(await this.authOK(m.password))) {
        return ws.send(JSON.stringify({ t: "error", error: "bad_password" }));
      }
      if (m.baseUpdatedAt !== undefined && this.room.updatedAt && m.baseUpdatedAt !== this.room.updatedAt) {
        return ws.send(JSON.stringify({ t: "error", error: "conflict", room: this.snapshot() }));
      }
      const candidate = {
        ...this.room,
        pwHash: claimedHash,
        config: sanitizeConfig(m.config),
        updatedAt: this.now(),
        updatedBy: clampStr(m.by, 24)
      };
      await this.persist(candidate);
      this.room = candidate;
      this.broadcast();
      return;
    }

    if (m.t === "cmd") {
      if (!(await this.authOK(m.password))) return ws.send(JSON.stringify({ t: "error", error: "bad_password" }));
      const c = m.cmd || {};
      const type = ["double_rally", "triple_rally", "refill", "cancel", "ping"].includes(c.type) ? c.type : "refill";
      const kd = clampInt(c.kingdom != null ? c.kingdom : (c.payload && c.payload.kingdom), 1, 2);
      const incomingRally = type === "double_rally" || type === "triple_rally";
      if (incomingRally) await this.applyTripleGate();
      const modeRecord = this.room.rallyModes[kd];
      const requestedMode = type === "triple_rally" ? "triple" : "double";
      const requestRevision = Number.isInteger(c.modeRevision)
        ? c.modeRevision
        : (requestedMode === "double" ? modeRecord.revision : -1);
      if (type === "triple_rally" && !isTripleAllowed(this.env, this.roomName)) {
        return ws.send(JSON.stringify({ t: "error", error: "triple_disabled" }));
      }
      if (incomingRally &&
          (requestedMode !== modeRecord.mode || requestRevision !== modeRecord.revision)) {
        return ws.send(JSON.stringify({
          t: "error", error: "rally_mode_conflict", kingdom: kd, record: modeRecord
        }));
      }
      let cancelledCommandId = "";
      // Neither Refill nor another rally may silently clobber a countdown already in flight.
      const existing = this.room.live.commands[kd];
      const storedRally = existing && (existing.type === "double_rally" || existing.type === "triple_rally");
      if ((type === "refill" || incomingRally) && storedRally &&
          Number(existing.expiresUTC) > Math.floor(this.nowMs() / 1000)) {
        return ws.send(JSON.stringify({ t: "error", error: "rally_live" }));
      }
      if (type === "triple_rally") {
        const commandNowMs = this.nowMs();
        const validated = validateStagedPairs({
          modeRecord,
          modeRevision: requestRevision,
          pairs: c.payload && c.payload.pairs,
          players: this.room.players
        });
        if (!validated.ok || validated.pairs.length !== 3) {
          return ws.send(JSON.stringify({
            t: "error", error: validated.error || "invalid_rally_roster", pid: validated.pid
          }));
        }
        const liveConflict = crossKingdomLiveCaptain(
          this.room.live, kd, validated.pairs, Math.floor(commandNowMs / 1000)
        );
        if (liveConflict) {
          return ws.send(JSON.stringify({ t: "error", error: "rally_live", ...liveConflict }));
        }
        const built = buildTripleRallyCommand({
          players: this.room.players,
          pairs: validated.pairs,
          kingdom: kd,
          leadSeconds: c.payload && c.payload.leadSeconds,
          serverNowSec: commandNowMs / 1000,
          commandId: crypto.randomUUID(),
          atISO: this.now()
        });
        if (!built.ok) {
          return ws.send(JSON.stringify({ t: "error", error: built.error, pid: built.pid }));
        }
        built.command.delivery = startCommandDelivery(built.command, this.coreDeliveryDevices(), commandNowMs);
        this.room.live.commands[kd] = built.command;
        this.room.live.staged[kd] = null;
        this.room.live.mode = "live";
        await this.persistAll();
        const scheduleReady = await this.tryScheduleCommittedRally(commandNowMs);
        this.broadcast();
        try { await this.dispatchDeliveryForCommand(built.command, commandNowMs); } catch (error) {}
        if (!scheduleReady) await this.tryScheduleCommittedRally(commandNowMs);
        return;
      }
      if (type === "cancel") {
        const cancelledCommand = this.room.live.commands[kd];
        if (!cancelledCommand) return;
        const nowSec = Math.floor(this.nowMs() / 1000);
        if (Number(cancelledCommand.expiresUTC) <= nowSec) return;
        cancelledCommandId = typeof cancelledCommand.id === "string" ? cancelledCommand.id : "";
        const restoredStage = cancelledRallyStage(
          this.room, kd, cancelledCommand, nowSec
        );
        this.room.live.commands[kd] = null;
        if (restoredStage !== undefined) this.room.live.staged[kd] = restoredStage;
      } else {
        let payload = (c.payload && typeof c.payload === "object") ? c.payload : {};
        if (type === "double_rally") {
          const frozen = freezeDoubleRally(this.room.players, payload.pairs, payload.firstPress != null ? payload.firstPress : c.anchorUTC);
          if (!frozen.ok) return ws.send(JSON.stringify({ t: "error", error: frozen.error }));
          const liveConflict = crossKingdomLiveCaptain(
            this.room.live, kd, frozen.pairs, Math.floor(this.nowMs() / 1000)
          );
          if (liveConflict) {
            return ws.send(JSON.stringify({ t: "error", error: "rally_live", ...liveConflict }));
          }
          payload = Object.assign({}, payload, {
            pairs: frozen.pairs,
            firstPress: Math.min(...frozen.pairs.map(pair => pair.pressUTC))
          });
        }
        const anchorUTC = clampInt(c.anchorUTC, 0, 4102444800);  // unix seconds
        // when this command stops being actionable → snapshot()/alarm() drops it so nobody gets a stale GO.
        // double_rally stays live through the REAL flight: press + 5:00 gather + march (+30s grace) — the
        // timeline shows the full gather→march→land arc, so it must not vanish 30s after the click.
        const GATHER = 300;
        let expiresUTC = anchorUTC + 30;
        if (type === "ping") expiresUTC = anchorUTC + 6;
        else if (type === "double_rally" && Array.isArray(payload.pairs) && payload.pairs.length) expiresUTC = Math.max(...payload.pairs.map(p => (+p.pressUTC || anchorUTC) + GATHER + (+p.march || 0))) + 30;
        const command = { id: crypto.randomUUID(), type, kingdom: kd, anchorUTC, expiresUTC, payload, text: clampStr(c.text, 200), at: this.now() };
        command.delivery = startCommandDelivery(command, this.coreDeliveryDevices(), this.nowMs());
        this.room.live.commands[kd] = command;
      }
      if (type !== "cancel") {
        this.room.live.staged[kd] = null;
      }
      this.room.live.mode = (this.room.live.commands[1] || this.room.live.commands[2]) ? "live" : "idle";
      const commandCommittedAtMs = this.nowMs();
      await this.persistAll();
      const scheduleReady = await this.tryScheduleCommittedRally(commandCommittedAtMs);
      this.broadcast();
      const reliableCommand = type === "double_rally" ? this.room.live.commands[kd] : null;
      if (reliableCommand) {
        try { await this.dispatchDeliveryForCommand(reliableCommand, this.nowMs()); } catch (error) {}
      }
      if (cancelledCommandId) {
        try { await this.cancelDeliveryCommand(cancelledCommandId, this.nowMs()); } catch (error) {}
      }
      if (!scheduleReady) await this.tryScheduleCommittedRally(commandCommittedAtMs);
      return;
    }

    if (m.t === "stage") {   // commander pre-warns the picked captains (before the actual fire) so a whale who stepped away can stand by
      if (!(await this.authOK(m.password))) return ws.send(JSON.stringify({ t: "error", error: "bad_password" }));
      await this.applyTripleGate();
      const s = m.staged || {};
      const kd = clampInt(s.kingdom, 1, 2);
      const liveCommand = this.room.live.commands[kd];
      if (liveCommand && Number(liveCommand.expiresUTC) > Math.floor(this.nowMs() / 1000)) {
        return ws.send(JSON.stringify({ t: "stageSuperseded", kingdom: kd, commandId: liveCommand.id }));
      }
      const modeRecord = this.room.rallyModes[kd];
      const modeRevision = Number.isInteger(s.modeRevision)
        ? s.modeRevision
        : (modeRecord.mode === "double" ? modeRecord.revision : -1);
      const validated = validateStagedPairs({
        modeRecord,
        modeRevision,
        pairs: s.pairs,
        players: this.room.players
      });
      if (!validated.ok) {
        const error = { t: "error", error: validated.error };
        if (validated.error === "rally_mode_conflict") {
          error.kingdom = kd;
          error.record = validated.record || modeRecord;
        }
        return ws.send(JSON.stringify(error));
      }
      const pairs = validated.pairs;
      const otherKingdom = kd === 1 ? 2 : 1;
      const liveConflict = crossKingdomLiveCaptain(
        this.room.live, kd, pairs, Math.floor(this.nowMs() / 1000)
      );
      if (liveConflict) {
        return ws.send(JSON.stringify({
          t: "error", error: "player_staged_other_kingdom", ...liveConflict
        }));
      }
      const otherPairs = ((this.room.live.staged[otherKingdom] && this.room.live.staged[otherKingdom].pairs) || []);
      const conflict = pairs.find(pair => otherPairs.some(other => other && other.pid === pair.pid));
      if (conflict) return ws.send(JSON.stringify({ t: "error", error: "player_staged_other_kingdom", pid: conflict.pid, kingdom: otherKingdom }));
      const prevPids = new Set(((this.room.live.staged[kd] && this.room.live.staged[kd].pairs) || []).map(p => p.pid));
      this.room.live.staged[kd] = pairs.length ? { kingdom: kd, pairs } : null;
      pairs.forEach(p => { if (!prevPids.has(p.pid) && this.room.players[p.pid]) this.room.players[p.pid].ready = false; });   // only reset ready for NEWLY staged captains — a role swap must not wipe an already-confirmed captain
      await this.persist(); this.broadcast(); return;
    }

    if (m.t === "ready") {   // a staged captain confirms they're on the page & standing by
      const pid = clampStr(m.pid, 24);
      if (pid && this.room.players[pid]) { this.room.players[pid].ready = !!m.ready; await this.persist(); this.broadcast(); }
      return;
    }

    if (m.t === "sim") {
      if (!(await this.authOK(m.password))) return ws.send(JSON.stringify({ t: "error", error: "bad_password" }));
      if (m.action === "start") {
        this.room.live.mode = "sim";
        this.room.live.sim = { script: clampStr(m.script, 40), startUTC: clampInt(m.startUTC, 0, 4102444800), id: crypto.randomUUID() };
      } else {
        this.room.live.sim = null;
        this.room.live.mode = (this.room.live.commands[1] || this.room.live.commands[2]) ? "live" : "idle";
      }
      await this.persist(); this.broadcast(); return;
    }
    if (m.t === "hb") {   // app-level heartbeat: keep this player "fresh" so eviction never targets someone who's present.
      const pid = clampStr(m.pid, 24);
      if (pid && this.room.players[pid]) {
        let observation = null;
        if (m.deviceId != null || typeof m.soundReady === "boolean") {
          observation = this.observeDevice(ws, m);
          if (!observation.ok) return ws.send(JSON.stringify({
            t: "error", source: "deviceStatus", error: observation.error
          }));
          if (observation.changed) {
            try {
              await this.persistDevices();
            } catch (error) {
              this.devices = observation.devicesBefore;
              this.failClosedSocketReadiness(ws, observation);
              return ws.send(JSON.stringify({
                t: "error", source: "deviceStatus", error: "device_status_persist_failed"
              }));
            }
          }
          if (observation.changed || observation.presenceChanged) this.broadcast();
        }
        const activeDelivery = !!(this.delivery && Array.isArray(this.delivery.commands) && this.delivery.commands.length);
        const reliableAttachment = this.readReliableAttachment(ws);
        if (activeDelivery && reliableAttachment.shadow && reliableAttachment.soundReady &&
            ((observation && (observation.changed || observation.presenceChanged)) || reliableAttachment.reliableWakeRetryNeeded === true)) {
          await this.ensureReliableWakeForReadySocket(ws);
        }
      }
      return;
    }
    // m.t === "hello" → snapshot already sent on connect; nothing else needed
  }

  // pids the roster cap must never evict: anyone in a live command or staged set
  referencedPids() {
    const s = new Set();
    for (const k of [1, 2]) {
      const c = this.room.live.commands[k]; if (c && c.payload && Array.isArray(c.payload.pairs)) c.payload.pairs.forEach(p => s.add(p.pid));
      const st = this.room.live.staged[k]; if (st && Array.isArray(st.pairs)) st.pairs.forEach(p => s.add(p.pid));
    }
    return s;
  }

  async webSocketClose(ws) {
    const surface = inspectSocketSurface(deserializeSocketAttachment(ws));
    if (!surface.ok) {
      try { ws.close(); } catch (error) {}
      return;
    }
    if (surface.surface === DEFENSE_SURFACE) {
      await this.ensureDefenseLoaded();
      let pid = "";
      try { pid = this.readDefenseAttachment(ws).defenseProfilePid; } catch (error) {}
      try { ws.close(); } catch (error) {}
      if (pid) this.sendDefensePresenceDelta(pid, ws);
      return;
    }
    await this.ensureRallyLoaded();
    await this.ensureDeliveryLoaded();
    await this.releaseSocketDevice(ws);
    try { ws.close(); } catch (error) {}
    this.broadcast();
  }
  async webSocketError(ws) {
    const surface = inspectSocketSurface(deserializeSocketAttachment(ws));
    if (!surface.ok) return;
    if (surface.surface === DEFENSE_SURFACE) {
      await this.ensureDefenseLoaded();
      let pid = "";
      try { pid = this.readDefenseAttachment(ws).defenseProfilePid; } catch (error) {}
      if (pid) this.sendDefensePresenceDelta(pid, ws);
      return;
    }
    await this.ensureRallyLoaded();
    this.broadcast();
  }
}
