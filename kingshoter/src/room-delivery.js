import { normalizeRoutingKey, rallyTargetPids } from './room-player.js';

export const DEVICE_TTL_MS = 70_000;

export function normalizeDeviceId(value) {
  const id = String(value == null ? '' : value).trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ? id : '';
}

export function deliveryAckError(message, error) {
  return {
    t: 'error',
    source: 'deliveryAck',
    error: String(error || 'invalid_ack'),
    commandId: String(message && message.commandId || ''),
    pid: normalizeRoutingKey(message && message.pid),
    deviceId: normalizeDeviceId(message && message.deviceId)
  };
}

export function normalizeCoreSocketAttachment(raw, roomName) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    roomName: String(value.roomName || roomName || '').slice(0, 48),
    pid: normalizeRoutingKey(value.pid),
    deviceId: normalizeDeviceId(value.deviceId),
    soundReady: value.soundReady === true
  };
}

export function coreAttachmentMatchesAck(attachment, message) {
  const current = normalizeCoreSocketAttachment(attachment, attachment && attachment.roomName);
  return current.soundReady === true &&
    current.pid === normalizeRoutingKey(message && message.pid) &&
    current.deviceId === normalizeDeviceId(message && message.deviceId);
}

export function registryMatchesAck(devices, attachment, nowMs) {
  const current = normalizeCoreSocketAttachment(attachment, attachment && attachment.roomName);
  if (!current.pid || !current.deviceId || !current.soundReady) return false;
  return pruneDevices(devices, nowMs).some(device =>
    normalizeRoutingKey(device && device.pid) === current.pid &&
    normalizeDeviceId(device && device.deviceId) === current.deviceId &&
    device && device.soundReady === true
  );
}

export function bindCoreSocketIdentity(attachment, devices, observation, nowMs) {
  const source = attachment && typeof attachment === 'object' ? attachment : {};
  const current = { ...source, ...normalizeCoreSocketAttachment(source, source.roomName) };
  const pid = normalizeRoutingKey(observation && observation.pid);
  const deviceId = normalizeDeviceId(observation && observation.deviceId);
  if (!pid || !deviceId || typeof (observation && observation.soundReady) !== 'boolean') {
    return { ok: false, error: 'invalid_device_identity' };
  }
  if ((current.pid || current.deviceId) && (current.pid !== pid || current.deviceId !== deviceId)) {
    return { ok: false, error: 'socket_identity_locked' };
  }
  const fresh = pruneDevices(devices, nowMs);
  if (deviceBindingConflicts(fresh, pid, deviceId, nowMs)) {
    return { ok: false, error: 'device_owned_by_other_pid' };
  }
  const nextAttachment = { ...current, pid, deviceId, soundReady: observation.soundReady === true };
  return {
    ok: true,
    attachment: nextAttachment,
    devices: touchDevice(fresh, nextAttachment, nowMs)
  };
}

export function pruneDevices(devices, nowMs) {
  const now = Number(nowMs);
  return (Array.isArray(devices) ? devices : []).filter(device => {
    const lastSeenMs = Number(device && device.lastSeenMs);
    return normalizeRoutingKey(device && device.pid) &&
      normalizeDeviceId(device && device.deviceId) &&
      Number.isFinite(now) && Number.isFinite(lastSeenMs) && now - lastSeenMs < DEVICE_TTL_MS;
  }).slice(-600);
}

export function deviceBindingConflicts(devices, pidValue, deviceIdValue, nowMs) {
  const pid = normalizeRoutingKey(pidValue);
  const deviceId = normalizeDeviceId(deviceIdValue);
  if (!pid || !deviceId) return false;
  return pruneDevices(devices, nowMs).some(device =>
    normalizeDeviceId(device.deviceId) === deviceId && normalizeRoutingKey(device.pid) !== pid
  );
}

export function touchDevice(devices, observation, nowMs) {
  const pid = normalizeRoutingKey(observation && observation.pid);
  const deviceId = normalizeDeviceId(observation && observation.deviceId);
  const fresh = pruneDevices(devices, nowMs);
  // A fresh room-local device identity is immutable across players. Rejecting
  // the conflicting observation keeps a second socket from stealing an armed
  // captain's delivery identity.
  if (deviceBindingConflicts(fresh, pid, deviceId, nowMs)) return fresh;
  const next = fresh.filter(device => normalizeDeviceId(device.deviceId) !== deviceId);
  if (pid && deviceId) {
    next.push({ pid, deviceId, soundReady: observation && observation.soundReady === true, lastSeenMs: Number(nowMs) });
  }
  return next.slice(-600);
}

export function projectLiveCoreDevices(socketAttachments, nowMs) {
  const projected = new Map();
  for (const raw of Array.isArray(socketAttachments) ? socketAttachments : []) {
    const attachment = normalizeCoreSocketAttachment(raw, raw && raw.roomName);
    if (!attachment.pid || !attachment.deviceId) continue;
    const observedAtMs = Number(raw && raw.lastSeenMs);
    const lastSeenMs = Number.isFinite(observedAtMs) ? observedAtMs : Number(nowMs);
    if (!Number.isFinite(lastSeenMs) || Number(nowMs) - lastSeenMs >= DEVICE_TTL_MS) continue;
    const current = projected.get(attachment.deviceId);
    if (current && current.pid === attachment.pid) {
      current.soundReady = current.soundReady || attachment.soundReady;
      continue;
    }
    // A later live binding wins only after the canonical TTL/conflict gate has
    // allowed it. This keeps an older hibernating socket from shadowing a
    // legitimate rebind while still deduplicating sibling tabs by device.
    projected.set(attachment.deviceId, {
      pid: attachment.pid,
      deviceId: attachment.deviceId,
      soundReady: attachment.soundReady === true,
      lastSeenMs
    });
  }
  return Array.from(projected.values()).slice(-600);
}

export function startCommandDelivery(command, devices, nowMs) {
  const fresh = pruneDevices(devices, nowMs);
  return rallyTargetPids(command).map(pid => ({
    pid,
    expected: new Set(fresh.filter(device => device.pid === pid && device.soundReady).map(device => device.deviceId)).size,
    received: 0,
    expired: 0
  }));
}

export function recordCommandAck(command, ackRecords, message, nowMs) {
  const commandId = String(message && message.commandId || '');
  const pid = normalizeRoutingKey(message && message.pid);
  const deviceId = normalizeDeviceId(message && message.deviceId);
  const outcome = message && message.outcome === 'expired'
    ? 'expired'
    : message && message.outcome === 'scheduled' ? 'scheduled' : '';
  const targetUTC = Number(message && message.targetUTC);
  const scheduledAtMs = Number(message && message.scheduledAtMs);
  if (!command || command.id !== commandId || !rallyTargetPids(command).includes(pid)) {
    return { ok: false, error: 'ack_target_missing', ackRecords };
  }
  if (!deviceId || !outcome || !Number.isFinite(targetUTC) || !Number.isFinite(scheduledAtMs)) {
    return { ok: false, error: 'invalid_ack', ackRecords };
  }
  const records = (Array.isArray(ackRecords) ? ackRecords : [])
    .filter(record => Number(nowMs) - Number(record && record.atMs) < 3_600_000)
    .slice(-1199);
  const existing = records.find(record => record.commandId === commandId && record.pid === pid && normalizeDeviceId(record.deviceId) === deviceId);
  if (existing) {
    if (existing.outcome !== outcome || Math.abs(Number(existing.targetUTC) - targetUTC) > 0.001 ||
        Number(existing.scheduledAtMs) !== scheduledAtMs) {
      return { ok: false, error: 'ack_conflict', ackRecords: records };
    }
    return { ok: true, changed: false, ackRecords: records, savedAck: existing };
  }
  const pairs = command.payload && Array.isArray(command.payload.pairs) ? command.payload.pairs : [];
  const pair = pairs.find(value => normalizeRoutingKey(value && value.pid) === pid);
  if (!pair || Math.abs(Number(pair.pressUTC) - targetUTC) > 0.001) {
    return { ok: false, error: 'invalid_ack_target', ackRecords };
  }
  const savedAck = { commandId, pid, deviceId, outcome, targetUTC, scheduledAtMs, atMs: Number(nowMs) };
  records.push(savedAck);
  const aggregate = Array.isArray(command.delivery) ? command.delivery.find(value => value.pid === pid) : null;
  if (aggregate) {
    if (outcome === 'scheduled') aggregate.received += 1;
    else aggregate.expired += 1;
    aggregate.expected = Math.max(aggregate.expected, aggregate.received + aggregate.expired);
  }
  return { ok: true, changed: true, ackRecords: records, savedAck };
}

export function removePlayerDelivery(devices, ackRecords, pidValue) {
  const pid = normalizeRoutingKey(pidValue);
  return {
    devices: (Array.isArray(devices) ? devices : []).filter(device => device.pid !== pid),
    ackRecords: (Array.isArray(ackRecords) ? ackRecords : []).filter(record => record.pid !== pid)
  };
}
