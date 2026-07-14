export const DELIVERY_VERSION = 1;
export const DELIVERY_STORAGE_KEY = 'delivery:v1';
export const DELIVERY_PROBE_INTERVAL_MS = 3_000;
export const DELIVERY_ARMED_LEASE_MS = 8_000;
export const DELIVERY_RETRY_DELAYS_MS = Object.freeze([500, 1_500]);
export const DELIVERY_ACK_WINDOW_MS = 2_000;
export const DELIVERY_RETRY_CUTOFF_MS = 500;
export const DELIVERY_AUDIO_GRACE_MS = 150;
export const DELIVERY_HISTORY_TTL_MS = 60_000;
export const DELIVERY_MAX_COMMANDS = 32;

const QA_ROOM_RE = /^qa-kvk-[a-z0-9](?:[a-z0-9-]{0,39}[a-z0-9])?$/;
const RESULTS = new Set(['scheduled', 'would_schedule', 'audio_unarmed', 'expired', 'duplicate']);
const SHADOW_RESULTS = new Set(['would_schedule', 'audio_unarmed', 'expired', 'duplicate']);
const DELIVERY_MAX_TARGETS = 24;

const text = (value, max) => String(value == null ? '' : value).slice(0, max);
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const int = (value, fallback) => Math.trunc(finite(value, fallback));
const role = (value) => value === 'main' ? 'main' : 'weak';

export function isQaRoomName(room) {
  return typeof room === 'string' && room.length <= 48 && QA_ROOM_RE.test(room);
}

export function defaultDeliveryState(roomName = '') {
  return { v: DELIVERY_VERSION, roomName: isQaRoomName(roomName) ? roomName : '', commands: [] };
}

export function normalizeDeliveryAttachment(raw, roomName) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const normalizedRoom = text(roomName || raw.roomName, 48);
  return {
    v: DELIVERY_VERSION,
    roomName: normalizedRoom,
    qa: isQaRoomName(normalizedRoom),
    pid: text(raw.pid, 24),
    deviceId: text(raw.deviceId, 64),
    soundReady: raw.soundReady === true,
    view: raw.view === 'commander' ? 'commander' : 'player',
    shadow: raw.shadow === true,
    audioArmed: raw.audioArmed === true,
    armedUntilMs: Math.max(0, int(raw.armedUntilMs, 0)),
    lastProbeId: text(raw.lastProbeId, 64),
    probeExpiresAtMs: Math.max(0, int(raw.probeExpiresAtMs, 0)),
    nextProbeAtMs: Math.max(0, int(raw.nextProbeAtMs, 0))
  };
}

function normalizeAck(raw) {
  if (!raw || typeof raw !== 'object' || !RESULTS.has(raw.result)) return null;
  return {
    result: raw.result,
    futureCueCount: Math.max(0, Math.min(12, int(raw.futureCueCount, 0))),
    atMs: Math.max(0, int(raw.atMs, 0))
  };
}

function normalizeAudience(raw) {
  const pid = text(raw && raw.pid, 24);
  const fireAtMs = Math.max(0, int(raw && raw.fireAtMs, 0));
  if (!pid || !fireAtMs) return null;
  return {
    pid,
    role: role(raw.role),
    fireAtMs,
    audioExpiresAtMs: Math.max(fireAtMs, int(raw.audioExpiresAtMs, fireAtMs + DELIVERY_AUDIO_GRACE_MS)),
    marchSeconds: Math.max(0, int(raw.marchSeconds, 0)),
    leadSeconds: Math.max(1, Math.min(120, int(raw.leadSeconds, 10)))
  };
}

function normalizeTarget(raw, record) {
  const pid = text(raw && raw.pid, 24);
  const deviceId = text(raw && raw.deviceId, 64);
  const audience = record.audiences.find((item) => item.pid === pid);
  if (!pid || !deviceId || !audience) return null;
  const envelope = Object.freeze({
    t: 'deliveryShadowCommand', v: DELIVERY_VERSION, shadow: true,
    commandId: record.commandId, pid, role: audience.role, kingdom: record.kingdom,
    issuedAtMs: record.issuedAtMs, fireAtMs: audience.fireAtMs,
    audioExpiresAtMs: audience.audioExpiresAtMs,
    marchSeconds: audience.marchSeconds, leadSeconds: audience.leadSeconds
  });
  return {
    pid,
    deviceId,
    envelope,
    attempts: Math.max(0, Math.min(16, int(raw.attempts, 0))),
    nextRetryAtMs: Math.max(0, int(raw.nextRetryAtMs, record.issuedAtMs)),
    classicAck: normalizeAck(raw.classicAck),
    candidateAck: normalizeAck(raw.candidateAck)
  };
}

function normalizeRecord(raw) {
  const commandId = text(raw && raw.commandId, 64);
  const issuedAtMs = Math.max(0, int(raw && raw.issuedAtMs, 0));
  if (!commandId || !issuedAtMs) return null;
  const record = {
    commandId,
    kingdom: raw.kingdom === 2 ? 2 : 1,
    issuedAtMs,
    cancelledAtMs: raw.cancelledAtMs == null ? null : Math.max(0, int(raw.cancelledAtMs, 0)),
    audiences: (Array.isArray(raw.audiences) ? raw.audiences : []).map(normalizeAudience).filter(Boolean).slice(0, 3),
    targets: []
  };
  record.targets = (Array.isArray(raw.targets) ? raw.targets : [])
    .map((target) => normalizeTarget(target, record)).filter(Boolean).slice(0, DELIVERY_MAX_TARGETS);
  return record.audiences.length ? record : null;
}

export function normalizeDeliveryState(raw, nowMs = Date.now()) {
  const source = raw && typeof raw === 'object' && raw.v === DELIVERY_VERSION ? raw : {};
  const state = defaultDeliveryState(source.roomName);
  state.commands = (Array.isArray(source.commands) ? source.commands : [])
    .map(normalizeRecord).filter(Boolean);
  pruneDeliveryState(state, nowMs);
  return state;
}

export function createDeliveryRecord(command, nowMs) {
  if (!command || command.type !== 'double_rally' || !text(command.id, 64)) return null;
  const payload = command.payload && typeof command.payload === 'object' ? command.payload : {};
  const leadSeconds = Math.max(1, Math.min(120, int(payload.leadSeconds, 10)));
  const audiences = (Array.isArray(payload.pairs) ? payload.pairs : []).slice(0, 2).map((pair) => {
    const fireAtMs = Math.round(finite(pair && pair.pressUTC, 0) * 1000);
    return normalizeAudience({
      pid: pair && pair.pid,
      role: pair && pair.role,
      fireAtMs,
      audioExpiresAtMs: fireAtMs + DELIVERY_AUDIO_GRACE_MS,
      marchSeconds: pair && pair.march,
      leadSeconds
    });
  }).filter(Boolean);
  if (audiences.length !== 2 || audiences[0].pid === audiences[1].pid) return null;
  return {
    commandId: text(command.id, 64),
    kingdom: command.kingdom === 2 ? 2 : 1,
    issuedAtMs: Math.max(0, int(nowMs, Date.now())),
    cancelledAtMs: null,
    audiences,
    targets: []
  };
}

export function upsertDeliveryTarget(state, commandId, attachment, nowMs) {
  const record = state.commands.find((item) => item.commandId === text(commandId, 64));
  const a = normalizeDeliveryAttachment(attachment, attachment && attachment.roomName);
  const audience = record && record.audiences.find((item) => item.pid === a.pid);
  if (!record || record.cancelledAtMs != null || !a.qa || !a.shadow || !a.soundReady ||
      !a.audioArmed || a.armedUntilMs <= nowMs || !a.deviceId || !audience) return null;
  if (nowMs >= audience.audioExpiresAtMs) return null;
  let target = record.targets.find((item) => item.pid === a.pid && item.deviceId === a.deviceId);
  if (target) {
    if (!target.candidateAck && nowMs < audience.fireAtMs - DELIVERY_RETRY_CUTOFF_MS) target.nextRetryAtMs = nowMs;
    return target;
  }
  if (record.targets.length >= DELIVERY_MAX_TARGETS) return null;
  target = normalizeTarget({
    pid: a.pid, deviceId: a.deviceId, attempts: 0,
    nextRetryAtMs: nowMs, classicAck: null, candidateAck: null
  }, record);
  record.targets.push(target);
  return target;
}

export function dueDeliveryTargets(state, nowMs) {
  const due = [];
  for (const record of state.commands) {
    if (record.cancelledAtMs != null) continue;
    for (const target of record.targets) {
      if (target.candidateAck || !target.nextRetryAtMs || target.nextRetryAtMs > nowMs) continue;
      if (nowMs >= target.envelope.fireAtMs - DELIVERY_RETRY_CUTOFF_MS) continue;
      due.push({
        commandId: record.commandId,
        pid: target.pid,
        deviceId: target.deviceId,
        envelope: target.envelope
      });
    }
  }
  return due;
}

function findTarget(state, input) {
  const record = state.commands.find((item) => item.commandId === text(input.commandId, 64));
  const target = record && record.targets.find((item) =>
    item.pid === text(input.pid, 24) && item.deviceId === text(input.deviceId, 64));
  return { record, target };
}

export function recordDeliveryAttempt(state, action, nowMs) {
  const { record, target } = findTarget(state, action);
  if (!record || !target || target.candidateAck || record.cancelledAtMs != null) return false;
  target.attempts = Math.min(16, target.attempts + 1);
  target.nextRetryAtMs = DELIVERY_RETRY_DELAYS_MS
    .map((delay) => record.issuedAtMs + delay)
    .find((atMs) => atMs > nowMs) || 0;
  return true;
}

export function recordClassicAck(state, attachment, message, nowMs) {
  const a = normalizeDeliveryAttachment(attachment, attachment && attachment.roomName);
  if (!a.qa || !a.shadow || !message || !['scheduled', 'expired'].includes(message.outcome)) return false;
  if (text(message.pid, 24) !== a.pid || text(message.deviceId, 64) !== a.deviceId) return false;
  const { target } = findTarget(state, {
    commandId: message.commandId, pid: a.pid, deviceId: a.deviceId
  });
  if (!target || target.classicAck) return false;
  target.classicAck = {
    result: message.outcome,
    futureCueCount: message.outcome === 'scheduled' ? 1 : 0,
    atMs: Math.max(0, int(nowMs, Date.now()))
  };
  return true;
}

export function recordShadowAck(state, attachment, message, nowMs) {
  const a = normalizeDeliveryAttachment(attachment, attachment && attachment.roomName);
  if (!a.qa || !a.shadow || !message || message.v !== DELIVERY_VERSION || !SHADOW_RESULTS.has(message.result)) return false;
  const { target } = findTarget(state, {
    commandId: message.commandId, pid: a.pid, deviceId: a.deviceId
  });
  if (!target || target.candidateAck) return false;
  const futureCueCount = Math.max(0, Math.min(12, int(message.futureCueCount, 0)));
  target.candidateAck = {
    result: message.result,
    futureCueCount,
    atMs: Math.max(0, int(nowMs, Date.now()))
  };
  target.nextRetryAtMs = 0;
  return true;
}

export function cancelDeliveryRecord(state, commandId, nowMs) {
  const record = state.commands.find((item) => item.commandId === text(commandId, 64));
  if (!record || record.cancelledAtMs != null) return false;
  record.cancelledAtMs = Math.max(0, int(nowMs, Date.now()));
  for (const target of record.targets) target.nextRetryAtMs = 0;
  return true;
}

export function publicDeliverySummary(state, nowMs) {
  const commands = state.commands.slice(-4).map((record) => ({
    commandId: record.commandId,
    expectedDevices: record.targets.length,
    classicScheduled: record.targets.filter((target) =>
      target.classicAck && target.classicAck.result === 'scheduled').length,
    candidateAcked: record.targets.filter((target) =>
      target.candidateAck && (
        target.candidateAck.result === 'would_schedule' ||
        (target.candidateAck.result === 'duplicate' && target.candidateAck.futureCueCount > 0)
      )).length,
    expired: record.targets.filter((target) =>
      (target.candidateAck && target.candidateAck.result === 'expired') ||
      (!target.candidateAck && nowMs > target.envelope.audioExpiresAtMs)).length,
    cancelled: record.cancelledAtMs != null
  }));
  return { v: DELIVERY_VERSION, commands };
}

function deliveryRecordFinalAt(record) {
  if (record.cancelledAtMs != null) return record.cancelledAtMs;
  return Math.max(
    0,
    ...record.audiences.map((audience) => audience.audioExpiresAtMs),
    ...record.targets.flatMap((target) => [
      target.classicAck ? target.classicAck.atMs : 0,
      target.candidateAck ? target.candidateAck.atMs : 0
    ])
  );
}

export function nextDeliveryWakeAt(state, nowMs) {
  let next = null;
  for (const record of state.commands) {
    if (record.cancelledAtMs == null) {
      for (const target of record.targets) {
        const at = target.candidateAck ? 0 : target.nextRetryAtMs;
        if (at && nowMs < target.envelope.fireAtMs - DELIVERY_RETRY_CUTOFF_MS) {
          next = next == null ? at : Math.min(next, at);
        }
      }
    }
    const pruneAtMs = deliveryRecordFinalAt(record) + DELIVERY_HISTORY_TTL_MS;
    if (pruneAtMs > 0) next = next == null ? Math.max(nowMs, pruneAtMs) : Math.min(next, Math.max(nowMs, pruneAtMs));
  }
  return next;
}

export function pruneDeliveryState(state, nowMs) {
  const before = state.commands.length;
  state.commands = state.commands.filter((record) => {
    return nowMs <= deliveryRecordFinalAt(record) + DELIVERY_HISTORY_TTL_MS;
  }).slice(-DELIVERY_MAX_COMMANDS);
  return state.commands.length !== before;
}
