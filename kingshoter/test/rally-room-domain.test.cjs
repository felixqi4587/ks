const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadDomain() {
  const url = pathToFileURL(path.join(__dirname, '..', 'src', 'rally-room-domain.js'));
  url.searchParams.set('testRun', `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

test('Rally room names normalize visible Unicode without splitting a grapheme', async () => {
  const domain = await loadDomain();
  const family = '👩‍👩‍👧‍👧';
  const long = `${family.repeat(24)}TAIL`;

  assert.equal(domain.normalizeKingdomDisplayName('  Moon\t Kingdom  '), 'Moon Kingdom');
  assert.equal(domain.normalizeKingdomDisplayName('\u200b\u202e  '), '');
  assert.equal([...domain.normalizeKingdomDisplayName(long)].join(''), family.repeat(24));
  assert.deepEqual(domain.validateKingdomDisplayName(family.repeat(24)), {
    ok: true, name: family.repeat(24)
  });
  assert.deepEqual(domain.validateKingdomDisplayName(`${family.repeat(24)}X`), {
    ok: false, error: 'invalid_kingdom_name'
  });
  assert.equal(domain.displayKingdomName({ name: '' }, 1), 'Kingdom 1');
  assert.equal(domain.displayKingdomName({ name: '  K1406  ' }, 2), 'K1406');
});

test('Rally room state gives each kingdom an independent legacy-safe revision', async () => {
  const domain = await loadDomain();
  const state = domain.normalizeRallyRoomState({
    kingdomNames: {
      1: { name: 'Alpha', revision: 4 },
      2: { name: '\u200b', revision: -2 }
    },
    mutationReceipts: [
      { mutationId: '', type: 'kingdomName' },
      {
        mutationId: 'forged-negative', type: 'kingdomName',
        fingerprint: '["kingdomName",1,"Alpha",0]',
        receipt: {
          t: 'kingdomNameSaved', mutationId: 'forged-negative',
          kingdom: 1, name: 'Alpha', revision: -1
        }
      }
    ]
  });

  assert.deepEqual(state.kingdomNames, {
    1: { name: 'Alpha', revision: 4 },
    2: { name: '', revision: 0 }
  });
  assert.deepEqual(state.mutationReceipts, []);

  const changed = domain.transitionKingdomName(state, {
    kingdom: 2, name: 'Beta', baseRevision: 0
  });
  assert.equal(changed.ok, true);
  assert.deepEqual(changed.record, { name: 'Beta', revision: 1 });
  assert.deepEqual(changed.rallyRoom.kingdomNames[1], { name: 'Alpha', revision: 4 });
  assert.deepEqual(changed.rallyRoom.kingdomNames[2], { name: 'Beta', revision: 1 });

  const stale = domain.transitionKingdomName(changed.rallyRoom, {
    kingdom: 2, name: 'Stale', baseRevision: 0
  });
  assert.deepEqual(stale, {
    ok: false,
    error: 'kingdom_name_conflict',
    record: { name: 'Beta', revision: 1 }
  });
});

test('Rally mutation receipts replay exactly, reject ID reuse, and stay bounded', async () => {
  const domain = await loadDomain();
  let state = domain.normalizeRallyRoomState();
  const fingerprint = domain.rallyMutationFingerprint('kingdomName', [1, 'Alpha', 0]);
  const receipt = {
    t: 'kingdomNameSaved', mutationId: 'name-1', kingdom: 1,
    name: 'Alpha', revision: 1
  };

  assert.deepEqual(domain.inspectRallyMutation(state, {
    mutationId: 'name-1', type: 'kingdomName', fingerprint
  }), { status: 'new' });
  state = domain.rememberRallyMutation(state, {
    mutationId: 'name-1', type: 'kingdomName', fingerprint, receipt
  });
  assert.deepEqual(domain.inspectRallyMutation(state, {
    mutationId: 'name-1', type: 'kingdomName', fingerprint
  }), { status: 'replay', receipt });
  assert.deepEqual(domain.inspectRallyMutation(state, {
    mutationId: 'name-1', type: 'kingdomName',
    fingerprint: domain.rallyMutationFingerprint('kingdomName', [1, 'Other', 0])
  }), { status: 'conflict', error: 'mutation_id_conflict' });

  for (let index = 0; index < domain.RALLY_MUTATION_RECEIPT_LIMIT + 5; index += 1) {
    const mutationId = `bounded-${index}`;
    state = domain.rememberRallyMutation(state, {
      mutationId,
      type: 'rallyMode',
      fingerprint: domain.rallyMutationFingerprint('rallyMode', [1, 'double', index]),
      receipt: { t: 'rallyModeSaved', mutationId, kingdom: 1, mode: 'double', revision: index }
    });
  }
  assert.equal(state.mutationReceipts.length, domain.RALLY_MUTATION_RECEIPT_LIMIT);
  assert.equal(state.mutationReceipts.at(0).mutationId, 'bounded-5');
  assert.equal(state.mutationReceipts.at(-1).mutationId,
    `bounded-${domain.RALLY_MUTATION_RECEIPT_LIMIT + 4}`);
});

test('Rally room projection exposes live website-device count but no private receipt ledger', async () => {
  const domain = await loadDomain();
  const rallyRoom = domain.rememberRallyMutation(domain.normalizeRallyRoomState(), {
    mutationId: 'private-1',
    type: 'kingdomName',
    fingerprint: domain.rallyMutationFingerprint('kingdomName', [1, 'Alpha', 0]),
    receipt: { t: 'kingdomNameSaved', mutationId: 'private-1', kingdom: 1, name: 'Alpha', revision: 1 }
  });
  const projected = domain.projectRallyRoomState(rallyRoom, 37);

  assert.deepEqual(projected, {
    kingdomNames: {
      1: { name: '', revision: 0 },
      2: { name: '', revision: 0 }
    },
    managerMeta: { connectedWebsiteDevices: 37 }
  });
  assert.equal(JSON.stringify(projected).includes('private-1'), false);
});
