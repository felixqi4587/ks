import {
  normalizeMarchRevision,
  normalizeMutationId,
  normalizeProfilePlayerId,
  normalizeRoutingKey,
  parseMarchSeconds,
  profilePlayerId
} from './room-player.js';

const DEFENSE_VERSION = 1;
const MAX_PLAYERS = 150;
const MAX_RECENT_MUTATIONS = 64;

const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);

function parseTapAnchorSeconds(value) {
  if (value === '' || value == null || typeof value === 'boolean') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(number) && number >= 5 && number <= 300 ? number : null;
}

function safeInteger(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function normalizeOpaqueId(value) {
  const id = String(value == null ? '' : value).trim();
  return id && id.length <= 64 ? id : '';
}

function normalizePurgePids(value) {
  const pids = [];
  const seen = new Set();
  const rawPids = Array.isArray(value) ? value.slice(0, MAX_PLAYERS) : [];
  for (const rawPid of rawPids) {
    const pid = normalizeRoutingKey(rawPid);
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    pids.push(pid);
  }
  return pids;
}

function normalizeStoredMarch(value) {
  if (value === '' || value == null || typeof value === 'boolean') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(number) && Number.isSafeInteger(number) ? number : null;
}

function copyPlayerRecords(value) {
  const source = value && typeof value === 'object' ? value : {};
  const players = {};
  for (const rawPid of Object.keys(source).sort().slice(0, MAX_PLAYERS)) {
    const pid = normalizeRoutingKey(rawPid);
    const player = source[rawPid];
    if (!pid || pid !== rawPid || !player || typeof player !== 'object' || Array.isArray(player)) continue;
    players[pid] = { ...player, marchRevision: normalizeMarchRevision(player.marchRevision) };
  }
  return players;
}

function normalizeRosterEntry(value) {
  const source = value && typeof value === 'object' ? value : {};
  const pid = normalizeRoutingKey(source.pid);
  const march = normalizeStoredMarch(source.march);
  const marchRevision = normalizeMarchRevision(source.marchRevision);
  if (!pid) return null;
  const validAtAcceptance = parseMarchSeconds(march) != null;
  if (typeof source.validAtAcceptance !== 'boolean' || source.validAtAcceptance !== validAtAcceptance) return null;
  const identityMode = source.identityMode === 'nickname' ? 'nickname' : 'playerId';
  const playerId = identityMode === 'playerId' ? normalizeProfilePlayerId(source.playerId) : '';
  return {
    pid,
    displayName: typeof source.displayName === 'string' && source.displayName ? source.displayName : pid,
    identityMode,
    playerId,
    march,
    marchRevision,
    connectedAtAcceptance: source.connectedAtAcceptance === true,
    validAtAcceptance
  };
}

function normalizeAudienceEntry(value) {
  const source = value && typeof value === 'object' ? value : {};
  const pid = normalizeRoutingKey(source.pid);
  const march = parseMarchSeconds(source.march);
  const goAtMs = safeInteger(source.goAtMs);
  if (!pid || march == null || goAtMs == null) return null;
  const identityMode = source.identityMode === 'nickname' ? 'nickname' : 'playerId';
  const playerId = identityMode === 'playerId' ? normalizeProfilePlayerId(source.playerId) : '';
  return {
    pid,
    displayName: typeof source.displayName === 'string' && source.displayName ? source.displayName : pid,
    identityMode,
    playerId,
    march,
    marchRevision: normalizeMarchRevision(source.marchRevision),
    goAtMs,
    tooLate: source.tooLate === true
  };
}

function normalizeActiveOrder(value) {
  const source = value && typeof value === 'object' ? value : {};
  const id = normalizeOpaqueId(source.id);
  const revision = safeInteger(source.revision);
  const mutationId = normalizeMutationId(source.mutationId);
  const signalAtMs = safeInteger(source.signalAtMs);
  const acceptedAtMs = safeInteger(source.acceptedAtMs);
  const tapAnchorSeconds = parseTapAnchorSeconds(source.tapAnchorSeconds);
  const enemyMarchSeconds = parseMarchSeconds(source.enemyMarchSeconds);
  const enemyLaunchAtMs = safeInteger(source.enemyLaunchAtMs);
  const enemyImpactAtMs = safeInteger(source.enemyImpactAtMs);
  const completeAtMs = safeInteger(source.completeAtMs);
  if (!id || !mutationId || revision == null || revision < 1 || signalAtMs == null || acceptedAtMs == null ||
      tapAnchorSeconds == null || enemyMarchSeconds == null || enemyLaunchAtMs == null ||
      enemyImpactAtMs == null || completeAtMs == null) return null;
  const expectedLaunchAtMs = signalAtMs + tapAnchorSeconds * 1000;
  const expectedImpactAtMs = expectedLaunchAtMs + enemyMarchSeconds * 1000;
  if (!Number.isSafeInteger(expectedLaunchAtMs) || !Number.isSafeInteger(expectedImpactAtMs) ||
      enemyLaunchAtMs !== expectedLaunchAtMs || enemyImpactAtMs !== expectedImpactAtMs) return null;

  const rosterAtAcceptance = [];
  const rosterPids = new Set();
  const rawRoster = Array.isArray(source.rosterAtAcceptance) ? source.rosterAtAcceptance : [];
  if (rawRoster.length > MAX_PLAYERS) return null;
  for (const raw of rawRoster) {
    const entry = normalizeRosterEntry(raw);
    if (!entry || rosterPids.has(entry.pid)) return null;
    rosterPids.add(entry.pid);
    rosterAtAcceptance.push(entry);
  }
  const audience = [];
  const audiencePids = new Set();
  const rawAudience = Array.isArray(source.audience) ? source.audience : [];
  if (rawAudience.length > MAX_PLAYERS) return null;
  for (const raw of rawAudience) {
    const entry = normalizeAudienceEntry(raw);
    if (!entry || audiencePids.has(entry.pid) || !rosterPids.has(entry.pid)) return null;
    const rosterEntry = rosterAtAcceptance.find(profile => profile.pid === entry.pid);
    const expectedGoAtMs = expectedImpactAtMs - rosterEntry.march * 1000;
    if (!rosterEntry.connectedAtAcceptance || !rosterEntry.validAtAcceptance ||
        !Number.isSafeInteger(expectedGoAtMs) || entry.displayName !== rosterEntry.displayName ||
        entry.identityMode !== rosterEntry.identityMode || entry.playerId !== rosterEntry.playerId ||
        entry.march !== rosterEntry.march || entry.marchRevision !== rosterEntry.marchRevision ||
        entry.goAtMs !== expectedGoAtMs || entry.tooLate !== (expectedGoAtMs <= acceptedAtMs)) return null;
    audiencePids.add(entry.pid);
    audience.push(entry);
  }
  const expectedAudiencePids = rosterAtAcceptance
    .filter(profile => profile.connectedAtAcceptance && profile.validAtAcceptance)
    .map(profile => profile.pid);
  if (expectedAudiencePids.length !== audience.length ||
      expectedAudiencePids.some(pid => !audiencePids.has(pid))) return null;
  const futureGoTimes = audience.filter(entry => !entry.tooLate).map(entry => entry.goAtMs);
  const expectedCompleteAtMs = futureGoTimes.length
    ? Math.max(...futureGoTimes) + 1000
    : acceptedAtMs + 3000;
  if (!Number.isSafeInteger(expectedCompleteAtMs) || completeAtMs !== expectedCompleteAtMs) return null;
  return {
    id,
    revision,
    mutationId,
    signalAtMs,
    acceptedAtMs,
    tapAnchorSeconds,
    enemyMarchSeconds,
    enemyLaunchAtMs,
    enemyImpactAtMs,
    rosterAtAcceptance,
    audience,
    completeAtMs
  };
}

function normalizeTerminal(value) {
  const source = value && typeof value === 'object' ? value : {};
  const orderId = normalizeOpaqueId(source.orderId);
  const revision = safeInteger(source.revision);
  const status = source.status === 'cancelled' || source.status === 'completed' ? source.status : '';
  const terminalAtMs = safeInteger(source.terminalAtMs);
  if (!orderId || revision == null || revision < 1 || !status || terminalAtMs == null) return null;
  return { orderId, revision, status, terminalAtMs, purgePids: normalizePurgePids(source.purgePids) };
}

function normalizeMutationOutcome(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const outcome = {};
  for (const key of ['ok', 'error', 'mutationId', 'revision', 'orderId', 'status', 'activeOrderId', 'activeOrderRevision']) {
    if (own(source, key)) outcome[key] = source[key];
  }
  if (source.config && typeof source.config === 'object') outcome.config = { ...source.config };
  if (own(source, 'purgePids')) outcome.purgePids = normalizePurgePids(source.purgePids);
  return outcome;
}

function normalizeMutationEntry(value) {
  const source = value && typeof value === 'object' ? value : {};
  const mutationId = normalizeMutationId(source.mutationId);
  const operation = String(source.operation || '').slice(0, 24);
  const fingerprint = String(source.fingerprint || '').slice(0, 512);
  if (!mutationId || !operation || !fingerprint) return null;
  return { mutationId, operation, fingerprint, outcome: normalizeMutationOutcome(source.outcome) };
}

export function defaultDefenseState() {
  return {
    version: DEFENSE_VERSION,
    config: {
      tapAnchorSeconds: 180,
      enemyMarchSeconds: null,
      revision: 0,
      updatedAt: null
    },
    players: {},
    pendingRemovalPids: [],
    orderRevision: 0,
    activeOrder: null,
    lastTerminal: null,
    recentMutations: []
  };
}

export function normalizeDefenseState(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const base = defaultDefenseState();
  const tapAnchorSeconds = parseTapAnchorSeconds(source.config && source.config.tapAnchorSeconds);
  const rawEnemyMarch = source.config && source.config.enemyMarchSeconds;
  const enemyMarchSeconds = rawEnemyMarch == null ? null : parseMarchSeconds(rawEnemyMarch);
  const configRevision = source.config && Number.isInteger(source.config.revision) && source.config.revision >= 0
    ? source.config.revision : 0;
  const configValid = tapAnchorSeconds != null && (rawEnemyMarch == null || enemyMarchSeconds != null);
  const players = copyPlayerRecords(source.players);
  const pendingRemovalPids = [];
  const pendingSeen = new Set();
  for (const rawPid of Array.isArray(source.pendingRemovalPids) ? source.pendingRemovalPids : []) {
    const pid = normalizeRoutingKey(rawPid);
    if (!pid || pendingSeen.has(pid) || !own(players, pid)) continue;
    pendingSeen.add(pid);
    pendingRemovalPids.push(pid);
  }
  let activeOrder = normalizeActiveOrder(source.activeOrder);
  const lastTerminal = normalizeTerminal(source.lastTerminal);
  if (activeOrder && lastTerminal && lastTerminal.revision >= activeOrder.revision) activeOrder = null;
  const storedOrderRevision = Number.isSafeInteger(source.orderRevision) && source.orderRevision >= 0
    ? source.orderRevision : 0;
  const orderRevision = Math.max(
    storedOrderRevision,
    activeOrder ? activeOrder.revision : 0,
    lastTerminal ? lastTerminal.revision : 0
  );
  const recentMutations = (Array.isArray(source.recentMutations) ? source.recentMutations : [])
    .map(normalizeMutationEntry)
    .filter(Boolean)
    .slice(-MAX_RECENT_MUTATIONS);
  return {
    version: DEFENSE_VERSION,
    config: configValid ? {
      tapAnchorSeconds,
      enemyMarchSeconds,
      revision: configRevision,
      updatedAt: typeof source.config.updatedAt === 'string' ? source.config.updatedAt.slice(0, 64) : null
    } : base.config,
    players,
    pendingRemovalPids,
    orderRevision,
    activeOrder,
    lastTerminal,
    recentMutations
  };
}

function fingerprint(parts) {
  return JSON.stringify(parts);
}

function mutationLookup(state, mutationId, operation, requestFingerprint) {
  const existing = state.recentMutations.find(entry => entry.mutationId === mutationId);
  if (!existing) return null;
  if (existing.operation !== operation || existing.fingerprint !== requestFingerprint) {
    return { conflict: true };
  }
  return { conflict: false, outcome: existing.outcome };
}

function appendMutation(state, mutationId, operation, requestFingerprint, outcome) {
  state.recentMutations = state.recentMutations
    .concat({ mutationId, operation, fingerprint: requestFingerprint, outcome })
    .slice(-MAX_RECENT_MUTATIONS);
}

function failure(state, error, extras = {}) {
  return { ok: false, error, state, ...extras };
}

function retryablePurgePids(state, value) {
  return normalizePurgePids(value).filter(pid => !own(state.players, pid));
}

function replay(state, operation, outcome) {
  const result = { ...outcome, state, replayed: true };
  if (operation === 'config' && outcome.config) result.config = { ...outcome.config };
  if (operation === 'fire' && outcome.ok === true) {
    result.order = state.activeOrder && state.activeOrder.id === outcome.orderId &&
      state.activeOrder.revision === outcome.revision ? state.activeOrder : null;
  }
  if (operation === 'fire' && outcome.error === 'order_active') {
    result.activeOrder = state.activeOrder && state.activeOrder.id === outcome.activeOrderId &&
      state.activeOrder.revision === outcome.activeOrderRevision ? state.activeOrder : null;
  }
  if (operation === 'cancel' && outcome.ok === true) {
    result.purgePids = retryablePurgePids(state, outcome.purgePids);
  }
  return result;
}

export function updateDefenseConfig(stateValue, input) {
  const state = normalizeDefenseState(stateValue);
  const mutationId = normalizeMutationId(input && input.mutationId);
  if (!mutationId) return failure(state, 'invalid_mutation', { mutationId: '' });
  const requestFingerprint = fingerprint([
    input && input.baseRevision,
    input && input.tapAnchorSeconds,
    input && input.enemyMarchSeconds
  ]);
  const existing = mutationLookup(state, mutationId, 'config', requestFingerprint);
  if (existing && existing.conflict) return failure(state, 'mutation_conflict', { mutationId });
  if (existing) return replay(state, 'config', existing.outcome);

  const tapAnchorSeconds = parseTapAnchorSeconds(input && input.tapAnchorSeconds);
  if (tapAnchorSeconds == null) return failure(state, 'invalid_tap_anchor', { mutationId });
  const enemyMarchSeconds = parseMarchSeconds(input && input.enemyMarchSeconds);
  if (enemyMarchSeconds == null) return failure(state, 'invalid_enemy_march', { mutationId });
  if (!Number.isInteger(input && input.baseRevision) || input.baseRevision !== state.config.revision) {
    return failure(state, 'config_conflict', { mutationId, canonicalRevision: state.config.revision });
  }

  const revision = state.config.revision + 1;
  if (!Number.isSafeInteger(revision)) return failure(state, 'revision_exhausted', { mutationId });
  state.config = {
    tapAnchorSeconds,
    enemyMarchSeconds,
    revision,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt.slice(0, 64) : null
  };
  const outcome = { ok: true, mutationId, config: { ...state.config }, revision };
  appendMutation(state, mutationId, 'config', requestFingerprint, outcome);
  return { ...outcome, state };
}

function connectedPidSet(value) {
  const result = new Set();
  for (const rawPid of Array.isArray(value) ? value : []) {
    const pid = normalizeRoutingKey(rawPid);
    if (pid) result.add(pid);
  }
  return result;
}

function orderProfile(pid, player, connected) {
  const identityMode = player && player.identityMode === 'nickname' ? 'nickname' : 'playerId';
  const playerId = identityMode === 'playerId' ? profilePlayerId(pid, player) : '';
  const validMarch = parseMarchSeconds(player && player.march);
  return {
    pid,
    displayName: typeof (player && player.name) === 'string' && player.name ? player.name : pid,
    identityMode,
    playerId,
    march: validMarch == null ? normalizeStoredMarch(player && player.march) : validMarch,
    marchRevision: normalizeMarchRevision(player && player.marchRevision),
    connectedAtAcceptance: connected,
    validAtAcceptance: validMarch != null
  };
}

export function createDefenseOrder(stateValue, input) {
  const state = normalizeDefenseState(stateValue);
  const mutationId = normalizeMutationId(input && input.mutationId);
  const orderId = normalizeOpaqueId(input && input.orderId);
  if (!mutationId) return failure(state, 'invalid_mutation', { mutationId: '' });
  if (!orderId) return failure(state, 'invalid_order_id', { mutationId });
  const connected = connectedPidSet(input && input.connectedPids);
  const requestFingerprint = fingerprint([
    input && input.configRevision,
    input && input.signalAtMs
  ]);
  const existing = mutationLookup(state, mutationId, 'fire', requestFingerprint);
  if (existing && existing.conflict) return failure(state, 'mutation_conflict', { mutationId });
  if (existing) return replay(state, 'fire', existing.outcome);

  if (state.activeOrder) {
    const outcome = {
      ok: false,
      error: 'order_active',
      mutationId,
      activeOrderId: state.activeOrder.id,
      activeOrderRevision: state.activeOrder.revision
    };
    appendMutation(state, mutationId, 'fire', requestFingerprint, outcome);
    return { ...outcome, state, activeOrder: state.activeOrder };
  }
  if (!Number.isInteger(input && input.configRevision) || input.configRevision !== state.config.revision) {
    return failure(state, 'config_conflict', { mutationId, canonicalRevision: state.config.revision });
  }
  const tapAnchorSeconds = parseTapAnchorSeconds(state.config.tapAnchorSeconds);
  const enemyMarchSeconds = parseMarchSeconds(state.config.enemyMarchSeconds);
  const signalAtMs = safeInteger(input && input.signalAtMs);
  const acceptedAtMs = safeInteger(input && input.acceptedAtMs);
  if (tapAnchorSeconds == null || enemyMarchSeconds == null) {
    return failure(state, 'invalid_config', { mutationId });
  }
  if (signalAtMs == null || acceptedAtMs == null) return failure(state, 'invalid_time', { mutationId });

  const enemyLaunchAtMs = signalAtMs + tapAnchorSeconds * 1000;
  const enemyImpactAtMs = enemyLaunchAtMs + enemyMarchSeconds * 1000;
  if (!Number.isSafeInteger(enemyLaunchAtMs) || !Number.isSafeInteger(enemyImpactAtMs)) {
    return failure(state, 'invalid_time', { mutationId });
  }

  const rosterAtAcceptance = [];
  const audience = [];
  let latestFutureGoAtMs = null;
  for (const pid of Object.keys(state.players).sort().slice(0, MAX_PLAYERS)) {
    const player = state.players[pid];
    const profile = orderProfile(pid, player, connected.has(pid));
    rosterAtAcceptance.push(profile);
    if (!profile.connectedAtAcceptance || !profile.validAtAcceptance) continue;
    const goAtMs = enemyImpactAtMs - profile.march * 1000;
    if (!Number.isSafeInteger(goAtMs)) return failure(state, 'invalid_time', { mutationId });
    const tooLate = goAtMs <= acceptedAtMs;
    audience.push({
      pid: profile.pid,
      displayName: profile.displayName,
      identityMode: profile.identityMode,
      playerId: profile.playerId,
      march: profile.march,
      marchRevision: profile.marchRevision,
      goAtMs,
      tooLate
    });
    if (!tooLate && (latestFutureGoAtMs == null || goAtMs > latestFutureGoAtMs)) latestFutureGoAtMs = goAtMs;
  }
  const completeAtMs = latestFutureGoAtMs == null ? acceptedAtMs + 3000 : latestFutureGoAtMs + 1000;
  const revision = state.orderRevision + 1;
  if (!Number.isSafeInteger(completeAtMs) || !Number.isSafeInteger(revision)) {
    return failure(state, 'invalid_time', { mutationId });
  }

  const order = {
    id: orderId,
    revision,
    mutationId,
    signalAtMs,
    acceptedAtMs,
    tapAnchorSeconds,
    enemyMarchSeconds,
    enemyLaunchAtMs,
    enemyImpactAtMs,
    rosterAtAcceptance,
    audience,
    completeAtMs
  };
  state.orderRevision = revision;
  state.activeOrder = order;
  const outcome = { ok: true, mutationId, orderId, revision };
  appendMutation(state, mutationId, 'fire', requestFingerprint, outcome);
  return { ...outcome, state, order };
}

function purgePendingPlayers(state) {
  const purgePids = [];
  for (const rawPid of state.pendingRemovalPids) {
    const pid = normalizeRoutingKey(rawPid);
    if (!pid || purgePids.includes(pid)) continue;
    purgePids.push(pid);
    delete state.players[pid];
  }
  state.pendingRemovalPids = [];
  return purgePids;
}

function terminalState(state, activeOrder, status, terminalAtMs) {
  const revision = state.orderRevision + 1;
  if (!Number.isSafeInteger(revision)) return null;
  const purgePids = purgePendingPlayers(state);
  state.orderRevision = revision;
  state.activeOrder = null;
  state.lastTerminal = { orderId: activeOrder.id, revision, status, terminalAtMs, purgePids };
  return { revision, purgePids };
}

export function cancelDefenseOrder(stateValue, input) {
  const state = normalizeDefenseState(stateValue);
  const mutationId = normalizeMutationId(input && input.mutationId);
  const orderId = normalizeOpaqueId(input && input.orderId);
  if (!mutationId) return failure(state, 'invalid_mutation', { mutationId: '' });
  if (!orderId) return failure(state, 'invalid_order_id', { mutationId });
  const requestFingerprint = fingerprint([
    orderId,
    input && input.orderRevision
  ]);
  const existing = mutationLookup(state, mutationId, 'cancel', requestFingerprint);
  if (existing && existing.conflict) return failure(state, 'mutation_conflict', { mutationId });
  if (existing) return replay(state, 'cancel', existing.outcome);

  const cancelledAtMs = safeInteger(input && input.cancelledAtMs);
  if (cancelledAtMs == null) return failure(state, 'invalid_time', { mutationId });
  const activeOrder = state.activeOrder;
  if (!activeOrder || activeOrder.id !== orderId || input.orderRevision !== activeOrder.revision) {
    return failure(state, 'stale_order', { mutationId, canonicalRevision: state.orderRevision });
  }
  const terminal = terminalState(state, activeOrder, 'cancelled', cancelledAtMs);
  if (!terminal) return failure(state, 'revision_exhausted', { mutationId });
  const outcome = {
    ok: true,
    mutationId,
    orderId,
    revision: terminal.revision,
    status: 'cancelled',
    purgePids: terminal.purgePids
  };
  appendMutation(state, mutationId, 'cancel', requestFingerprint, outcome);
  return { ...outcome, state, purgePids: terminal.purgePids };
}

export function completeDefenseOrder(stateValue, input) {
  const state = normalizeDefenseState(stateValue);
  const orderId = normalizeOpaqueId(input && input.orderId);
  const orderRevision = input && input.orderRevision;
  const completedAtMs = safeInteger(input && input.completedAtMs);
  if (!orderId) return failure(state, 'invalid_order_id');
  if (completedAtMs == null) return failure(state, 'invalid_time');

  if (!state.activeOrder) {
    const terminal = state.lastTerminal;
    if (terminal && terminal.orderId === orderId && terminal.status === 'completed' &&
        terminal.revision === orderRevision + 1) {
      return {
        ok: true,
        orderId,
        revision: terminal.revision,
        status: 'completed',
        state,
        purgePids: retryablePurgePids(state, terminal.purgePids),
        replayed: true
      };
    }
    return failure(state, 'stale_order', { canonicalRevision: state.orderRevision });
  }
  const activeOrder = state.activeOrder;
  if (activeOrder.id !== orderId || orderRevision !== activeOrder.revision) {
    return failure(state, 'stale_order', { canonicalRevision: state.orderRevision });
  }
  if (completedAtMs < activeOrder.completeAtMs) {
    return failure(state, 'order_not_due', { wakeAtMs: activeOrder.completeAtMs });
  }
  const terminal = terminalState(state, activeOrder, 'completed', completedAtMs);
  if (!terminal) return failure(state, 'revision_exhausted');
  return {
    ok: true,
    orderId,
    revision: terminal.revision,
    status: 'completed',
    state,
    purgePids: terminal.purgePids
  };
}

export function removeDefensePlayer(stateValue, pidValue) {
  const state = normalizeDefenseState(stateValue);
  const pid = normalizeRoutingKey(pidValue);
  if (!pid || !own(state.players, pid)) return failure(state, 'player_missing', { pid });
  const captured = Boolean(state.activeOrder && state.activeOrder.rosterAtAcceptance.some(profile => profile.pid === pid));
  if (captured) {
    if (!state.pendingRemovalPids.includes(pid)) state.pendingRemovalPids.push(pid);
    return {
      ok: true,
      pid,
      pending: true,
      purgePids: [],
      cardStatus: 'removal_applies_next_round',
      state
    };
  }
  delete state.players[pid];
  state.pendingRemovalPids = state.pendingRemovalPids.filter(value => value !== pid);
  return { ok: true, pid, pending: false, purgePids: [pid], state };
}

export function nextDefenseWakeAt(stateValue) {
  const state = normalizeDefenseState(stateValue);
  return state.activeOrder ? state.activeOrder.completeAtMs : null;
}

function activeOrderSummary(order) {
  const roster = order.rosterAtAcceptance;
  const audience = order.audience;
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
    counts: {
      registeredAtAcceptance: roster.length,
      targetedProfiles: audience.length,
      offlineRosterProfiles: roster.filter(profile => !profile.connectedAtAcceptance).length,
      invalidTimeProfiles: roster.filter(profile => !profile.validAtAcceptance).length,
      tooLateProfiles: audience.filter(profile => profile.tooLate).length
    }
  };
}

export function publicDefenseSummary(stateValue) {
  const state = normalizeDefenseState(stateValue);
  const terminal = state.lastTerminal;
  return {
    version: DEFENSE_VERSION,
    config: { ...state.config },
    registeredProfiles: Object.keys(state.players).length,
    pendingRemovalProfiles: state.pendingRemovalPids.length,
    orderRevision: state.orderRevision,
    activeOrder: state.activeOrder ? activeOrderSummary(state.activeOrder) : null,
    lastTerminal: terminal ? {
      orderId: terminal.orderId,
      revision: terminal.revision,
      status: terminal.status,
      terminalAtMs: terminal.terminalAtMs
    } : null
  };
}
