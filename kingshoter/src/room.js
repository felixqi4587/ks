/* Room Durable Object — one per "<kingdom>:<room>".
   Holds the room's live state (config + players + current command) in DO storage,
   fans out the full state snapshot to every connected WebSocket on any change.
   Edits/commands require the room password (sha256) or the MASTER override. */

import {
  activeCommandPids,
  applyPlayerMarchUpdate,
  freezeDoubleRally,
  normalizeMutationId,
  normalizePlayerRecords,
  normalizeRoutingKey,
  registerPlayer,
  removePlayerAtomic
} from "./room-player.js";
import {
  bindCoreSocketIdentity,
  coreAttachmentMatchesAck,
  deliveryAckError,
  normalizeCoreSocketAttachment,
  normalizeDeviceId,
  pruneDevices,
  recordCommandAck,
  registryMatchesAck,
  removePlayerDelivery,
  startCommandDelivery,
  touchDevice
} from "./room-delivery.js";
import {
  DELIVERY_ACK_WINDOW_MS,
  DELIVERY_ARMED_LEASE_MS,
  DELIVERY_PROBE_INTERVAL_MS,
  DELIVERY_STORAGE_KEY,
  DELIVERY_VERSION,
  defaultDeliveryState,
  isQaRoomName,
  normalizeDeliveryAttachment,
  normalizeDeliveryState,
  publicDeliverySummary
} from "./delivery.js";

function defaultRoom() {
  return {
    pwHash: null,
    config: { castleName: "", rallyAllies: [], enemyWhales: [] },
    players: {},
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

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.room = null;
    this.roomName = String(state && state.id && state.id.name || "").slice(0, 48);
    this.delivery = defaultDeliveryState(this.roomName);
    this.devices = [];
    this.deliveryAcks = [];
    this._deliveryLoaded = false;
    this._deliveryLoadPromise = null;
    state.blockConcurrencyWhile(async () => {
      this.room = (await state.storage.get("room")) || defaultRoom();
      this.room.players = normalizePlayerRecords(this.room.players);
      this.normalizeLive();
      delete this.room.delivery;
      delete this.room.deliveryShadow;
      let storedDelivery = null;
      try { storedDelivery = await state.storage.get(DELIVERY_STORAGE_KEY); } catch (error) {}
      this.delivery = normalizeDeliveryState(storedDelivery || this.delivery, this.nowMs());
    });
  }

  // migrate older single-slot live state to the per-kingdom shape
  normalizeLive() {
    const l = this.room.live = this.room.live || {};
    if (!l.commands || typeof l.commands !== "object") l.commands = { 1: l.command || null, 2: null };
    if (!l.staged || typeof l.staged !== "object" || "pairs" in l.staged || !("1" in l.staged)) l.staged = { 1: null, 2: null };
    delete l.command;
    l.mode = l.mode || "idle";
    if (!("sim" in l)) l.sim = null;
  }

  async fetch(request) {
    await this.ensureDeliveryLoaded();
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const requestedRoom = String(new URL(request.url).searchParams.get("room") || this.roomName || "").slice(0, 48);
      if (!this.roomName) this.roomName = requestedRoom;
      this.attachSocket(server, requestedRoom);      // Hibernation API + merge-safe identity base
      this.initializeReliableAttachment(server);
      server.send(this.stateMsg());
      return new Response(null, { status: 101, webSocket: client });
    }
    // plain GET → public read-only snapshot (handy for debugging / SSR)
    return Response.json(JSON.parse(this.stateMsg()));
  }

  snapshot() {
    const r = { ...this.room, presence: this.state.getWebSockets().length };
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
  async scheduleExpiry() {
    const exps = [1, 2].map(k => this.room.live.commands[k]).filter(c => c && c.expiresUTC).map(c => c.expiresUTC);
    if (exps.length) await this.state.storage.setAlarm(Math.min(...exps) * 1000 + 600);
    else await this.state.storage.deleteAlarm();   // clear the alarm when idle so a cancel doesn't leave a spurious wake armed
  }
  async alarm() {
    this.normalizeLive();
    const nowS = Math.floor(Date.now() / 1000);
    let changed = false;
    for (const k of [1, 2]) { const c = this.room.live.commands[k]; if (c && c.expiresUTC && nowS >= c.expiresUTC) { this.room.live.commands[k] = null; changed = true; } }
    if (changed) { this.room.live.mode = this.room.live.sim ? "sim" : ((this.room.live.commands[1] || this.room.live.commands[2]) ? "live" : "idle"); await this.persist(); }
    this.broadcast();
    await this.scheduleExpiry();
  }
  stateMsg() {
    return JSON.stringify({ t: "state", room: this.snapshot() });
  }
  broadcast() {
    const msg = this.stateMsg();
    for (const ws of this.state.getWebSockets()) { try { ws.send(msg); } catch (e) {} }
  }
  async persist() { await this.state.storage.put("room", this.room); }
  async persistAll() {
    await this.state.storage.put({ room: this.room, devices: this.devices, deliveryAcks: this.deliveryAcks });
  }
  async ensureDeliveryLoaded() {
    if (this._deliveryLoaded) return;
    if (!this.state || !this.state.storage) { this._deliveryLoaded = true; return; }
    if (!this._deliveryLoadPromise) {
      this._deliveryLoadPromise = (async () => {
        const stored = await this.state.storage.get(["devices", "deliveryAcks"]);
        this.devices = (stored && typeof stored.get === "function" && Array.isArray(stored.get("devices"))) ? stored.get("devices") : [];
        this.deliveryAcks = (stored && typeof stored.get === "function" && Array.isArray(stored.get("deliveryAcks"))) ? stored.get("deliveryAcks") : [];
        this._deliveryLoaded = true;
      })();
    }
    try { await this._deliveryLoadPromise; } finally { if (!this._deliveryLoaded) this._deliveryLoadPromise = null; }
  }
  attachSocket(server, roomName) {
    this.state.acceptWebSocket(server);
    this.writeSocketAttachment(server, { roomName, pid: "", deviceId: "", soundReady: false });
  }
  readSocketAttachment(ws) {
    let raw = null;
    try { raw = ws.deserializeAttachment(); } catch (error) {}
    const source = raw && typeof raw === "object" ? raw : {};
    return { ...source, ...normalizeCoreSocketAttachment(source, source.roomName || this.roomName) };
  }
  writeSocketAttachment(ws, patch) {
    const current = this.readSocketAttachment(ws);
    const merged = { ...current, ...(patch && typeof patch === "object" ? patch : {}) };
    if (current.pid || current.deviceId) {
      merged.pid = current.pid;
      merged.deviceId = current.deviceId;
    }
    const next = { ...merged, ...normalizeCoreSocketAttachment(merged, merged.roomName || this.roomName) };
    ws.serializeAttachment(next);
    return next;
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
      this.writeReliableAttachment(ws, {
        audioArmed,
        armedUntilMs: audioArmed ? nowMs + DELIVERY_ARMED_LEASE_MS : 0,
        lastProbeId: "",
        probeExpiresAtMs: 0
      });
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
    const result = bindCoreSocketIdentity(this.readSocketAttachment(ws), this.devices, message, this.nowMs());
    if (!result.ok) return result;
    this.writeSocketAttachment(ws, result.attachment);
    const attachment = this.readSocketAttachment(ws);
    const siblingReady = this.state.getWebSockets().some(socket => {
      const candidate = socket === ws ? attachment : this.readSocketAttachment(socket);
      return candidate.pid === attachment.pid && candidate.deviceId === attachment.deviceId && candidate.soundReady === true;
    });
    this.devices = touchDevice(result.devices, { ...attachment, soundReady: siblingReady }, this.nowMs());
    return { ok: true };
  }
  async releaseSocketDevice(ws) {
    const attachment = this.readSocketAttachment(ws);
    if (!attachment.pid || !attachment.deviceId) return;
    const before = this.devices;
    const siblings = this.state.getWebSockets().filter(socket => socket !== ws).map(socket => this.readSocketAttachment(socket))
      .filter(candidate => candidate.pid === attachment.pid && candidate.deviceId === attachment.deviceId);
    if (siblings.length) {
      this.devices = touchDevice(this.devices, {
        ...attachment,
        soundReady: siblings.some(candidate => candidate.soundReady === true)
      }, this.nowMs());
    } else {
      this.devices = pruneDevices(this.devices, this.nowMs()).filter(device =>
        !(normalizeDeviceId(device.deviceId) === attachment.deviceId && normalizeRoutingKey(device.pid) === attachment.pid)
      );
    }
    try { await this.persistAll(); } catch (error) { this.devices = before; }
  }
  async authOK(pw) {
    if (!pw) return false;
    if (pw === this.env.MASTER) return true;
    return !!this.room.pwHash && (await sha256(pw)) === this.room.pwHash;
  }
  now() { return new Date().toISOString(); }
  nowMs() { return Date.now(); }

  async webSocketMessage(ws, raw) {
    await this.ensureDeliveryLoaded();
    let m; try { m = JSON.parse(raw); } catch (e) { return; }

    if (typeof m.t === "string" && m.t.startsWith("deliveryShadow")) {
      return this.handleDeliveryShadowMessage(ws, m);
    }

    if (m.t === "deviceStatus") {
      const observation = this.observeDevice(ws, m);
      if (!observation.ok) return ws.send(JSON.stringify({ t: "error", source: "deviceStatus", error: observation.error }));
      this.room.players[normalizeRoutingKey(m.pid)].lastSeen = this.now();
      await this.persistAll();
      const attachment = this.readSocketAttachment(ws);
      ws.send(JSON.stringify({
        t: "deviceStatusSaved", pid: attachment.pid, deviceId: attachment.deviceId, soundReady: attachment.soundReady
      }));
      this.broadcast(); return;
    }

    if (m.t === "deliveryAck") {
      const attachment = this.readSocketAttachment(ws);
      if (!coreAttachmentMatchesAck(attachment, m) || !registryMatchesAck(this.devices, attachment, this.nowMs())) {
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
      const { atMs, ...savedAck } = result.savedAck;
      try { ws.send(JSON.stringify({ t: "deliveryAckSaved", ...savedAck })); } catch (error) {}
      return;
    }

    if (m.t === "setMarch" || m.t === "registerPlayer") {
      const pid = normalizeRoutingKey(m.pid);
      if (pid && Object.prototype.hasOwnProperty.call(this.room.players, pid)) return;
      const result = registerPlayer(this.room.players, m, this.now());
      if (!result.ok) return ws.send(JSON.stringify(Object.assign({ t: "error" }, result)));
      // cap roster so a long-running room can't grow unbounded over a season — evict oldest lastSeen, but NEVER an active/staged captain
      const total = Object.keys(this.room.players).length;
      let privateDeliveryChanged = false;
      if (total > 150) {
        const protect = activeCommandPids(this.room.live, Math.floor(this.nowMs() / 1000));
        for (const k of [1, 2]) {
          const staged = this.room.live.staged[k];
          if (staged && Array.isArray(staged.pairs)) staged.pairs.forEach(pair => protect.add(pair && pair.pid));
        }
        const evicted = Object.keys(this.room.players).filter(k => !protect.has(k))
          .sort((a, b) => (this.room.players[a].lastSeen || "") < (this.room.players[b].lastSeen || "") ? -1 : 1)
          .slice(0, total - 150);
        evicted.forEach(k => {
          delete this.room.players[k];
          const privateState = removePlayerDelivery(this.devices, this.deliveryAcks, k);
          if (privateState.devices.length !== this.devices.length || privateState.ackRecords.length !== this.deliveryAcks.length) privateDeliveryChanged = true;
          this.devices = privateState.devices; this.deliveryAcks = privateState.ackRecords;
        });
      }
      if (privateDeliveryChanged) await this.persistAll(); else await this.persist();
      this.broadcast(); return;
    }

    if (m.t === "updateOwnMarch") {
      const result = applyPlayerMarchUpdate(this.room.players, m, { touchLastSeen: true, nowISO: this.now() });
      if (!result.ok) return ws.send(JSON.stringify(Object.assign({ t: "error" }, result)));
      await this.persist();
      ws.send(JSON.stringify({
        t: "playerMarchSaved", mutationId: result.mutationId, pid: result.pid, march: result.march, revision: result.revision
      }));
      this.broadcast(); return;
    }

    if (m.t === "setPlayerMarch") {
      const mutationId = normalizeMutationId(m.mutationId);
      if (!(await this.authOK(m.password))) return ws.send(JSON.stringify({ t: "error", error: "bad_password", mutationId }));
      const result = applyPlayerMarchUpdate(this.room.players, m);
      if (!result.ok) return ws.send(JSON.stringify(Object.assign({ t: "error" }, result)));
      await this.persist();
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
      const result = removePlayerAtomic(this.room, m.pid, Math.floor(this.nowMs() / 1000));
      if (!result.ok) {
        if (result.error === "player_missing") return;   // idempotent cleanup: another commander may have removed it already
        return ws.send(JSON.stringify({ t: "error", error: result.error, pid: result.pid }));
      }
      const privateState = removePlayerDelivery(this.devices, this.deliveryAcks, result.pid);
      this.devices = privateState.devices; this.deliveryAcks = privateState.ackRecords;
      await this.persistAll(); this.broadcast(); return;
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
      const type = ["double_rally", "refill", "cancel", "ping"].includes(c.type) ? c.type : "refill";
      const kd = clampInt(c.kingdom != null ? c.kingdom : (c.payload && c.payload.kingdom), 1, 2);
      // a refill must NOT silently clobber an in-flight double_rally players are already counting down to
      if (type === "refill") { const ex = this.room.live.commands[kd]; if (ex && ex.type === "double_rally" && Number(ex.expiresUTC) > Math.floor(this.nowMs() / 1000)) return ws.send(JSON.stringify({ t: "error", error: "rally_live" })); }
      if (type === "cancel") {
        this.room.live.commands[kd] = null;
      } else {
        let payload = (c.payload && typeof c.payload === "object") ? c.payload : {};
        if (type === "double_rally") {
          const frozen = freezeDoubleRally(this.room.players, payload.pairs, payload.firstPress != null ? payload.firstPress : c.anchorUTC);
          if (!frozen.ok) return ws.send(JSON.stringify({ t: "error", error: frozen.error }));
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
        command.delivery = startCommandDelivery(command, this.devices, this.nowMs());
        this.room.live.commands[kd] = command;
      }
      this.room.live.staged[kd] = null;   // a real order supersedes that kingdom's staged pre-warning
      this.room.live.mode = (this.room.live.commands[1] || this.room.live.commands[2]) ? "live" : "idle";
      await this.persistAll(); await this.scheduleExpiry(); this.broadcast(); return;
    }

    if (m.t === "stage") {   // commander pre-warns the picked captains (before the actual fire) so a whale who stepped away can stand by
      if (!(await this.authOK(m.password))) return ws.send(JSON.stringify({ t: "error", error: "bad_password" }));
      const s = m.staged || {};
      const kd = clampInt(s.kingdom, 1, 2);
      const liveCommand = this.room.live.commands[kd];
      if (liveCommand && Number(liveCommand.expiresUTC) > Math.floor(this.nowMs() / 1000)) {
        return ws.send(JSON.stringify({ t: "stageSuperseded", kingdom: kd, commandId: liveCommand.id }));
      }
      const pairs = (Array.isArray(s.pairs) ? s.pairs : []).slice(0, 2).map(p => ({ pid: clampStr(p && p.pid, 24), role: (p && p.role) === "main" ? "main" : "weak" }));
      if (pairs.some(p => !p.pid || !Object.prototype.hasOwnProperty.call(this.room.players, p.pid))) return ws.send(JSON.stringify({ t: "error", error: "player_missing" }));
      const otherKingdom = kd === 1 ? 2 : 1;
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
        if (m.deviceId != null || typeof m.soundReady === "boolean") {
          const observation = this.observeDevice(ws, m);
          if (!observation.ok) return ws.send(JSON.stringify({ t: "error", error: observation.error }));
        }
        this.room.players[pid].lastSeen = this.now();
        // fan the freshness out (and PERSIST it) at most once per 20s per room — otherwise the commander's
        // sync pill decays to 0/2 between mutations, and a hibernating DO would reload stale lastSeen from
        // storage and mark everyone absent even though they're all connected
        const t = Date.now();
        if (!this._lastHbCast || t - this._lastHbCast > 20000) { this._lastHbCast = t; await this.persistAll(); this.broadcast(); }
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

  async webSocketClose(ws) { await this.ensureDeliveryLoaded(); await this.releaseSocketDevice(ws); try { ws.close(); } catch (e) {} this.broadcast(); }
  async webSocketError(ws) { this.broadcast(); }
}
