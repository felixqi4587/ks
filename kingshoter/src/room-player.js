export const MARCH_MIN = 5;
export const MARCH_MAX = 120;
const DEFENSE_PLAYER_LIMIT = 150;

const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);

export function normalizeRoutingKey(value) {
  const key = String(value == null ? '' : value).trim().slice(0, 24);
  if (!key || key === '__proto__' || key === 'prototype' || key === 'constructor') return '';
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : '';
}

export function normalizeMutationId(value) {
  const id = String(value == null ? '' : value).trim();
  return id && id.length <= 64 ? id : '';
}

export function normalizeProfilePlayerId(value) {
  const playerId = String(value == null ? '' : value).trim();
  return /^\d{1,16}$/.test(playerId) ? playerId : '';
}

export function profilePlayerId(pid, player) {
  if (!player || player.identityMode === 'nickname') return '';
  return normalizeProfilePlayerId(player.playerId) || normalizeProfilePlayerId(pid);
}

export function parseMarchSeconds(value) {
  if (value === '' || value == null || typeof value === 'boolean') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(number) && number >= MARCH_MIN && number <= MARCH_MAX ? number : null;
}

export function normalizeMarchRevision(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function normalizePlayerRecordsWithMigration(players) {
  const source = players && typeof players === 'object' ? players : {};
  const result = Object.create(null);
  let changed = false;
  for (const pid of Object.keys(source)) {
    const player = source[pid] && typeof source[pid] === 'object' ? source[pid] : {};
    const revision = normalizeMarchRevision(player.marchRevision);
    const legacyOverMax = Number.isInteger(player.march) && player.march > MARCH_MAX;
    result[pid] = Object.assign({}, player, {
      march: legacyOverMax ? MARCH_MAX : player.march,
      marchRevision: revision + (legacyOverMax ? 1 : 0)
    });
    if (legacyOverMax || revision !== player.marchRevision) changed = true;
  }
  return { players: result, changed };
}

export function normalizePlayerRecords(players) {
  return normalizePlayerRecordsWithMigration(players).players;
}

function cleanName(value) {
  return Array.from(String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim().replace(/\s+/g, ' ')).slice(0, 24).join('');
}

function canonicalProfile(pid, player) {
  const identityMode = player.identityMode === 'nickname' ? 'nickname' : 'playerId';
  const profile = {
    pid,
    identityMode,
    name: player.name,
    march: player.march,
    revision: normalizeMarchRevision(player.marchRevision)
  };
  const playerId = profilePlayerId(pid, player);
  if (identityMode === 'playerId' && playerId) profile.playerId = playerId;
  return profile;
}

function playerIdOwner(players, playerId, exceptPid = '') {
  if (!playerId) return '';
  for (const candidatePid of Object.keys(players || {})) {
    if (candidatePid !== exceptPid && profilePlayerId(candidatePid, players[candidatePid]) === playerId) {
      return candidatePid;
    }
  }
  return '';
}

export function registerPlayer(players, input, nowISO) {
  const pid = normalizeRoutingKey(input && input.pid);
  const march = parseMarchSeconds(input && input.march);
  if (!pid) return { ok: false, error: 'invalid_pid' };
  if (march == null) return { ok: false, error: 'invalid_march' };
  const mode = input && input.identityMode === 'nickname' ? 'nickname' : 'playerId';
  const hasExplicitPlayerId = mode === 'playerId' && own(input, 'playerId');
  const playerId = hasExplicitPlayerId ? normalizeProfilePlayerId(input.playerId) : '';
  if (hasExplicitPlayerId && !playerId) return { ok: false, error: 'invalid_player_id' };
  if (own(players, pid)) return { ok: true, created: false, pid, player: players[pid] };
  const claimedPlayerId = playerId || (mode === 'playerId' ? normalizeProfilePlayerId(pid) : '');
  if (playerIdOwner(players, claimedPlayerId)) return { ok: false, error: 'player_id_conflict' };
  const name = cleanName(input && input.name) || pid;
  const player = {
    name,
    march,
    marchRevision: 0,
    identityMode: mode,
    alliance: cleanName(input && input.alliance),
    ready: false,
    lastSeen: nowISO
  };
  if (playerId) player.playerId = playerId;
  players[pid] = player;
  return { ok: true, created: true, pid, player: players[pid] };
}

export function applyOwnProfileUpdate(players, input, options = {}) {
  const mutationId = normalizeMutationId(input && input.mutationId);
  const pid = normalizeRoutingKey(input && input.pid);
  if (!mutationId) return { ok: false, error: 'invalid_mutation', mutationId: '' };
  if (!pid || !own(players, pid)) return { ok: false, error: 'player_missing', mutationId, pid };

  const player = players[pid];
  const identityMode = input && input.identityMode;
  const name = cleanName(input && input.name);
  const march = parseMarchSeconds(input && input.march);
  const playerId = identityMode === 'playerId' ? normalizeProfilePlayerId(input && input.playerId) : '';
  if (identityMode === 'playerId' && !playerId) return { ok: false, error: 'invalid_player_id', mutationId, pid };
  if (identityMode !== 'playerId' && identityMode !== 'nickname') {
    return { ok: false, error: 'invalid_nickname', mutationId, pid };
  }
  if (!name) return { ok: false, error: 'invalid_nickname', mutationId, pid };
  if (march == null) return { ok: false, error: 'invalid_march', mutationId, pid };
  if (playerIdOwner(players, playerId, pid)) return { ok: false, error: 'player_id_conflict', mutationId, pid };

  const currentRevision = normalizeMarchRevision(player.marchRevision);
  if (!Number.isInteger(input.baseRevision) || input.baseRevision !== currentRevision) {
    return {
      ok: false,
      error: 'player_conflict',
      mutationId,
      pid,
      profile: canonicalProfile(pid, player)
    };
  }

  const nextPlayer = Object.assign({}, player, {
    name,
    march,
    marchRevision: currentRevision + 1,
    identityMode
  });
  if (identityMode === 'playerId') nextPlayer.playerId = playerId;
  else delete nextPlayer.playerId;
  if (options.touchLastSeen) nextPlayer.lastSeen = options.nowISO;
  players[pid] = nextPlayer;
  return { ok: true, mutationId, pid, profile: canonicalProfile(pid, nextPlayer) };
}

export function applyPlayerMarchUpdate(players, input, options = {}) {
  const mutationId = normalizeMutationId(input && input.mutationId);
  const pid = normalizeRoutingKey(input && input.pid);
  const march = parseMarchSeconds(input && input.march);
  if (!mutationId) return { ok: false, error: 'invalid_mutation', mutationId: '' };
  if (!pid || !own(players, pid)) return { ok: false, error: 'player_missing', mutationId, pid };
  if (march == null) return { ok: false, error: 'invalid_march', mutationId, pid };
  const player = players[pid];
  const currentRevision = normalizeMarchRevision(player.marchRevision);
  if (!Number.isInteger(input.baseRevision) || input.baseRevision !== currentRevision) {
    return {
      ok: false,
      error: 'player_conflict',
      mutationId,
      pid,
      latest: { pid, march: player.march, revision: currentRevision }
    };
  }
  player.march = march;
  player.marchRevision = currentRevision + 1;
  if (options.touchLastSeen) player.lastSeen = options.nowISO;
  return { ok: true, mutationId, pid, march, revision: player.marchRevision };
}

export function rallyTargetPids(command) {
  const pairs = command && command.payload && Array.isArray(command.payload.pairs) ? command.payload.pairs : [];
  const seen = new Set();
  const result = [];
  for (const pair of pairs) {
    const pid = normalizeRoutingKey(pair && pair.pid);
    if (pid && !seen.has(pid)) { seen.add(pid); result.push(pid); }
  }
  return result;
}

export function activeCommandPids(live, nowSec) {
  const result = new Set();
  const commands = live && live.commands && typeof live.commands === 'object' ? live.commands : {};
  for (const key of Object.keys(commands)) {
    const command = commands[key];
    if (command && Number(command.expiresUTC) > nowSec) {
      for (const pid of rallyTargetPids(command)) result.add(pid);
    }
  }
  return result;
}

export function clearStagedPlayer(live, pidValue) {
  const pid = normalizeRoutingKey(pidValue);
  const cleared = [];
  if (!pid || !live || !live.staged) return cleared;
  for (const kingdom of [1, 2]) {
    const staged = live.staged[kingdom];
    const pairs = staged && Array.isArray(staged.pairs) ? staged.pairs : [];
    for (const pair of pairs) if (pair.pid === pid) cleared.push({ kingdom, role: pair.role });
    const kept = pairs.filter(pair => pair.pid !== pid);
    live.staged[kingdom] = kept.length ? Object.assign({}, staged, { pairs: kept }) : null;
  }
  return cleared;
}

export function removePlayerAtomic(room, pidValue, nowSec) {
  const pid = normalizeRoutingKey(pidValue);
  if (!pid || !own(room && room.players, pid)) return { ok: false, error: 'player_missing', pid };
  if (activeCommandPids(room.live, nowSec).has(pid)) return { ok: false, error: 'player_in_live_command', pid };
  const cleared = clearStagedPlayer(room.live, pid);
  delete room.players[pid];
  return { ok: true, pid, cleared };
}

export function projectDefensePlayerPurges(playersValue, profileOwnersValue, devicesValue, pidValues) {
  const sourcePlayers = playersValue && typeof playersValue === 'object' && !Array.isArray(playersValue)
    ? playersValue : {};
  const candidates = [];
  const seen = new Set();
  const rawPids = Array.isArray(pidValues) ? pidValues.slice(0, DEFENSE_PLAYER_LIMIT) : [];
  for (const rawPid of rawPids) {
    const pid = normalizeRoutingKey(rawPid);
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    candidates.push(pid);
  }
  const pids = candidates.filter(pid => !own(sourcePlayers, pid));
  const removed = new Set(pids);
  const players = Object.create(null);
  for (const rawPid of Object.keys(sourcePlayers)) {
    const pid = normalizeRoutingKey(rawPid);
    if (pid && pid === rawPid && !removed.has(pid)) players[pid] = sourcePlayers[rawPid];
  }
  const sourceOwners = profileOwnersValue && typeof profileOwnersValue === 'object' && !Array.isArray(profileOwnersValue)
    ? profileOwnersValue : {};
  const profileOwners = Object.create(null);
  for (const rawPid of Object.keys(sourceOwners)) {
    const pid = normalizeRoutingKey(rawPid);
    if (pid && pid === rawPid && !removed.has(pid)) profileOwners[pid] = sourceOwners[rawPid];
  }
  const devices = (Array.isArray(devicesValue) ? devicesValue : [])
    .filter(device => !removed.has(normalizeRoutingKey(device && device.pid)));
  return { pids, players, profileOwners, devices };
}

export function freezeDoubleRally(players, pairsValue, firstPressValue) {
  const pairs = Array.isArray(pairsValue) ? pairsValue : [];
  const firstPress = Number(firstPressValue);
  if (pairs.length !== 2 || !Number.isFinite(firstPress)) return { ok: false, error: 'invalid_rally' };
  const byRole = Object.create(null);
  for (const input of pairs) {
    const pid = normalizeRoutingKey(input && input.pid);
    const role = input && input.role === 'main' ? 'main' : 'weak';
    if (!pid || !own(players, pid) || byRole[role]) return { ok: false, error: 'player_missing' };
    byRole[role] = { pid, player: players[pid] };
  }
  if (!byRole.weak || !byRole.main || byRole.weak.pid === byRole.main.pid) return { ok: false, error: 'player_missing' };
  const weakMarch = parseMarchSeconds(byRole.weak.player.march);
  const mainMarch = parseMarchSeconds(byRole.main.player.march);
  if (weakMarch == null || mainMarch == null) return { ok: false, error: 'invalid_march' };
  const offset = (mainMarch - weakMarch) - 1;
  const mainPress = offset >= 0 ? firstPress : firstPress - offset;
  const weakPress = offset >= 0 ? firstPress + offset : firstPress;
  return {
    ok: true,
    pairs: [
      { pid: byRole.weak.pid, name: byRole.weak.player.name || byRole.weak.pid, role: 'weak', march: weakMarch, pressUTC: weakPress },
      { pid: byRole.main.pid, name: byRole.main.player.name || byRole.main.pid, role: 'main', march: mainMarch, pressUTC: mainPress }
    ]
  };
}
