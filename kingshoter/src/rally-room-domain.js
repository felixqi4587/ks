import { normalizeMutationId } from './room-player.js';

export const RALLY_MUTATION_RECEIPT_LIMIT = 64;

const RALLY_MUTATION_TYPES = new Set(['kingdomName', 'rallyMode']);
const RALLY_MODES = new Set(['double', 'triple']);
const INVISIBLE_NAME_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu;

function revision(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function graphemes(value) {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(value), part => part.segment);
  }
  return Array.from(value);
}

function visibleKingdomDisplayName(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFC')
    .replace(/\s+/gu, ' ')
    .replace(INVISIBLE_NAME_CHARACTERS, '')
    .trim();
}

export function normalizeKingdomDisplayName(value) {
  return graphemes(visibleKingdomDisplayName(value)).slice(0, 24).join('');
}

export function validateKingdomDisplayName(value) {
  if (typeof value !== 'string') return { ok: false, error: 'invalid_kingdom_name' };
  const parts = graphemes(visibleKingdomDisplayName(value));
  return parts.length <= 24
    ? { ok: true, name: parts.join('') }
    : { ok: false, error: 'invalid_kingdom_name' };
}

function kingdomNameRecord(value) {
  return {
    name: normalizeKingdomDisplayName(value && value.name),
    revision: revision(value && value.revision)
  };
}

function normalizeReceipt(value, expectedMutationId, expectedType) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const mutationId = normalizeMutationId(value.mutationId);
  const kingdom = Number(value.kingdom);
  const receiptRevision = Number.isInteger(value.revision) && value.revision > 0
    ? value.revision : null;
  if (!mutationId || mutationId !== expectedMutationId ||
      (kingdom !== 1 && kingdom !== 2) || receiptRevision == null) return null;
  if (expectedType === 'kingdomName' && value.t === 'kingdomNameSaved') {
    return {
      t: 'kingdomNameSaved', mutationId, kingdom,
      name: normalizeKingdomDisplayName(value.name), revision: receiptRevision
    };
  }
  if (expectedType === 'rallyMode' && value.t === 'rallyModeSaved' &&
      RALLY_MODES.has(value.mode)) {
    return {
      t: 'rallyModeSaved', mutationId, kingdom,
      mode: value.mode, revision: receiptRevision
    };
  }
  return null;
}

function mutationReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const mutationId = normalizeMutationId(value.mutationId);
  const type = RALLY_MUTATION_TYPES.has(value.type) ? value.type : '';
  const fingerprint = typeof value.fingerprint === 'string' &&
    value.fingerprint.length > 0 && value.fingerprint.length <= 1024
    ? value.fingerprint : '';
  const receipt = normalizeReceipt(value.receipt, mutationId, type);
  return mutationId && type && fingerprint && receipt
    ? { mutationId, type, fingerprint, receipt }
    : null;
}

export function normalizeRallyRoomState(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const names = source.kingdomNames && typeof source.kingdomNames === 'object'
    ? source.kingdomNames : {};
  const byMutationId = new Map();
  for (const item of Array.isArray(source.mutationReceipts) ? source.mutationReceipts : []) {
    const normalized = mutationReceipt(item);
    if (!normalized) continue;
    if (byMutationId.has(normalized.mutationId)) byMutationId.delete(normalized.mutationId);
    byMutationId.set(normalized.mutationId, normalized);
  }
  return {
    kingdomNames: {
      1: kingdomNameRecord(names[1]),
      2: kingdomNameRecord(names[2])
    },
    mutationReceipts: Array.from(byMutationId.values()).slice(-RALLY_MUTATION_RECEIPT_LIMIT)
  };
}

export function displayKingdomName(record, kingdom) {
  const canonical = normalizeKingdomDisplayName(record && record.name);
  return canonical || `Kingdom ${Number(kingdom) === 2 ? 2 : 1}`;
}

export function transitionKingdomName(state, input) {
  const kingdom = Number(input && input.kingdom);
  const validName = validateKingdomDisplayName(input && input.name);
  if ((kingdom !== 1 && kingdom !== 2) || !validName.ok) {
    return { ok: false, error: 'invalid_kingdom_name' };
  }
  const rallyRoom = normalizeRallyRoomState(state);
  const current = rallyRoom.kingdomNames[kingdom];
  if (!Number.isInteger(input.baseRevision) || input.baseRevision !== current.revision) {
    return { ok: false, error: 'kingdom_name_conflict', record: current };
  }
  const nextRevision = current.revision + 1;
  if (!Number.isSafeInteger(nextRevision)) {
    return { ok: false, error: 'revision_exhausted', record: current };
  }
  const record = {
    name: validName.name,
    revision: nextRevision
  };
  return {
    ok: true,
    record,
    rallyRoom: {
      ...rallyRoom,
      kingdomNames: {
        1: { ...rallyRoom.kingdomNames[1] },
        2: { ...rallyRoom.kingdomNames[2] },
        [kingdom]: record
      }
    }
  };
}

export function rallyMutationFingerprint(type, values) {
  if (!RALLY_MUTATION_TYPES.has(type) || !Array.isArray(values)) return '';
  return JSON.stringify([type, ...values]);
}

export function inspectRallyMutation(state, input) {
  const mutationId = normalizeMutationId(input && input.mutationId);
  const type = RALLY_MUTATION_TYPES.has(input && input.type) ? input.type : '';
  const fingerprint = typeof (input && input.fingerprint) === 'string'
    ? input.fingerprint : '';
  if (!mutationId || !type || !fingerprint) return { status: 'conflict', error: 'invalid_mutation' };
  const rallyRoom = normalizeRallyRoomState(state);
  const existing = rallyRoom.mutationReceipts.find(item => item.mutationId === mutationId);
  if (!existing) return { status: 'new' };
  if (existing.type !== type || existing.fingerprint !== fingerprint) {
    return { status: 'conflict', error: 'mutation_id_conflict' };
  }
  return { status: 'replay', receipt: { ...existing.receipt } };
}

export function rememberRallyMutation(state, input) {
  const rallyRoom = normalizeRallyRoomState(state);
  const normalized = mutationReceipt({
    mutationId: input && input.mutationId,
    type: input && input.type,
    fingerprint: input && input.fingerprint,
    receipt: input && input.receipt
  });
  if (!normalized) return rallyRoom;
  const receipts = rallyRoom.mutationReceipts
    .filter(item => item.mutationId !== normalized.mutationId)
    .concat(normalized)
    .slice(-RALLY_MUTATION_RECEIPT_LIMIT);
  return { ...rallyRoom, mutationReceipts: receipts };
}

export function projectRallyRoomState(value, connectedWebsiteDevices) {
  const rallyRoom = normalizeRallyRoomState(value);
  const connected = Number.isSafeInteger(connectedWebsiteDevices) && connectedWebsiteDevices >= 0
    ? connectedWebsiteDevices : 0;
  return {
    kingdomNames: {
      1: { ...rallyRoom.kingdomNames[1] },
      2: { ...rallyRoom.kingdomNames[2] }
    },
    managerMeta: { connectedWebsiteDevices: connected }
  };
}
