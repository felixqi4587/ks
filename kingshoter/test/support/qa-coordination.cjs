/* Shared Rally/Defense QA origin and room guard. */
const QA_ROOM = 'qa';
const QA_PASSWORD = 'qa';

function assertQaRoomName(room) {
  const value = String(room || '');
  if (value !== QA_ROOM) {
    throw new Error(`Refusing non-QA coordination room: ${value || '<empty>'}; expected qa`);
  }
  return value;
}

function makeQaRoom() {
  return QA_ROOM;
}

function coordinationUrl(baseURL, surface, room, params = {}) {
  const safeRoom = assertQaRoomName(room);
  if (Object.prototype.hasOwnProperty.call(params, 'room')) {
    throw new Error('Refusing QA room override in URL params');
  }
  if (surface !== 'rally' && surface !== 'defense') {
    throw new Error(`Refusing unknown coordination surface: ${surface || '<empty>'}`);
  }
  const url = new URL(`/${surface}`, baseURL);
  url.searchParams.set('room', safeRoom);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function qaRoomUrl(baseURL, room, params = {}) {
  return coordinationUrl(baseURL, 'rally', room, params);
}

function qaDefenseUrl(baseURL, room, params = {}) {
  return coordinationUrl(baseURL, 'defense', room, params);
}

function localQaBaseURL(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); }
  catch (error) { throw new Error('Refusing non-local QA origin'); }
  const loopback = parsed.hostname === '127.0.0.1' ||
    parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
  const cleanOrigin = !parsed.username && !parsed.password &&
    parsed.pathname === '/' && !parsed.search && !parsed.hash;
  if (!loopback || !cleanOrigin || !['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Refusing non-local QA origin: ${parsed.origin}`);
  }
  return parsed.origin;
}

// Returns only the next normal commander mutations. The caller waits for a
// later room snapshot before advancing to the next phase, so this remains
// safe against delayed Durable Object broadcasts on both local and remote QA.
function nextQaRallyCleanupActions(snapshot, room, password, createMutationId) {
  if (typeof createMutationId !== 'function') throw new TypeError('createMutationId must be a function');
  const current = snapshot || {};
  const live = current.live || {};
  const commands = live.commands || {};
  const active = [1, 2].filter(kingdom => commands[String(kingdom)]);
  if (active.length) {
    return active.map(kingdom => ({
      key: `cancel:${kingdom}:${commands[String(kingdom)].id || ''}`,
      message: { t: 'cmd', password, cmd: { type: 'cancel', kingdom } }
    }));
  }

  const modes = current.rallyModes || {};
  const modeRecord = kingdom => modes[String(kingdom)] || { mode: 'double', revision: 0 };
  const staged = live.staged || {};
  const populatedStaging = [1, 2].filter(kingdom => {
    const entry = staged[String(kingdom)];
    return entry && Array.isArray(entry.pairs) && entry.pairs.length > 0;
  });
  if (populatedStaging.length) {
    return populatedStaging.map(kingdom => ({
      key: `stage:${kingdom}:${modeRecord(kingdom).revision}`,
      message: {
        t: 'stage', password,
        staged: { kingdom, modeRevision: modeRecord(kingdom).revision, pairs: [] }
      }
    }));
  }

  const tripleKingdoms = [1, 2].filter(kingdom => modeRecord(kingdom).mode !== 'double');
  if (tripleKingdoms.length) {
    return tripleKingdoms.map(kingdom => ({
      key: `mode:${kingdom}:${modeRecord(kingdom).revision}:double`,
      message: {
        t: 'setRallyMode', mutationId: createMutationId(), password,
        kingdom, mode: 'double', baseRevision: modeRecord(kingdom).revision
      }
    }));
  }

  const playerIds = Object.keys(current.players || {}).sort();
  if (!playerIds.length) return [];
  const pid = playerIds[0];
  return [{
    key: `remove:${pid}`,
    message: { t: 'removePlayer', password, pid }
  }];
}

async function resetQaRallyState(browser, baseURL, room = QA_ROOM, options = {}) {
  const safeRoom = assertQaRoomName(room);
  const safeBaseURL = String(baseURL || '');
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 20_000;
  const context = await browser.newContext({ locale: 'en-US' });
  await installQaWebSocketGuard(context, safeRoom, { expectedOrigin: safeBaseURL });
  const page = await context.newPage();
  try {
    await page.goto(qaRoomUrl(safeBaseURL, safeRoom, { notour: '1', lang: 'en' }), {
      waitUntil: 'domcontentloaded'
    });
    await page.evaluate(({ roomName, roomPassword, timeout, plannerSource }) => new Promise((resolve, reject) => {
      const nextActions = (0, eval)(`(${plannerSource})`);
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${protocol}://${location.host}/api/ws?room=${encodeURIComponent(roomName)}`);
      const attempted = new Set();
      let mutationIndex = 0;
      const createMutationId = () => `qa-cleanup-${Date.now()}-${++mutationIndex}`;
      const timer = setTimeout(() => {
        try { socket.close(); } catch (error) {}
        reject(new Error('Timed out converging fixed QA Rally state'));
      }, timeout);
      const finish = () => {
        clearTimeout(timer);
        try { socket.close(); } catch (error) {}
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Fixed QA Rally cleanup WebSocket failed'));
      };
      socket.onmessage = event => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch (error) { return; }
        if (message && message.t === 'error') {
          clearTimeout(timer);
          try { socket.close(); } catch (error) {}
          reject(new Error(`Fixed QA Rally cleanup failed: ${message.error || 'unknown_error'}`));
          return;
        }
        const snapshot = message && message.t === 'state' && message.room;
        if (!snapshot) return;
        const actions = nextActions(snapshot, roomName, roomPassword, createMutationId);
        if (!actions.length) return finish();
        actions.forEach(action => {
          if (attempted.has(action.key)) return;
          attempted.add(action.key);
          socket.send(JSON.stringify(action.message));
        });
      };
    }), {
      roomName: safeRoom,
      roomPassword: QA_PASSWORD,
      timeout: timeoutMs,
      plannerSource: nextQaRallyCleanupActions.toString()
    });
  } finally {
    await context.close();
  }
}

async function installQaWebSocketGuard(context, room, options = {}) {
  const safeRoom = assertQaRoomName(room);
  const dropClient = options.shouldDropClientMessage;
  const dropServer = options.shouldDropServerMessage;
  const transformServer = options.transformServerMessage;
  const expectedOrigin = options.expectedOrigin;
  let expectedWebSocketOrigin = '';
  if (dropClient !== undefined && typeof dropClient !== 'function') throw new TypeError('shouldDropClientMessage must be a function');
  if (dropServer !== undefined && typeof dropServer !== 'function') throw new TypeError('shouldDropServerMessage must be a function');
  if (transformServer !== undefined && typeof transformServer !== 'function') throw new TypeError('transformServerMessage must be a function');
  if (expectedOrigin !== undefined) {
    if (typeof expectedOrigin !== 'string') throw new TypeError('expectedOrigin must be a string');
    let parsed;
    try { parsed = new URL(expectedOrigin); } catch (error) { throw new TypeError('expectedOrigin must be an absolute URL'); }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new TypeError('expectedOrigin must be an HTTP or WebSocket origin');
    }
    if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
    else if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
    expectedWebSocketOrigin = parsed.origin;
  }

  await context.routeWebSocket(/\/api\/ws(?:\?|$)/, route => {
    const url = route.url();
    const parsed = new URL(url);
    const actualRoom = parsed.searchParams.get('room') || '';
    if (actualRoom !== safeRoom) {
      throw new Error(`Refusing WebSocket room ${actualRoom || '<empty>'}; guard allows only ${safeRoom}`);
    }
    if (expectedWebSocketOrigin && parsed.origin !== expectedWebSocketOrigin) {
      throw new Error(`Refusing WebSocket origin ${parsed.origin}; guard allows only ${expectedWebSocketOrigin}`);
    }
    const server = route.connectToServer();
    route.onMessage(data => {
      if (!dropClient || !dropClient({ url, data })) server.send(data);
    });
    server.onMessage(data => {
      if (dropServer && dropServer({ url, data })) return;
      route.send(transformServer ? transformServer({ url, data }) : data);
    });
  });
}

module.exports = {
  QA_ROOM,
  QA_PASSWORD,
  assertQaRoomName,
  makeQaRoom,
  qaRoomUrl,
  qaDefenseUrl,
  installQaWebSocketGuard,
  localQaBaseURL,
  nextQaRallyCleanupActions,
  resetQaRallyState
};
