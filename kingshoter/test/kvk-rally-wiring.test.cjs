const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'kvk.html'), 'utf8');
const kvk = fs.readFileSync(path.join(root, 'public', 'kvk.js'), 'utf8');
const BUILD = '2026071501';
const rallyModule = { exports: {} };
require('node:vm').runInNewContext(
  fs.readFileSync(path.join(root, 'public', 'kvk-rally.js'), 'utf8'),
  { module: rallyModule, exports: rallyModule.exports, globalThis: {} }
);
const rally = rallyModule.exports;

function count(source, token) {
  return source.split(token).length - 1;
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '{') depth += 1;
    if (character === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated ${name}`);
}

function loadRallyAdapter(KvkRally, KvkUpdate) {
  const start = kvk.indexOf('var fallbackRallyApi =');
  const end = kvk.indexOf('// Captains receive', start);
  assert.ok(start >= 0 && end > start, 'rally adapter must remain extractable');
  const context = { window: { KvkRally, KvkUpdate }, Number };
  require('node:vm').runInNewContext(kvk.slice(start, end), context);
  return context;
}

test('the shared rally generation loads exactly once before the KvK runtime', () => {
  const tag = `<script src="/kvk-rally.js?v=${BUILD}"></script>`;
  const rally = html.indexOf(tag);
  const runtime = html.indexOf(`<script src="/kvk.js?v=${BUILD}"></script>`);
  assert.equal(count(html, tag), 1);
  assert.ok(rally >= 0 && rally < runtime);
});

test('optional rally loading fails closed while a complete runtime advertises its build', () => {
  assert.match(kvk, /tripleClientAvailable/);
  assert.match(kvk, /typeof [^\n]*\.isRallyCommand === ["']function["']/);
  assert.match(kvk, /typeof [^\n]*\.targetFor === ["']function["']/);
  assert.match(kvk, /typeof [^\n]*\.rolesForMode === ["']function["']/);
  assert.match(kvk, /typeof [^\n]*\.reconcilePicks === ["']function["']/);
  assert.match(kvk, /rallyCandidate\.BUILD/);
  assert.match(kvk, /function isRallyCommand\(/);
  assert.match(kvk, /function myTarget\([^)]*\)\s*\{[^}]*rallyApi\.targetFor/);
  assert.match(kvk, /new window\.RoomSocket\(ROOM, onState, \{ clientBuild: advertisedKvkBuild \}\)/);
  const connect = kvk.slice(kvk.indexOf('function connect()'), kvk.indexOf('function onState('));
  assert.match(connect, /var advertisedKvkBuild = 0[\s\S]{0,240}window\.KvkUpdate[\s\S]{0,240}tripleClientAvailable[\s\S]{0,240}advertisedKvkBuild = updateBuild/);
});

test('only an exact same-generation rally module enables canonical Triple', () => {
  const complete = (build) => ({
    BUILD: build,
    isRallyCommand: rally.isRallyCommand,
    targetFor: rally.targetFor,
    rolesForMode: rally.rolesForMode,
    reconcilePicks: rally.reconcilePicks,
    selectPlayer: rally.selectPlayer,
    movePlayerToRole: rally.movePlayerToRole
  });
  assert.equal(loadRallyAdapter(complete(2026071501), { BUILD: 2026071501 }).tripleClientAvailable, true);
  assert.equal(loadRallyAdapter(complete(2026071302), { BUILD: 2026071501 }).tripleClientAvailable, false);
  assert.equal(loadRallyAdapter({ ...complete(2026071501), BUILD: undefined }, { BUILD: 2026071501 }).tripleClientAvailable, false);
  const hostile = complete(2026071501);
  Object.defineProperty(hostile, 'BUILD', { get() { throw new Error('mixed rally cache'); } });
  assert.equal(loadRallyAdapter(hostile, { BUILD: 2026071501 }).tripleClientAvailable, false);
});

test('myTarget rejects hostile module return shapes and uses the safe canonical fallback', () => {
  const hostile = {
    BUILD: 2026071501,
    isRallyCommand: rally.isRallyCommand,
    targetFor() { return { anchor: '12', mine: true, role: 'weak2' }; },
    rolesForMode: rally.rolesForMode,
    reconcilePicks: rally.reconcilePicks,
    selectPlayer: rally.selectPlayer,
    movePlayerToRole: rally.movePlayerToRole
  };
  const context = loadRallyAdapter(hostile, { BUILD: 2026071501 });
  context.myPid = 'captain';
  require('node:vm').runInNewContext(`${extractFunction(kvk, 'myTarget')}`, context);
  const command = {
    type: 'double_rally', anchorUTC: 10,
    payload: { firstPress: 10, rallySize: 3, pairs: [{ pid: 'captain', role: 'weak2', pressUTC: 12 }] }
  };
  assert.deepEqual(JSON.parse(JSON.stringify(context.myTarget(command))),
    { anchor: 12, mine: true, role: 'weak2' });
});

test('socket build advertisement is current only for a complete shared runtime', () => {
  function advertised(tripleClientAvailable, KvkUpdate, rallyClientBuild = 2026071501) {
    let options = null;
    const context = {
      ROOM: 'qa-kvk-rally-build',
      KvkUpdate,
      tripleClientAvailable,
      rallyClientBuild,
      initDeliveryShadow() {},
      onState() {},
      window: {
        KvkUpdate,
        RoomSocket: class {
          constructor(room, onState, value) {
            options = value;
          }
        }
      }
    };
    require('node:vm').runInNewContext(`${extractFunction(kvk, 'connect')}; connect();`, context);
    return options.clientBuild;
  }

  assert.equal(advertised(true, { BUILD: 2026071501 }), 2026071501);
  assert.equal(advertised(false, { BUILD: 2026071501 }), 0);
  assert.equal(advertised(true, { BUILD: 2026071501 }, 2026071302), 0);
  assert.equal(advertised(true, null), 0);
  assert.equal(advertised(true, { BUILD: '2026071501' }), 0);
  const hostile = {};
  Object.defineProperty(hostile, 'BUILD', { get() { throw new Error('mixed cache'); } });
  assert.equal(advertised(true, hostile), 0);
});

test('every rally consumer shares Triple-aware predicates without changing Double construction', () => {
  assert.match(kvk, /if \(isRallyCommand\(c\) && Number\.isFinite\(firstPress\)/);
  assert.match(kvk, /if \(join && isRallyCommand\(join\)\) \{/);
  assert.match(kvk, /function announceCmd\([\s\S]{0,420}if \(isRallyCommand\(c\)\)/);
  assert.match(kvk, /if \(isRallyCommand\(c\) && tg\.mine && rem <= countdownLead/);
  assert.match(kvk, /if \(c && isRallyCommand\(c\) && c\.payload/);
  assert.match(kvk, /if \(!personal && canJoin\)/,
    'the ordinary-member join audience guard remains intact');
  assert.doesNotMatch(kvk, /\.type\s*[!=]==?\s*["']double_rally["']/,
    'no runtime predicate may silently exclude Triple');
  assert.equal(count(kvk, 'type: "double_rally"'), 2,
    'only simulation and the unchanged Double fire payload construct Double directly');
});

test('only the selected active JOIN sequence survives command changes', () => {
  const stopped = [];
  const context = {
    scheduledBeeps: {
      'old-join:10': { base: 'old-join' },
      'current-join:10': { base: 'current-join' },
      'current-join:9': { base: 'current-join' },
      'captain-me:10': { base: 'captain-me' }
    },
    stopCue(cue) { stopped.push(cue.base); }
  };
  require('node:vm').runInNewContext(extractFunction(kvk, 'cancelJoinCues'), context);
  context.cancelJoinCues('current-join');
  assert.deepEqual(Object.keys(context.scheduledBeeps).sort(), [
    'captain-me:10', 'current-join:10', 'current-join:9'
  ]);
  assert.deepEqual(stopped, ['old-join']);
  context.cancelJoinCues();
  assert.deepEqual(Object.keys(context.scheduledBeeps), ['captain-me:10']);
});

test('commander unlock is synchronously silent and Classic ACKs accept only rallies', () => {
  const openCmd = extractFunction(kvk, 'openCmd');
  assert.match(openCmd, /classList\.add\(["']cmdmode["']\)[\s\S]{0,180}cancelJoinCues\(\)/,
    'unlocking must cancel already scheduled member JOIN audio without waiting for tick');
  const acknowledge = extractFunction(kvk, 'acknowledgeClassicCommand');
  assert.match(acknowledge, /if \(!isRallyCommand\(command\)\) return false/);
  assert.match(kvk, /var joinKey = join\.id \+ ["']-join["'][\s\S]{0,120}cancelJoinCues\(joinKey\)[\s\S]{0,120}scheduleBeeps\(joinKey/,
    'a command change must remove every obsolete JOIN sequence before booking the selected one');
});

test('production cue routing gives all three captains one exact personal sequence', () => {
  const command = {
    id: 'triple-cue-a',
    type: 'triple_rally',
    anchorUTC: 1_010,
    payload: {
      firstPress: 1_010,
      leadSeconds: 10,
      pairs: [
        { pid: 'weak-a', role: 'weak', pressUTC: 1_010 },
        { pid: 'weak-b', role: 'weak2', pressUTC: 1_012 },
        { pid: 'main-c', role: 'main', pressUTC: 1_011 }
      ]
    }
  };

  function route(pid, commander) {
    const cues = new Map();
    const context = {
      room: { live: { commands: { 1: command } } },
      reconcileCues() {},
      pruneDeliveryAckState() {},
      liveCommands: () => [command],
      myTarget: (value) => rally.targetFor(value, pid),
      isRallyCommand: rally.isRallyCommand,
      scheduleBeeps(base, anchor) { cues.set(base, anchor); },
      schedulePrepareCue() {},
      acknowledgeClassicCommand() {},
      shouldBookJoinAudio: () => !!pid && !commander,
      cancelJoinCues(keepBase) {
        for (const base of [...cues.keys()]) {
          if (base.endsWith('-join') && base !== keepBase) cues.delete(base);
        }
      },
      activeCommand: () => command,
      Number
    };
    require('node:vm').runInNewContext(extractFunction(kvk, 'scheduleAllCues'), context);
    context.scheduleAllCues();
    context.scheduleAllCues();
    return cues;
  }

  for (const pair of command.payload.pairs) {
    const cues = route(pair.pid, false);
    assert.deepEqual([...cues.entries()], [[`${command.id}-me`, pair.pressUTC]],
      `${pair.role} must receive only their immutable personal target`);
  }
  assert.deepEqual([...route('ordinary-member', false).entries()], [[`${command.id}-join`, 1_010]]);
  assert.deepEqual([...route('unselected-commander', true).entries()], []);
  assert.deepEqual([...route('weak-b', true).entries()], [[`${command.id}-me`, 1_012]],
    'a commander hears a rally only when this device is a selected captain');
});
