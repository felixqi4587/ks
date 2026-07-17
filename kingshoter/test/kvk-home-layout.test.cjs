const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/kvk.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../public/kvk.js'), 'utf8');
const tacticalSource = fs.readFileSync(path.join(__dirname, '../public/rally-tactical.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/app.css'), 'utf8');

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
    return [pid, { name: `Canonical Captain ${index + 1}`, march: 111 + index }];
  })),
  rallyModes: {
    1: { mode: 'triple', revision: 1 },
    2: { mode: 'triple', revision: 1 }
  },
  live: { commands: { 1: null, 2: null }, staged: { 1: null, 2: null } }
};

// Display fields are deliberately stale: selection/order/role come from staging,
// while canonical name/march must come from room.players.
const stagedFixture = {
  1: [
    { pid: 'captain-1', name: 'Stale Stage 1', march: 20, role: 'weak' },
    { pid: 'captain-2', name: 'Stale Stage 2', march: 40, role: 'weak2' },
    { pid: 'captain-3', name: 'Stale Stage 3', march: 60, role: 'main' }
  ],
  2: [
    { pid: 'captain-4', name: 'Stale Stage 4', march: 80, role: 'weak' },
    { pid: 'captain-5', name: 'Stale Stage 5', march: 100, role: 'weak2' },
    { pid: 'captain-6', name: 'Stale Stage 6', march: 120, role: 'main' }
  ]
};

function loadMapHarness(room = roomFixture) {
  const sandbox = {
    room,
    serverStagedByK: structuredClone(stagedFixture),
    myPid: 'captain-1',
    ATK_GATHER: 300,
    FIELD_RADIUS: 120,
    MARCH_MIN_SECONDS: 5,
    MARCH_MAX_SECONDS: 120
  };
  sandbox.isRallyCommand = command => ['double_rally', 'triple_rally'].includes(command && command.type);
  sandbox.rallyMode = kingdom => sandbox.room.rallyModes[kingdom].mode;
  sandbox.requiredCaptains = kingdom => sandbox.rallyMode(kingdom) === 'triple' ? 3 : 2;
  sandbox.commandUsesTripleRoles = command => command && command.type === 'triple_rally';
  vm.runInNewContext(tacticalSource, sandbox);
  sandbox.rallyTactical = sandbox.RallyTactical;
  vm.runInNewContext(
    `${extractFunction('liveCommands')}\n${extractFunction('activeCommand')}\n` +
      `${extractFunction('mapData')}\n${extractFunction('domainFor')}\n${extractFunction('ringR')}\n` +
      'this.activeCommand = activeCommand; this.mapData = mapData; ' +
      'this.domainFor = domainFor; this.ringR = ringR;',
    sandbox
  );
  return sandbox;
}

const plain = value => JSON.parse(JSON.stringify(value));

test('compact ready copy removes the redundant idle line and keeps healthy audio status on one line', () => {
  assert.doesNotMatch(html, /id="idleWait"/);
  assert.doesNotMatch(source, /idle_wait:/);
  assert.match(source, /as_on: "🔊 提醒已开启 · 可切回游戏"/);
  assert.match(source, /as_on: "🔊 Alerts on · switch to game"/);
  assert.match(css, /\.astat\{[^}]*white-space:nowrap[^}]*overflow:hidden[^}]*text-overflow:ellipsis/);
});

test('idle tactical projection groups only staged captains by kingdom', () => {
  const data = loadMapHarness().mapData();

  assert.equal(data.live, false);
  assert.ok(Array.isArray(data.groups), 'idle projection exposes kingdom groups');
  assert.deepEqual(plain(data.groups.map(group => ({
    kingdom: group.kingdom,
    mode: group.mode,
    required: group.required,
    actors: group.actors.map(actor => ({
      pid: actor.pid,
      name: actor.name,
      march: actor.march,
      role: actor.role,
      mine: actor.mine,
      kingdom: actor.kingdom
    }))
  }))), [
    { kingdom: 1, mode: 'triple', required: 3,
      actors: [
        { pid: 'captain-1', name: 'Canonical Captain 1', march: 111, role: 'weak', mine: true, kingdom: 1 },
        { pid: 'captain-2', name: 'Canonical Captain 2', march: 112, role: 'weak2', mine: false, kingdom: 1 },
        { pid: 'captain-3', name: 'Canonical Captain 3', march: 113, role: 'main', mine: false, kingdom: 1 }
      ] },
    { kingdom: 2, mode: 'triple', required: 3,
      actors: [
        { pid: 'captain-4', name: 'Canonical Captain 4', march: 114, role: 'weak', mine: false, kingdom: 2 },
        { pid: 'captain-5', name: 'Canonical Captain 5', march: 115, role: 'weak2', mine: false, kingdom: 2 },
        { pid: 'captain-6', name: 'Canonical Captain 6', march: 116, role: 'main', mine: false, kingdom: 2 }
      ] }
  ]);
  assert.deepEqual(plain(data.actors.map(actor => ({
    pid: actor.pid,
    name: actor.name,
    march: actor.march,
    role: actor.role,
    mine: actor.mine,
    kingdom: actor.kingdom
  }))), [
    { pid: 'captain-1', name: 'Canonical Captain 1', march: 111, role: 'weak', mine: true, kingdom: 1 },
    { pid: 'captain-2', name: 'Canonical Captain 2', march: 112, role: 'weak2', mine: false, kingdom: 1 },
    { pid: 'captain-3', name: 'Canonical Captain 3', march: 113, role: 'main', mine: false, kingdom: 1 },
    { pid: 'captain-4', name: 'Canonical Captain 4', march: 114, role: 'weak', mine: false, kingdom: 2 },
    { pid: 'captain-5', name: 'Canonical Captain 5', march: 115, role: 'weak2', mine: false, kingdom: 2 },
    { pid: 'captain-6', name: 'Canonical Captain 6', march: 116, role: 'main', mine: false, kingdom: 2 }
  ]);
  assert.equal(data.actors.some(actor => actor.pid === 'captain-7' || actor.pid === 'captain-8'), false);
});

test('live tactical projection keeps both kingdoms frozen to their command pairs', () => {
  const decoy = Object.freeze({
    id: 'triple-command-1',
    type: 'triple_rally',
    kingdom: 1,
    anchorUTC: 900,
    expiresUTC: 1_500,
    payload: Object.freeze({
      kingdom: 1,
      firstPress: 860,
      leadSeconds: 10,
      pairs: Object.freeze([
        Object.freeze({ pid: 'captain-2', name: 'Decoy Weak', march: 22, role: 'weak', pressUTC: 900 }),
        Object.freeze({ pid: 'captain-3', name: 'Decoy Second', march: 42, role: 'weak2', pressUTC: 880 }),
        Object.freeze({ pid: 'captain-4', name: 'Decoy Main', march: 62, role: 'main', pressUTC: 860 })
      ])
    })
  });
  const preferred = Object.freeze({
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
        Object.freeze({ pid: 'captain-1', name: 'Frozen Weak', march: 81, role: 'weak', pressUTC: 1_000 }),
        Object.freeze({ pid: 'captain-5', name: 'Frozen Second', march: 101, role: 'weak2', pressUTC: 980 }),
        Object.freeze({ pid: 'captain-6', name: 'Frozen Main', march: 121, role: 'main', pressUTC: 960 })
      ])
    })
  });
  const liveRoom = structuredClone(roomFixture);
  liveRoom.live.commands[1] = decoy;
  liveRoom.live.commands[2] = preferred;

  const harness = loadMapHarness(liveRoom);
  assert.equal(harness.activeCommand(liveRoom).id, preferred.id,
    'the existing personal-command priority selects Kingdom 2');
  const data = harness.mapData();
  const actors = data.actors.map(actor => ({
    pid: actor.pid, name: actor.name, march: actor.march, role: actor.role, kingdom: actor.kingdom
  }));

  assert.equal(data.live, true);
  assert.equal(data.id, `${decoy.id}+${preferred.id}`);
  assert.deepEqual(plain(actors), [
    { pid: 'captain-2', name: 'Decoy Weak', march: 22, role: 'weak', kingdom: 1 },
    { pid: 'captain-3', name: 'Decoy Second', march: 42, role: 'weak2', kingdom: 1 },
    { pid: 'captain-4', name: 'Decoy Main', march: 62, role: 'main', kingdom: 1 },
    { pid: 'captain-1', name: 'Frozen Weak', march: 81, role: 'weak', kingdom: 2 },
    { pid: 'captain-5', name: 'Frozen Second', march: 101, role: 'weak2', kingdom: 2 },
    { pid: 'captain-6', name: 'Frozen Main', march: 121, role: 'main', kingdom: 2 }
  ]);
  assert.equal(data.groups.length, 2);
  assert.deepEqual(plain(data.groups.map(group => ({
    kingdom: group.kingdom,
    mode: group.mode,
    required: group.required,
    actors: group.actors.map(actor => actor.pid)
  }))), [
    { kingdom: 1, mode: 'triple', required: 3, actors: ['captain-2', 'captain-3', 'captain-4'] },
    { kingdom: 2, mode: 'triple', required: 3, actors: ['captain-1', 'captain-5', 'captain-6'] }
  ]);
});

test('live tactical projection prefers the canonical kingdom over untrusted payload metadata', () => {
  const maliciousKingdom = '2\" onclick=\"alert(1)';
  const liveRoom = structuredClone(roomFixture);
  liveRoom.live.commands[2] = {
    id: 'double-command-untrusted-kingdom',
    type: 'double_rally',
    kingdom: 2,
    anchorUTC: 1_000,
    expiresUTC: 1_600,
    payload: {
      kingdom: maliciousKingdom,
      firstPress: 980,
      pairs: [
        { pid: 'captain-1', name: 'Frozen Weak', march: 81, role: 'weak', pressUTC: 1_000 },
        { pid: 'captain-6', name: 'Frozen Main', march: 101, role: 'main', pressUTC: 980 }
      ]
    }
  };

  const data = loadMapHarness(liveRoom).mapData();

  assert.equal(data.groups[1].kingdom, 2);
  assert.equal(typeof data.groups[1].kingdom, 'number');
  assert.equal(JSON.stringify(data).includes(maliciousKingdom), false);
});

test('battlefield geometry expands to the exact selected maximum with eight percent headroom', () => {
  const { domainFor, ringR } = loadMapHarness();

  assert.equal(domainFor([], false), 120);
  assert.ok(Math.abs(domainFor([5, 30], false) - 32.4) < 1e-9);
  assert.ok(Math.abs(domainFor([13, 34, 36, 40], false) - 43.2) < 1e-9);
  assert.ok(Math.abs(domainFor([40, 61], false) - 65.88) < 1e-9);
  assert.ok(Math.abs(domainFor([90, 91], false) - 98.28) < 1e-9);
  assert.equal(domainFor([20, 120], false), 120);
  assert.equal(domainFor([20, 121], false), 120);
  assert.equal(ringR(120, 120), 120);
  assert.ok(Math.abs(ringR(60, domainFor([13, 60], false)) - 112.88888888888889) < 1e-9);
  assert.equal(ringR(5, 30), 40);
  assert.ok(ringR(5, 120) < ringR(20, 120), 'short marches keep distinct monotonic radii');
});
