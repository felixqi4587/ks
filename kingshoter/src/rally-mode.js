import { normalizeRoutingKey } from './room-player.js';
import { isQaRoomName } from './delivery.js';

const MODE_SET = new Set(['double', 'triple']);
const ROLES = {
  double: new Set(['weak', 'main']),
  triple: new Set(['weak', 'weak2', 'main'])
};

const record = (value) => {
  if (!MODE_SET.has(value && value.mode) || !Number.isInteger(value && value.revision) || value.revision < 0) {
    return { mode: 'double', revision: 0 };
  }
  return { mode: value.mode, revision: value.revision };
};

export function newRallyModes() {
  return { 1: { mode: 'double', revision: 0 }, 2: { mode: 'double', revision: 0 } };
}

export function isTripleAllowed(env, roomName) {
  if (env && env.TRIPLE_RALLY_ENABLED === '1') return true;
  return Boolean(
    env && env.TRIPLE_RALLY_QA_ENABLED === '1' &&
    isQaRoomName(roomName)
  );
}

export function normalizeRallyModes(value) {
  return { 1: record(value && value[1]), 2: record(value && value[2]) };
}

export function transitionRallyMode(state, input) {
  const kingdom = Number(input && input.kingdom);
  const mode = input && input.mode;
  const rallyModes = normalizeRallyModes(state && state.rallyModes);
  if ((kingdom !== 1 && kingdom !== 2) || !MODE_SET.has(mode)) {
    return { ok: false, error: 'invalid_rally_mode' };
  }
  const current = rallyModes[kingdom];
  if (input.baseRevision !== current.revision) {
    return { ok: false, error: 'rally_mode_conflict', record: current };
  }
  const nextModes = { 1: { ...rallyModes[1] }, 2: { ...rallyModes[2] } };
  nextModes[kingdom] = { mode, revision: current.revision + 1 };
  const staged = { 1: state.staged && state.staged[1] || null, 2: state.staged && state.staged[2] || null };
  if (mode === 'double' && staged[kingdom]) {
    const pairs = (staged[kingdom].pairs || []).filter((pair) => pair && pair.role !== 'weak2');
    staged[kingdom] = pairs.length ? { kingdom, pairs } : null;
  }
  return { ok: true, rallyModes: nextModes, staged, record: nextModes[kingdom] };
}

export function disableTripleModes(state) {
  const rallyModes = normalizeRallyModes(state && state.rallyModes);
  const nextModes = { 1: { ...rallyModes[1] }, 2: { ...rallyModes[2] } };
  const staged = { 1: state.staged && state.staged[1] || null, 2: state.staged && state.staged[2] || null };
  let changed = false;
  for (const kingdom of [1, 2]) {
    if (nextModes[kingdom].mode === 'triple') {
      nextModes[kingdom] = { mode: 'double', revision: nextModes[kingdom].revision + 1 };
      changed = true;
    }
    if (staged[kingdom]) {
      const pairs = (staged[kingdom].pairs || []).filter((pair) => pair && pair.role !== 'weak2');
      if (pairs.length !== (staged[kingdom].pairs || []).length) {
        staged[kingdom] = pairs.length ? { kingdom, pairs } : null;
        changed = true;
      }
    }
  }
  return { changed, rallyModes: nextModes, staged };
}

export function validateStagedPairs(input) {
  const modeRecord = record(input && input.modeRecord);
  if (input.modeRevision !== modeRecord.revision) {
    return { ok: false, error: 'rally_mode_conflict', record: modeRecord };
  }
  const source = Array.isArray(input && input.pairs) ? input.pairs : [];
  const max = modeRecord.mode === 'triple' ? 3 : 2;
  if (source.length > max) return { ok: false, error: 'invalid_rally_roster' };
  const seenPids = new Set();
  const seenRoles = new Set();
  const pairs = [];
  for (const sourcePair of source) {
    const pid = normalizeRoutingKey(sourcePair && sourcePair.pid);
    const role = sourcePair && sourcePair.role;
    if (!pid || !ROLES[modeRecord.mode].has(role) || seenPids.has(pid) || seenRoles.has(role)) {
      return { ok: false, error: 'invalid_rally_roster' };
    }
    if (!Object.prototype.hasOwnProperty.call(input.players || {}, pid)) {
      return { ok: false, error: 'player_missing', pid };
    }
    seenPids.add(pid);
    seenRoles.add(role);
    pairs.push({ pid, role });
  }
  return { ok: true, pairs };
}
