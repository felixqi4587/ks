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
      let storedDelivery = null;
      try { storedDelivery = await this.state.storage.get(DELIVERY_STORAGE_KEY); } catch (error) {}
      this.delivery = normalizeDeliveryState(storedDelivery || this.delivery, this.nowMs());
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
        return new Response(JSON.stringify({ t: "error", error: "defense_not_available" }), {
          status: 503,
          headers: { "Content-Type": "application/json; charset=utf-8" }
        });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.attachSocket(server, this.roomName, DEFENSE_SURFACE);
      sendSurfaceError(server, "defense_not_available");
      return new Response(null, { status: 101, webSocket: client });
    }

    await this.ensureRallyLoaded();
    await this.ensureDeliveryLoaded();
    await this.applyTripleGate();
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
  async scheduleExpiry() {
    const classic = [1, 2]
      .map(k => this.room.live.commands[k])
      .filter(c => c && c.expiresUTC)
      .map(c => Number(c.expiresUTC) * 1000 + 600)
      .filter(atMs => Number.isFinite(atMs) && atMs > 0);
    const nowMs = this.nowMs();
    const reliable = [];
    if (isQaRoomName(this.roomName)) {
      const deliveryAt = this.delivery ? nextDeliveryWakeAt(this.delivery, nowMs) : null;
      const hasActiveDelivery = !!(this.delivery && Array.isArray(this.delivery.commands) && this.delivery.commands.length);
      const probeAt = hasActiveDelivery ? this.nextProbeWakeAt(nowMs) : null;
      if (Number.isFinite(deliveryAt) && deliveryAt > 0) {
        const failureNotBeforeMs = Number.isFinite(this._deliveryFailureNotBeforeMs)
          ? this._deliveryFailureNotBeforeMs : 0;
        reliable.push(deliveryAt <= nowMs
          ? Math.max(nowMs + 1, failureNotBeforeMs)
          : deliveryAt);
      }
      if (Number.isFinite(probeAt) && probeAt > 0) {
        reliable.push(probeAt <= nowMs ? nowMs + 1 : probeAt);
      }
    }
    const wakeups = classic.concat(reliable);
    if (wakeups.length) await this.state.storage.setAlarm(Math.min(...wakeups));
    else await this.state.storage.deleteAlarm();   // clear the alarm when idle so a cancel doesn't leave a spurious wake armed
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

    if (Number.isFinite(this._deliveryFailureNotBeforeMs) &&
        this._deliveryFailureNotBeforeMs > nowMs) return attachmentChanged;

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
    await this.ensureRallyLoaded();
    this.normalizeLive();
    const nowMs = this.nowMs();
    const nowS = Math.floor(nowMs / 1000);
    let changed = false;
    for (const k of [1, 2]) { const c = this.room.live.commands[k]; if (c && c.expiresUTC && nowS >= c.expiresUTC) { this.room.live.commands[k] = null; changed = true; } }
    if (changed) { this.room.live.mode = this.room.live.sim ? "sim" : ((this.room.live.commands[1] || this.room.live.commands[2]) ? "live" : "idle"); await this.persist(); }
    try {
      await this.runDeliveryWake(nowMs);
      if (!Number.isFinite(this._deliveryFailureNotBeforeMs) ||
          this._deliveryFailureNotBeforeMs <= nowMs) this._deliveryFailureNotBeforeMs = 0;
    } catch (error) {
      if (error && error.deliveryWakePersistenceFailure) {
        this._deliveryFailureNotBeforeMs = nowMs + DELIVERY_RETRY_DELAYS_MS[0];
      }
    }
    this.broadcast();
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
  async persist() { await this.state.storage.put("room", this.room); }
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
        const stored = await this.state.storage.get(["devices", "deliveryAcks", PROFILE_OWNERS_STORAGE_KEY]);
        this.devices = (stored && typeof stored.get === "function" && Array.isArray(stored.get("devices"))) ? stored.get("devices") : [];
        this.deliveryAcks = (stored && typeof stored.get === "function" && Array.isArray(stored.get("deliveryAcks"))) ? stored.get("deliveryAcks") : [];
        this.profileOwners = normalizeProfileOwners(
          stored && typeof stored.get === "function" ? stored.get(PROFILE_OWNERS_STORAGE_KEY) : null
        );
        this._deliveryLoaded = true;
      })();
    }
    try { await this._deliveryLoadPromise; } finally { if (!this._deliveryLoaded) this._deliveryLoadPromise = null; }
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
    if (!pw) return false;
    if (pw === this.env.MASTER) return true;
    return !!this.room.pwHash && (await sha256(pw)) === this.room.pwHash;
  }
  now() { return new Date().toISOString(); }
  nowMs() { return Date.now(); }

  async webSocketMessage(ws, raw) {
    const socketSurface = inspectSocketSurface(deserializeSocketAttachment(ws));
    if (!socketSurface.ok) return sendSurfaceError(ws, socketSurface.error);
    if (socketSurface.needsMigration) {
      try { this.writeSocketAttachment(ws, { surface: RALLY_SURFACE }); }
      catch (error) { return sendSurfaceError(ws, "invalid_surface"); }
    }
    if (socketSurface.surface === DEFENSE_SURFACE) {
      return sendSurfaceError(ws, "defense_not_available");
    }
    await this.ensureRallyLoaded();
    await this.ensureDeliveryLoaded();
    let m; try { m = JSON.parse(raw); } catch (e) { return; }

    if (typeof m.t === "string" && m.t.startsWith("deliveryShadow")) {
      return this.handleDeliveryShadowMessage(ws, m);
    }

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
      if (first) {
        if (!m.password) return ws.send(JSON.stringify({ t: "error", error: "need_password" }));
        this.room.pwHash = await sha256(m.password);
      } else if (!(await this.authOK(m.password))) {
        return ws.send(JSON.stringify({ t: "error", error: "bad_password" }));
      }
      if (m.baseUpdatedAt !== undefined && this.room.updatedAt && m.baseUpdatedAt !== this.room.updatedAt) {
        return ws.send(JSON.stringify({ t: "error", error: "conflict", room: this.snapshot() }));
      }
      this.room.config = sanitizeConfig(m.config);
      this.room.updatedAt = this.now();
      this.room.updatedBy = clampStr(m.by, 24);
      await this.persist(); this.broadcast(); return;
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
        await this.scheduleExpiry();
        this.broadcast();
        try { await this.dispatchDeliveryForCommand(built.command, commandNowMs); } catch (error) {}
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
      await this.persistAll(); await this.scheduleExpiry(); this.broadcast();
      const reliableCommand = type === "double_rally" ? this.room.live.commands[kd] : null;
      if (reliableCommand) {
        try { await this.dispatchDeliveryForCommand(reliableCommand, this.nowMs()); } catch (error) {}
      }
      if (cancelledCommandId) {
        try { await this.cancelDeliveryCommand(cancelledCommandId, this.nowMs()); } catch (error) {}
      }
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
    if (!surface.ok || surface.surface === DEFENSE_SURFACE) {
      try { ws.close(); } catch (error) {}
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
    if (!surface.ok || surface.surface === DEFENSE_SURFACE) return;
    await this.ensureRallyLoaded();
    this.broadcast();
  }
}
