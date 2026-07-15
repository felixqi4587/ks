const { randomBytes } = require('node:crypto');

function assertQaRoomName(room) {
  const value = String(room || '');
  if (!/^qa-kvk-[a-z0-9](?:[a-z0-9-]{0,39}[a-z0-9])?$/.test(value)) {
    throw new Error(`Refusing non-QA KvK room: ${value || '<empty>'}; expected qa-kvk-*`);
  }
  return value;
}

function makeQaRoom(testInfo) {
  const source = typeof testInfo === 'string'
    ? testInfo
    : testInfo && testInfo.title
      ? testInfo.title
      : 'core';
  const label = String(source).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'core';
  return assertQaRoomName(`qa-kvk-${label}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`);
}

function qaRoomUrl(baseURL, room, params = {}) {
  const safeRoom = assertQaRoomName(room);
  if (Object.prototype.hasOwnProperty.call(params, 'room')) {
    throw new Error('Refusing QA room override in URL params');
  }
  const url = new URL('/kvk.html', baseURL);
  url.searchParams.set('room', safeRoom);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
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
  assertQaRoomName,
  makeQaRoom,
  qaRoomUrl,
  installQaWebSocketGuard,
  localQaBaseURL
};
