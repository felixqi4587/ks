const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/rally-controller.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `missing ${name}`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function harness() {
  const sent = [];
  const toasts = [];
  const sandbox = {
    fireKingdom: 1,
    lead: 10,
    roomPw: 'pw',
    room: {
      players: {
        weak: { name: 'Weak', march: 31, marchRevision: 2 },
        main: { name: 'Main', march: 35, marchRevision: 4 }
      }
    },
    pickedByK: { 1: [{ pid: 'weak', role: 'weak' }, { pid: 'main', role: 'main' }] },
    pendingStageMutation: null,
    queuedStageByK: { 1: null, 2: null },
    pendingRallyMode: null,
    rallyModeWritable: () => true,
    canonicalPick(pid, role, players) {
      const player = players && players[pid];
      return player ? { pid, role, name: player.name, march: player.march, marchRevision: player.marchRevision } : null;
    },
    pickSignature(list) {
      return list.slice().sort((a, b) => a.role.localeCompare(b.role)).map((pick) => `${pick.role}:${pick.pid}`).join('|');
    },
    fireConfirmationKey() {
      return [sandbox.fireKingdom, 'double', 0, sandbox.lead, sandbox.pickSignature(sandbox.pickedByK[sandbox.fireKingdom])].join('|');
    },
    isReady: () => true,
    gateSync(fn) { sandbox.afterSync = fn; },
    consumeStageForFire() { sandbox.consumed = true; },
    sock: { send(message) { sent.push(message); return true; } },
    tk: (key) => key,
    window: {
      serverNow: () => 1_000_000,
      toast(message) { toasts.push(message); }
    },
    sent,
    toasts,
    afterSync: null,
    consumed: false
  };
  vm.runInNewContext(`${extractFunction('stageIntentBlocksFire')}\n${extractFunction('fireDouble')}\nthis.fireDouble = fireDouble;`, sandbox);
  return sandbox;
}

test('Double aborts when lead changes during asynchronous clock synchronization', () => {
  const h = harness();
  h.fireDouble();
  assert.equal(typeof h.afterSync, 'function');
  h.lead = 60;
  h.afterSync();
  assert.equal(h.sent.length, 0);
  assert.equal(h.toasts.at(-1), 'mode_changed_elsewhere');
  assert.equal(h.consumed, false);
});

test('Double aborts when a confirmed captain march changes during synchronization', () => {
  const h = harness();
  h.fireDouble();
  h.room.players.weak.march = 32;
  h.room.players.weak.marchRevision = 3;
  h.afterSync();
  assert.equal(h.sent.length, 0);
  assert.equal(h.toasts.at(-1), 'mode_changed_elsewhere');
});

test('an unchanged Double snapshot keeps the original timing formula and lead', () => {
  const h = harness();
  h.fireDouble();
  h.afterSync();
  assert.equal(h.sent.length, 1);
  const command = h.sent[0].cmd;
  assert.equal(command.type, 'double_rally');
  assert.equal(command.payload.leadSeconds, 10);
  assert.equal(command.payload.pairs.find((pair) => pair.role === 'main').pressUTC, 1010);
  assert.equal(command.payload.pairs.find((pair) => pair.role === 'weak').pressUTC, 1013);
  assert.equal(h.consumed, true);
});
