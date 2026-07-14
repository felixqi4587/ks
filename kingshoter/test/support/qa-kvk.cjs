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
  const url = new URL('/kvk.html', baseURL);
  url.searchParams.set('room', safeRoom);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function installQaWebSocketGuard(context, room, options = {}) {
  const safeRoom = assertQaRoomName(room);
  const dropClient = options.shouldDropClientMessage;
  const dropServer = options.shouldDropServerMessage;
  if (dropClient !== undefined && typeof dropClient !== 'function') throw new TypeError('shouldDropClientMessage must be a function');
  if (dropServer !== undefined && typeof dropServer !== 'function') throw new TypeError('shouldDropServerMessage must be a function');

  await context.routeWebSocket(/\/api\/ws(?:\?|$)/, route => {
    const url = route.url();
    const actualRoom = new URL(url).searchParams.get('room') || '';
    if (actualRoom !== safeRoom) {
      throw new Error(`Refusing WebSocket room ${actualRoom || '<empty>'}; guard allows only ${safeRoom}`);
    }
    const server = route.connectToServer();
    route.onMessage(data => {
      if (!dropClient || !dropClient({ url, data })) server.send(data);
    });
    server.onMessage(data => {
      if (!dropServer || !dropServer({ url, data })) route.send(data);
    });
  });
}

module.exports = {
  assertQaRoomName,
  makeQaRoom,
  qaRoomUrl,
  installQaWebSocketGuard
};
