const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRoom, createRoomHarness, claimRoom } = require('./room-harness.cjs');

async function send(harness, socket, message) {
  await harness.room.webSocketMessage(socket, JSON.stringify(message));
}

test('kingdom-name mutations authenticate, revision, persist once, and project canonical Rally metadata', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa' });
  await claimRoom(h);
  const secondRally = h.addSocket('rally');
  h.addSocket('defense');

  await send(h, h.ws, {
    t: 'setKingdomName', password: 'wrong', mutationId: 'name-wrong',
    kingdom: 1, name: 'Alpha', baseRevision: 0
  });
  assert.deepEqual(h.sent.at(-1), {
    t: 'error', error: 'bad_password', mutationId: 'name-wrong'
  });
  assert.deepEqual(h.calls, []);

  h.sent.length = 0;
  await send(h, h.ws, {
    t: 'setKingdomName', password: 'commander-secret', mutationId: 'name-too-long',
    kingdom: 1, name: 'X'.repeat(25), baseRevision: 0
  });
  assert.deepEqual(h.sent.at(-1), {
    t: 'error', error: 'invalid_kingdom_name', mutationId: 'name-too-long', kingdom: 1
  });
  assert.deepEqual(h.calls, []);

  h.sent.length = 0;
  await send(h, h.ws, {
    t: 'setKingdomName', password: 'commander-secret', mutationId: 'name-1',
    kingdom: 1, name: '  Alpha\tForce  ', baseRevision: 0
  });
  const receipt = {
    t: 'kingdomNameSaved', mutationId: 'name-1', kingdom: 1,
    name: 'Alpha Force', revision: 1
  };
  assert.deepEqual(h.sent.at(-1), receipt);
  assert.deepEqual(h.calls, ['persist', 'broadcast']);
  assert.deepEqual(h.room.room.rallyRoom.kingdomNames, {
    1: { name: 'Alpha Force', revision: 1 },
    2: { name: '', revision: 0 }
  });

  const snapshot = h.room.snapshot();
  assert.deepEqual(snapshot.rallyRoom, {
    kingdomNames: {
      1: { name: 'Alpha Force', revision: 1 },
      2: { name: '', revision: 0 }
    },
    managerMeta: { connectedWebsiteDevices: 2 }
  });
  assert.equal(JSON.stringify(snapshot).includes('mutationReceipts'), false);
  assert.equal(Object.hasOwn(snapshot.config, 'enemyWhales'), false);

  Room.prototype.broadcast.call(h.room);
  assert.deepEqual(secondRally.sent.at(-1).room.rallyRoom, snapshot.rallyRoom);
});

test('two managers racing a kingdom name produce one canonical write and a stale revision error', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa' });
  await claimRoom(h);
  const managerB = h.addSocket('rally');

  await Promise.all([
    send(h, h.ws, {
      t: 'setKingdomName', password: 'commander-secret', mutationId: 'race-a',
      kingdom: 2, name: 'Beta A', baseRevision: 0
    }),
    send(h, managerB.ws, {
      t: 'setKingdomName', password: 'commander-secret', mutationId: 'race-b',
      kingdom: 2, name: 'Beta B', baseRevision: 0
    })
  ]);

  assert.equal(h.room.room.rallyRoom.kingdomNames[2].revision, 1);
  assert.deepEqual(h.calls, ['persist', 'broadcast']);
  const outcomes = [...h.sent, ...managerB.sent].filter(frame =>
    frame.t === 'kingdomNameSaved' || frame.error === 'kingdom_name_conflict');
  assert.equal(outcomes.filter(frame => frame.t === 'kingdomNameSaved').length, 1);
  const conflict = outcomes.find(frame => frame.error === 'kingdom_name_conflict');
  assert.deepEqual(conflict.record, h.room.room.rallyRoom.kingdomNames[2]);
});

test('kingdom-name mutation replay returns the exact receipt without another write or broadcast', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa' });
  await claimRoom(h);
  const request = {
    t: 'setKingdomName', password: 'commander-secret', mutationId: 'replay-name',
    kingdom: 1, name: 'Alpha', baseRevision: 0
  };
  await send(h, h.ws, request);
  const originalReceipt = structuredClone(h.sent.at(-1));
  const reconnect = h.addSocket('rally');
  h.reset();

  await send(h, reconnect.ws, request);
  assert.deepEqual(reconnect.sent.at(-1), originalReceipt);
  assert.deepEqual(h.calls, []);
  assert.equal(h.room.room.rallyRoom.kingdomNames[1].revision, 1);

  reconnect.sent.length = 0;
  await send(h, reconnect.ws, { ...request, name: 'Hijack' });
  assert.deepEqual(reconnect.sent.at(-1), {
    t: 'error', error: 'mutation_id_conflict', mutationId: 'replay-name'
  });
  assert.deepEqual(h.calls, []);
});

test('a persisted kingdom-name receipt replays after Durable Object reload without a second write', async () => {
  const { Room } = await loadRoom();
  const first = createRoomHarness(Room, { roomName: 'qa' });
  first.room.persist = Room.prototype.persist.bind(first.room);
  await claimRoom(first);
  const request = {
    t: 'setKingdomName', password: 'commander-secret', mutationId: 'reload-name',
    kingdom: 2, name: 'Beta', baseRevision: 0
  };
  await send(first, first.ws, request);
  const originalReceipt = structuredClone(first.sent.at(-1));
  const storedRoom = first.storage.get('room');
  assert.equal(storedRoom.rallyRoom.mutationReceipts.length, 1);
  assert.equal(Object.hasOwn(storedRoom.rallyRoom, 'managerMeta'), false,
    'live website-device counts are not stored');

  const reloaded = createRoomHarness(Room, {
    roomName: 'qa', storage: first.storage
  });
  reloaded.room._rallyLoaded = false;
  reloaded.room._rallyLoadPromise = null;
  await Room.prototype.ensureRallyLoadedUnlocked.call(reloaded.room);
  reloaded.reset();

  await send(reloaded, reloaded.ws, request);
  assert.deepEqual(reloaded.sent.at(-1), originalReceipt);
  assert.deepEqual(reloaded.calls, []);
  assert.deepEqual(reloaded.storageCalls, []);
  assert.deepEqual(reloaded.room.room.rallyRoom.kingdomNames[2], {
    name: 'Beta', revision: 1
  });
});

test('name success sends its exact receipt before canonical Rally state and replay sends no second state', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa' });
  await claimRoom(h);
  const observer = h.addSocket('rally');
  h.room.broadcast = Room.prototype.broadcast.bind(h.room);
  const request = {
    t: 'setKingdomName', password: 'commander-secret', mutationId: 'ordered-name',
    kingdom: 1, name: 'Alpha', baseRevision: 0
  };

  await send(h, h.ws, request);
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.sent[0], {
    t: 'kingdomNameSaved', mutationId: 'ordered-name', kingdom: 1,
    name: 'Alpha', revision: 1
  });
  assert.equal(h.sent[1].t, 'state');
  assert.deepEqual(h.sent[1].room.rallyRoom.kingdomNames[1], {
    name: 'Alpha', revision: 1
  });
  assert.equal(observer.sent.length, 1);
  assert.equal(observer.sent[0].t, 'state');

  h.sent.length = 0;
  observer.sent.length = 0;
  await send(h, h.ws, request);
  assert.deepEqual(h.sent, [{
    t: 'kingdomNameSaved', mutationId: 'ordered-name', kingdom: 1,
    name: 'Alpha', revision: 1
  }]);
  assert.deepEqual(observer.sent, []);
});

test('setRallyMode uses the same bounded replay ledger without coupling the kingdoms', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, {
    roomName: 'qa', env: { TRIPLE_RALLY_ENABLED: '1' }
  });
  await claimRoom(h);
  const request = {
    t: 'setRallyMode', mutationId: 'mode-replay', password: 'commander-secret',
    kingdom: 1, mode: 'triple', baseRevision: 0
  };
  await send(h, h.ws, request);
  const originalReceipt = structuredClone(h.sent.at(-1));
  h.reset();

  await send(h, h.ws, request);
  assert.deepEqual(h.sent.at(-1), originalReceipt);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.room.room.rallyModes, {
    1: { mode: 'triple', revision: 1 },
    2: { mode: 'double', revision: 0 }
  });

  h.sent.length = 0;
  await send(h, h.ws, { ...request, kingdom: 2 });
  assert.deepEqual(h.sent.at(-1), {
    t: 'error', error: 'mutation_id_conflict', mutationId: 'mode-replay'
  });
  assert.deepEqual(h.calls, []);
});

test('a persisted Rally mode receipt replays after reload without advancing its revision', async () => {
  const { Room } = await loadRoom();
  const first = createRoomHarness(Room, {
    roomName: 'qa', env: { TRIPLE_RALLY_ENABLED: '1' }
  });
  first.room.persist = Room.prototype.persist.bind(first.room);
  await claimRoom(first);
  const request = {
    t: 'setRallyMode', mutationId: 'reload-mode', password: 'commander-secret',
    kingdom: 2, mode: 'triple', baseRevision: 0
  };
  await send(first, first.ws, request);
  const originalReceipt = structuredClone(first.sent.at(-1));

  const reloaded = createRoomHarness(Room, {
    roomName: 'qa', env: { TRIPLE_RALLY_ENABLED: '1' }, storage: first.storage
  });
  reloaded.room._rallyLoaded = false;
  reloaded.room._rallyLoadPromise = null;
  await Room.prototype.ensureRallyLoadedUnlocked.call(reloaded.room);
  reloaded.reset();
  await send(reloaded, reloaded.ws, request);

  assert.deepEqual(reloaded.sent.at(-1), originalReceipt);
  assert.deepEqual(reloaded.room.room.rallyModes[2], { mode: 'triple', revision: 1 });
  assert.deepEqual(reloaded.calls, []);
  assert.deepEqual(reloaded.storageCalls, []);
});

test('legacy enemy-whale config is tolerated in storage but never projected or written by setConfig', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa' });
  h.room.room.config.enemyWhales = [{ name: 'Legacy', mm: 3, ss: 0 }];

  assert.equal(Array.isArray(h.room.room.config.enemyWhales), true,
    'legacy data remains readable in memory for rollback compatibility');
  assert.equal(JSON.stringify(h.room.snapshot()).includes('enemyWhales'), false);

  await claimRoom(h);
  await send(h, h.ws, {
    t: 'setConfig', password: 'commander-secret',
    config: {
      castleName: 'Castle', rallyAllies: [],
      enemyWhales: [{ name: 'Must not persist', mm: 1, ss: 2 }]
    },
    by: 'manager'
  });
  assert.deepEqual(h.room.room.config, { castleName: 'Castle', rallyAllies: [] });
  assert.equal(JSON.stringify(h.room.snapshot()).includes('enemyWhales'), false);
});

test('every Rally room persistence path strips legacy enemy-whale config without mutating rollback memory', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa' });
  h.room.room.config.enemyWhales = [{ name: 'Legacy rollback data', mm: 3, ss: 0 }];

  await Room.prototype.persist.call(h.room);
  assert.equal(Object.hasOwn(h.storage.get('room').config, 'enemyWhales'), false);
  assert.equal(Object.hasOwn(h.room.room.config, 'enemyWhales'), true,
    'in-memory legacy data remains available until this process rolls forward or back');

  h.storageCalls.length = 0;
  await Room.prototype.persistAll.call(h.room);
  assert.equal(Object.hasOwn(h.storage.get('room').config, 'enemyWhales'), false);
  assert.equal(Object.hasOwn(h.room.room.config, 'enemyWhales'), true);
});

test('a new Rally socket immediately refreshes the website-device count for existing Rally clients only', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa' });
  const existing = h.addSocket('rally');
  const defense = h.addSocket('defense');
  h.room.broadcast = Room.prototype.broadcast.bind(h.room);
  h.sent.length = 0; existing.sent.length = 0; defense.sent.length = 0;

  const originalPair = globalThis.WebSocketPair;
  const originalResponse = globalThis.Response;
  class FakeWebSocketPair {
    constructor() {
      let attachment = null;
      this.client = {};
      this.server = {
        readyState: 1,
        send() {},
        serializeAttachment(value) { attachment = structuredClone(value); },
        deserializeAttachment() { return attachment == null ? null : structuredClone(attachment); }
      };
    }
  }
  class FakeResponse { constructor(body, init = {}) { this.body = body; Object.assign(this, init); } }
  globalThis.WebSocketPair = FakeWebSocketPair;
  globalThis.Response = FakeResponse;
  try {
    await h.room.fetch({
      headers: { get: name => name === 'Upgrade' ? 'websocket' : null },
      url: 'https://qa.invalid/api/ws?surface=rally&clientBuild=2026071701'
    });
  } finally {
    globalThis.WebSocketPair = originalPair;
    globalThis.Response = originalResponse;
  }

  assert.equal(h.sent.at(-1).room.rallyRoom.managerMeta.connectedWebsiteDevices, 3);
  assert.equal(existing.sent.at(-1).room.rallyRoom.managerMeta.connectedWebsiteDevices, 3);
  assert.deepEqual(defense.sent, [], 'Defense receives no Rally presence frame');
  assert.deepEqual(h.storageCalls, [], 'presence refresh is write-free');
});

test('Rally room metadata and website-device counts never enter Defense frames or persistence', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa' });
  await claimRoom(h);
  await send(h, h.ws, {
    t: 'setKingdomName', password: 'commander-secret', mutationId: 'isolated-name',
    kingdom: 1, name: 'Rally only', baseRevision: 0
  });
  const defense = h.addSocket('defense');
  h.storageCalls.length = 0;
  await send(h, defense.ws, { t: 'hello' });
  const encodedDefense = JSON.stringify(defense.sent);

  assert.equal(encodedDefense.includes('rallyRoom'), false);
  assert.equal(encodedDefense.includes('kingdomNames'), false);
  assert.equal(encodedDefense.includes('connectedWebsiteDevices'), false);
  assert.deepEqual(h.storageCalls, [], 'transient Rally socket counts are never persisted');
});
