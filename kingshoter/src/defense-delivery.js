import { normalizeRoutingKey } from './room-player.js';
import { normalizeDeviceId } from './room-delivery.js';

const MAX_ACK_RECORDS = 1200;
const ACK_OUTCOMES = new Set([
  'scheduled',
  'audio_unready',
  'clock_stale',
  'schedule_failed',
  'too_late'
]);

function safeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeOrderId(value) {
  const id = String(value == null ? '' : value).trim();
  return id && id.length <= 64 ? id : '';
}

export function normalizeDefenseDevice(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const pid = normalizeRoutingKey(source.pid);
  const deviceId = normalizeDeviceId(source.deviceId);
  const lastSeenMs = safeNonNegativeInteger(source.lastSeenMs);
  if (!pid || !deviceId || typeof source.soundReady !== 'boolean' ||
      typeof source.clockFresh !== 'boolean' || lastSeenMs == null) return null;
  return {
    pid,
    deviceId,
    soundReady: source.soundReady,
    clockFresh: source.clockFresh,
    lastSeenMs
  };
}

function orderAudience(order) {
  const seen = new Set();
  const result = [];
  for (const value of order && Array.isArray(order.audience) ? order.audience : []) {
    const pid = normalizeRoutingKey(value && value.pid);
    const goAtMs = safeNonNegativeInteger(value && value.goAtMs);
    if (!pid || goAtMs == null || seen.has(pid)) continue;
    seen.add(pid);
    result.push({ pid, goAtMs, tooLate: value && value.tooLate === true });
  }
  return result;
}

function normalizeAckRecord(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const orderId = normalizeOrderId(source.orderId);
  const orderRevision = safeNonNegativeInteger(source.orderRevision);
  const pid = normalizeRoutingKey(source.pid);
  const deviceId = normalizeDeviceId(source.deviceId);
  const goAtMs = safeNonNegativeInteger(source.goAtMs);
  const outcome = ACK_OUTCOMES.has(source.outcome) ? source.outcome : '';
  const atMs = safeNonNegativeInteger(source.atMs);
  if (!orderId || orderRevision == null || !pid || !deviceId || goAtMs == null || !outcome ||
      typeof source.audioReady !== 'boolean' || typeof source.clockFresh !== 'boolean' || atMs == null) return null;
  return {
    orderId,
    orderRevision,
    pid,
    deviceId,
    goAtMs,
    outcome,
    audioReady: source.audioReady,
    clockFresh: source.clockFresh,
    atMs
  };
}

function copyAckRecords(value) {
  return (Array.isArray(value) ? value : []).map(normalizeAckRecord).filter(Boolean).slice(-MAX_ACK_RECORDS);
}

function outcomeMatchesTarget(target, outcome, audioReady, clockFresh) {
  if (target.tooLate) return outcome === 'too_late';
  if (outcome === 'too_late') return false;
  if (outcome === 'scheduled') return audioReady && clockFresh;
  if (outcome === 'audio_unready') return !audioReady;
  if (outcome === 'clock_stale') return !clockFresh;
  if (outcome === 'schedule_failed') return audioReady && clockFresh;
  return false;
}

function sameAck(left, right) {
  return left.goAtMs === right.goAtMs &&
    left.outcome === right.outcome &&
    left.audioReady === right.audioReady &&
    left.clockFresh === right.clockFresh;
}

export function recordDefenseAck(order, ackRecords, message, nowMs) {
  const records = copyAckRecords(ackRecords);
  const orderId = normalizeOrderId(message && message.orderId);
  const orderRevision = safeNonNegativeInteger(message && message.orderRevision);
  const pid = normalizeRoutingKey(message && message.pid);
  const deviceId = normalizeDeviceId(message && message.deviceId);
  const goAtMs = safeNonNegativeInteger(message && message.goAtMs);
  const outcome = ACK_OUTCOMES.has(message && message.outcome) ? message.outcome : '';
  const audioReady = message && message.audioReady;
  const clockFresh = message && message.clockFresh;
  const atMs = safeNonNegativeInteger(nowMs);
  const canonicalOrderId = normalizeOrderId(order && order.id);
  const canonicalRevision = safeNonNegativeInteger(order && order.revision);

  if (!canonicalOrderId || orderId !== canonicalOrderId || canonicalRevision == null ||
      orderRevision !== canonicalRevision) {
    return { ok: false, error: 'ack_target_missing', ackRecords: records };
  }
  const target = orderAudience(order).find(profile => profile.pid === pid);
  if (!target) return { ok: false, error: 'ack_target_missing', ackRecords: records };
  if (!deviceId || goAtMs == null || !outcome || typeof audioReady !== 'boolean' ||
      typeof clockFresh !== 'boolean' || atMs == null) {
    return { ok: false, error: 'invalid_ack', ackRecords: records };
  }

  const candidate = {
    orderId,
    orderRevision,
    pid,
    deviceId,
    goAtMs,
    outcome,
    audioReady,
    clockFresh,
    atMs
  };
  const existingIndex = records.findIndex(record =>
    record.orderId === orderId && record.orderRevision === orderRevision &&
    record.pid === pid && record.deviceId === deviceId
  );
  const existing = existingIndex >= 0 ? records[existingIndex] : null;
  if (existing) {
    if (sameAck(existing, candidate)) {
      return { ok: true, changed: false, ackRecords: records, savedAck: existing };
    }
    const retryableFailure = existing.outcome === 'audio_unready' ||
      existing.outcome === 'clock_stale' || existing.outcome === 'schedule_failed';
    if (!retryableFailure || outcome !== 'scheduled' || goAtMs !== target.goAtMs ||
        !outcomeMatchesTarget(target, outcome, audioReady, clockFresh)) {
      return { ok: false, error: 'ack_conflict', ackRecords: records };
    }
    if (atMs >= target.goAtMs) {
      return { ok: false, error: 'ack_window_closed', ackRecords: records };
    }
    records[existingIndex] = candidate;
    return { ok: true, changed: true, ackRecords: records, savedAck: candidate };
  }
  if (goAtMs !== target.goAtMs) return { ok: false, error: 'invalid_ack_target', ackRecords: records };
  if (!outcomeMatchesTarget(target, outcome, audioReady, clockFresh)) {
    return { ok: false, error: 'invalid_ack_outcome', ackRecords: records };
  }
  if (outcome === 'scheduled' && atMs >= target.goAtMs) {
    return { ok: false, error: 'ack_window_closed', ackRecords: records };
  }

  const bounded = records.slice(-(MAX_ACK_RECORDS - 1));
  bounded.push(candidate);
  return { ok: true, changed: true, ackRecords: bounded, savedAck: candidate };
}

function aggregateOutcome(target, records) {
  if (records.some(record => record.outcome === 'scheduled')) return 'scheduled';
  if (target.tooLate) return 'too_late';
  for (const outcome of ['schedule_failed', 'clock_stale', 'audio_unready']) {
    if (records.some(record => record.outcome === outcome)) return outcome;
  }
  return 'unconfirmed';
}

export function aggregateDefenseDelivery(order, ackRecords) {
  const orderId = normalizeOrderId(order && order.id);
  const orderRevision = safeNonNegativeInteger(order && order.revision);
  const audience = orderAudience(order);
  const audienceByPid = new Map(audience.map(target => [target.pid, target]));
  const deduped = new Map();
  for (const raw of Array.isArray(ackRecords) ? ackRecords : []) {
    const record = normalizeAckRecord(raw);
    if (!record || record.orderId !== orderId || record.orderRevision !== orderRevision) continue;
    const target = audienceByPid.get(record.pid);
    if (!target || record.goAtMs !== target.goAtMs ||
        !outcomeMatchesTarget(target, record.outcome, record.audioReady, record.clockFresh)) continue;
    const key = `${record.pid}\u0000${record.deviceId}`;
    if (!deduped.has(key)) deduped.set(key, record);
  }

  const profiles = audience.map(target => {
    const records = Array.from(deduped.values()).filter(record => record.pid === target.pid);
    const scheduled = records.filter(record => record.outcome === 'scheduled');
    return {
      pid: target.pid,
      goAtMs: target.goAtMs,
      tooLate: target.tooLate,
      acknowledgedDevices: records.length,
      scheduledDevices: scheduled.length,
      deliveredScheduled: scheduled.length > 0,
      audioReady: scheduled.some(record => record.audioReady === true),
      outcome: aggregateOutcome(target, records)
    };
  });
  const roster = order && Array.isArray(order.rosterAtAcceptance) ? order.rosterAtAcceptance : [];
  return {
    targetedProfiles: profiles.length,
    deliveredScheduledProfiles: profiles.filter(profile => profile.deliveredScheduled).length,
    audioReadyProfiles: profiles.filter(profile => profile.audioReady).length,
    redUnconfirmedProfiles: profiles.filter(profile => !profile.tooLate && !profile.deliveredScheduled).length,
    offlineRosterProfiles: roster.filter(profile => profile && profile.connectedAtAcceptance !== true).length,
    invalidTimeProfiles: roster.filter(profile => profile && profile.validAtAcceptance !== true).length,
    tooLateProfiles: profiles.filter(profile => profile.tooLate).length,
    profiles
  };
}
