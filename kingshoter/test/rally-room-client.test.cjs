const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/rally-room.js'), 'utf8');
const sandbox = { module: { exports: {} }, crypto: { randomUUID: () => 'generated' } };
vm.runInNewContext(source, sandbox);
const RallyRoom = sandbox.module.exports;
const plain = value => JSON.parse(JSON.stringify(value));

function room(name1 = '', revision1 = 0, name2 = '', revision2 = 0) {
  return {
    rallyRoom: {
      kingdomNames: {
        1: { name: name1, revision: revision1 },
        2: { name: name2, revision: revision2 }
      },
      managerMeta: { connectedWebsiteDevices: 3 }
    }
  };
}

test('RallyRoom exposes a frozen UMD surface with truthful kingdom fallbacks', () => {
  assert.equal(Object.isFrozen(RallyRoom), true);
  assert.deepEqual(plain(RallyRoom.kingdomRecord(room('Alpha', 4), 1)), { name: 'Alpha', revision: 4 });
  assert.deepEqual(plain(RallyRoom.kingdomRecord({}, 2)), { name: '', revision: 0 });
  assert.equal(RallyRoom.kingdomLabel(room('Alpha', 4), 1, 'Kingdom 1'), 'Alpha');
  assert.equal(RallyRoom.kingdomLabel(room(), 2, 'Kingdom 2'), 'Kingdom 2');
  assert.equal(RallyRoom.connectedWebsiteDevices(room()), 3);
  assert.equal(RallyRoom.connectedWebsiteDevices({}), 0);
});

test('kingdom drafts normalize spacing and controls but reject more than 24 visible characters', () => {
  const family = '👩‍👩‍👧‍👧';
  assert.deepEqual(plain(RallyRoom.validateKingdomName('  K  1406  ')), { ok: true, name: 'K 1406' });
  assert.deepEqual(plain(RallyRoom.validateKingdomName('K\t1406')), { ok: true, name: 'K 1406' });
  assert.deepEqual(plain(RallyRoom.validateKingdomName('')), { ok: true, name: '' });
  assert.deepEqual(plain(RallyRoom.validateKingdomName('\u202eAlpha\u0000')), { ok: true, name: 'Alpha' });
  assert.deepEqual(plain(RallyRoom.validateKingdomName('a'.repeat(25))), { ok: false, error: 'invalid_kingdom_name' });
  assert.deepEqual(plain(RallyRoom.validateKingdomName(family.repeat(24))), {
    ok: true, name: family.repeat(24)
  });
  assert.deepEqual(plain(RallyRoom.validateKingdomName(family.repeat(25))), {
    ok: false, error: 'invalid_kingdom_name'
  });
});

test('roomURL creates a canonical same-origin Rally link with an encoded allowlisted room', () => {
  assert.equal(
    RallyRoom.roomURL({ origin: 'https://kingshoter.com' }, 'qa room/unsafe'),
    'https://kingshoter.com/rally?room=qaroomunsafe'
  );
  assert.equal(RallyRoom.roomURL({ origin: 'https://kingshoter.com' }, ''), 'https://kingshoter.com/rally');
});

test('name mutation settles only after its exact receipt and canonical state both arrive', () => {
  const sent = [], changes = [];
  const controller = RallyRoom.createNameMutation({
    send: message => (sent.push(message), true),
    createMutationId: () => 'mutation-a',
    onChange: state => changes.push(state)
  });

  assert.equal(controller.request({ kingdom: 1, name: 'Alpha', baseRevision: 2, password: 'qa' }), true);
  assert.deepEqual(plain(sent[0]), {
    t: 'setKingdomName', mutationId: 'mutation-a', password: 'qa',
    kingdom: 1, name: 'Alpha', baseRevision: 2
  });
  assert.equal(controller.handleState(room('Alpha', 3)), false, 'state alone cannot claim success');
  assert.equal(controller.snapshot().pending.stateSeen, true);
  assert.equal(controller.handleMessage({
    t: 'kingdomNameSaved', mutationId: 'mutation-a', kingdom: 1, name: 'Alpha', revision: 3
  }), true);
  assert.equal(controller.snapshot().pending, null);
  assert.deepEqual(plain(controller.snapshot().outcome), {
    status: 'saved', kingdom: 1, name: 'Alpha', revision: 3
  });
  assert.equal(changes.some(change => change.outcome && change.outcome.status === 'saved'), true);
});

test('receipt-first convergence waits for state and ignores unrelated receipts', () => {
  const controller = RallyRoom.createNameMutation({ send: () => true, createMutationId: () => 'mutation-b' });
  controller.request({ kingdom: 2, name: 'Beta', baseRevision: 8, password: 'qa' });
  assert.equal(controller.handleMessage({
    t: 'kingdomNameSaved', mutationId: 'other', kingdom: 2, name: 'Beta', revision: 9
  }), false);
  assert.equal(controller.handleMessage({
    t: 'kingdomNameSaved', mutationId: 'mutation-b', kingdom: 2, name: 'Beta', revision: 9
  }), true);
  assert.notEqual(controller.snapshot().pending, null);
  assert.equal(controller.handleState(room('', 0, 'Beta', 9)), true);
  assert.equal(controller.snapshot().outcome.status, 'saved');
});

test('reconnect replays the exact frozen mutation and a conflict preserves the submitted draft', () => {
  const sent = [];
  const controller = RallyRoom.createNameMutation({
    send: message => (sent.push(message), true),
    createMutationId: () => 'mutation-c'
  });
  controller.request({ kingdom: 1, name: 'My draft', baseRevision: 1, password: 'qa' });
  controller.disconnected();
  assert.equal(controller.connected(), true);
  assert.equal(sent.length, 2);
  assert.deepEqual(plain(sent[1]), plain(sent[0]));
  assert.equal(Object.isFrozen(sent[1]), true);

  assert.equal(controller.handleMessage({
    t: 'error', error: 'kingdom_name_conflict', mutationId: 'mutation-c', kingdom: 1,
    record: { name: 'Their name', revision: 2 }
  }), true);
  assert.equal(controller.snapshot().pending, null);
  assert.deepEqual(plain(controller.snapshot().outcome), {
    status: 'conflict', kingdom: 1, name: 'My draft',
    canonical: { name: 'Their name', revision: 2 }
  });
});

test('failed initial send remains replayable while bad password invalidates the pending request', () => {
  let connected = false;
  const sent = [];
  const controller = RallyRoom.createNameMutation({
    send(message) { sent.push(message); return connected; },
    createMutationId: () => 'mutation-d'
  });
  assert.equal(controller.request({ kingdom: 1, name: 'Alpha', baseRevision: 0, password: 'qa' }), true);
  assert.equal(controller.snapshot().pending.status, 'retry');
  connected = true;
  assert.equal(controller.connected(), true);
  assert.equal(controller.snapshot().pending.status, 'saving');
  assert.equal(sent.length, 2);
  assert.equal(controller.handleMessage({ t: 'error', error: 'bad_password', mutationId: 'mutation-d' }), true);
  assert.equal(controller.snapshot().pending, null);
  assert.equal(controller.snapshot().outcome.status, 'bad_password');
});

test('name mutation rejects an invalid kingdom rather than silently targeting Kingdom 1', () => {
  const sent = [];
  const controller = RallyRoom.createNameMutation({
    send: message => (sent.push(message), true), createMutationId: () => 'mutation-e'
  });
  assert.equal(controller.request({ kingdom: 3, name: 'Wrong', baseRevision: 0, password: 'qa' }), false);
  assert.equal(sent.length, 0);
  assert.equal(controller.snapshot().pending, null);
});
