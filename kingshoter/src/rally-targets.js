import { normalizeRoutingKey, parseMarchSeconds } from './room-player.js';

const ROLE_OFFSETS = { weak: 0, weak2: 0, main: 1 };
const LEADS = new Set([10, 15, 30, 60]);

export function buildTripleRallyCommand(input) {
  const pairs = Array.isArray(input && input.pairs) ? input.pairs : [];
  if (pairs.length !== 3 || !LEADS.has(input.leadSeconds) || ![1, 2].includes(input.kingdom)) {
    return { ok: false, error: 'invalid_rally_roster' };
  }
  const canonicalPids = pairs.map((pair) => normalizeRoutingKey(pair && pair.pid));
  const pidSet = new Set(canonicalPids);
  const roleSet = new Set(pairs.map((pair) => pair && pair.role));
  if (canonicalPids.some((pid) => !pid) || pidSet.size !== 3 || roleSet.size !== 3 ||
      !Object.keys(ROLE_OFFSETS).every((role) => roleSet.has(role))) {
    return { ok: false, error: 'invalid_rally_roster' };
  }
  const canonical = [];
  for (const pair of pairs) {
    const pid = normalizeRoutingKey(pair.pid);
    if (!Object.prototype.hasOwnProperty.call(input.players || {}, pid)) {
      return { ok: false, error: 'player_missing', pid };
    }
    const player = input.players && input.players[pid];
    if (!player) return { ok: false, error: 'player_missing', pid };
    const march = parseMarchSeconds(player.march);
    if (march === null) return { ok: false, error: 'invalid_march', pid };
    canonical.push({ pid, name: String(player.name || pid).slice(0, 24), role: pair.role, march });
  }
  const raw = canonical.map((pair) => ROLE_OFFSETS[pair.role] - pair.march);
  const firstRaw = Math.min(...raw);
  const commandPairs = canonical.map((pair, index) => ({
    ...pair,
    pressUTC: input.serverNowSec + input.leadSeconds + raw[index] - firstRaw
  }));
  const anchorUTC = Math.min(...commandPairs.map((pair) => pair.pressUTC));
  const expiresUTC = Math.max(...commandPairs.map((pair) => pair.pressUTC + 300 + pair.march)) + 30;
  return {
    ok: true,
    command: {
      id: input.commandId,
      type: 'triple_rally',
      kingdom: input.kingdom,
      anchorUTC,
      expiresUTC,
      payload: {
        pairs: commandPairs,
        firstPress: anchorUTC,
        kingdom: input.kingdom,
        leadSeconds: input.leadSeconds
      },
      text: '',
      at: input.atISO
    }
  };
}
