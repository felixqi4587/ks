const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/kvk.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (character === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated ${name}`);
}

const roomFixture = {
  players: Object.fromEntries(Array.from({ length: 8 }, (_, index) => {
    const pid = `captain-${index + 1}`;
    return [pid, { name: `Captain ${index + 1}`, march: 20 * (index + 1) }];
  })),
  rallyModes: {
    1: { mode: 'triple', revision: 1 },
    2: { mode: 'triple', revision: 1 }
  },
  live: { commands: { 1: null, 2: null }, staged: { 1: null, 2: null } }
};

const stagedFixture = {
  1: [
    { pid: 'captain-1', name: 'Captain 1', march: 20, role: 'weak' },
    { pid: 'captain-2', name: 'Captain 2', march: 40, role: 'weak2' },
    { pid: 'captain-3', name: 'Captain 3', march: 60, role: 'main' }
  ],
  2: [
    { pid: 'captain-4', name: 'Captain 4', march: 80, role: 'weak' },
    { pid: 'captain-5', name: 'Captain 5', march: 100, role: 'weak2' },
    { pid: 'captain-6', name: 'Captain 6', march: 120, role: 'main' }
  ]
};

function loadMapHarness(room = roomFixture) {
  const sandbox = {
    room,
    serverStagedByK: structuredClone(stagedFixture),
    myPid: 'captain-1',
    ATK_GATHER: 300,
    MARCH_MIN_SECONDS: 5,
    MARCH_MAX_SECONDS: 120
  };
  sandbox.activeCommand = current => current.live.commands[1] || current.live.commands[2] || null;
  sandbox.isRallyCommand = command => ['double_rally', 'triple_rally'].includes(command && command.type);
  sandbox.rallyMode = kingdom => sandbox.room.rallyModes[kingdom].mode;
  sandbox.requiredCaptains = kingdom => sandbox.rallyMode(kingdom) === 'triple' ? 3 : 2;
  sandbox.commandUsesTripleRoles = command => command && command.type === 'triple_rally';
  vm.runInNewContext(
    `${extractFunction('mapData')}\n${extractFunction('domainFor')}\n${extractFunction('ringR')}\n` +
      'this.mapData = mapData; this.domainFor = domainFor; this.ringR = ringR;',
    sandbox
  );
  return sandbox;
}

const plain = value => JSON.parse(JSON.stringify(value));

test('idle tactical projection groups only staged captains by kingdom', () => {
  const data = loadMapHarness().mapData();

  assert.ok(Array.isArray(data.groups), 'idle projection exposes kingdom groups');
  assert.deepEqual(plain(data.groups.map(group => ({
    kingdom: group.kingdom,
    mode: group.mode,
    required: group.required,
    pids: group.actors.map(actor => actor.pid),
    roles: group.actors.map(actor => actor.role)
  }))), [
    { kingdom: 1, mode: 'triple', required: 3,
      pids: ['captain-1', 'captain-2', 'captain-3'], roles: ['weak', 'weak2', 'main'] },
    { kingdom: 2, mode: 'triple', required: 3,
      pids: ['captain-4', 'captain-5', 'captain-6'], roles: ['weak', 'weak2', 'main'] }
  ]);
  assert.deepEqual(plain(data.actors.map(actor => actor.pid)), [
    'captain-1', 'captain-2', 'captain-3', 'captain-4', 'captain-5', 'captain-6'
  ]);
  assert.equal(data.actors.some(actor => actor.pid === 'captain-7' || actor.pid === 'captain-8'), false);
});

test('live tactical projection remains frozen to command pairs and one kingdom group', () => {
  const frozen = Object.freeze({
    id: 'triple-command-2',
    type: 'triple_rally',
    kingdom: 2,
    anchorUTC: 1_000,
    expiresUTC: 1_600,
    payload: Object.freeze({
      kingdom: 2,
      firstPress: 960,
      leadSeconds: 10,
      pairs: Object.freeze([
        Object.freeze({ pid: 'captain-4', name: 'Frozen Weak', march: 81, role: 'weak', pressUTC: 1_000 }),
        Object.freeze({ pid: 'captain-5', name: 'Frozen Second', march: 101, role: 'weak2', pressUTC: 980 }),
        Object.freeze({ pid: 'captain-6', name: 'Frozen Main', march: 121, role: 'main', pressUTC: 960 })
      ])
    })
  });
  const liveRoom = structuredClone(roomFixture);
  liveRoom.live.commands[2] = frozen;

  const data = loadMapHarness(liveRoom).mapData();
  const actors = data.actors.map(actor => ({
    pid: actor.pid, name: actor.name, march: actor.march, role: actor.role
  }));

  assert.deepEqual(plain(actors), [
    { pid: 'captain-4', name: 'Frozen Weak', march: 81, role: 'weak' },
    { pid: 'captain-5', name: 'Frozen Second', march: 101, role: 'weak2' },
    { pid: 'captain-6', name: 'Frozen Main', march: 121, role: 'main' }
  ]);
  assert.ok(Array.isArray(data.groups), 'live projection exposes its command kingdom group');
  assert.equal(data.groups.length, 1);
  assert.equal(data.groups[0].kingdom, 2);
  assert.equal(data.groups[0].mode, 'triple');
  assert.equal(data.groups[0].required, 3);
  assert.deepEqual(plain(data.groups[0].actors.map(actor => ({
    pid: actor.pid, name: actor.name, march: actor.march, role: actor.role
  }))), plain(actors));
});

test('idle battlefield geometry uses the fixed scale and approved ring radius', () => {
  const { domainFor, ringR } = loadMapHarness();

  assert.equal(domainFor([20, 120], false), 120);
  assert.equal(ringR(120, 120), 180);
  assert.ok(ringR(5, 120) >= 48);
});
