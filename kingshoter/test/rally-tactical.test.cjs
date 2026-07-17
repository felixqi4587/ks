const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/rally-tactical.js'), 'utf8');
const sandbox = { module: { exports: {} } };
vm.runInNewContext(source, sandbox);
const RallyTactical = sandbox.module.exports;

const plain = value => JSON.parse(JSON.stringify(value));

test('scale uses the selected maximum with eight percent headroom and a 120 second cap', () => {
  assert.equal(RallyTactical.scaleMax([]), 120);
  assert.equal(RallyTactical.scaleMax([13, 34, 36, 40]), 43.2);
  assert.equal(RallyTactical.scaleMax([4]), 5);
  assert.equal(RallyTactical.scaleMax([120]), 120);
  assert.equal(RallyTactical.scaleMax([9, Number.NaN, -3, 200]), 120);
});

test('the farthest selected actor uses most of the usable radius without touching the edge', () => {
  const scale = RallyTactical.scaleMax([13, 34, 36, 40]);
  assert.ok(Math.abs((40 / scale) - 0.9259259259) < 1e-9);
  assert.equal(RallyTactical.departureRadius(40, scale, 132), 122.22222222222221);
});

test('a castle-safe inner radius preserves every short-march distance instead of collapsing them', () => {
  const radii = [5, 20, 120].map(march =>
    RallyTactical.departureRadius(march, 120, 112, 24));
  assert.deepEqual(radii, [27.666666666666668, 38.666666666666664, 112]);
  assert.ok(radii[0] < radii[1] && radii[1] < radii[2]);
});

test('castle-safe visual spacing still lands differently timed captains at the same scheduled instant', () => {
  const shortRadius = RallyTactical.departureRadius(5, 20, 120, 24);
  const longRadius = RallyTactical.departureRadius(20, 20, 120, 24);
  const short = RallyTactical.actorProjection({
    nowMs: 120_000, pressAtMs: 0, gatherEndsAtMs: 115_000,
    marchSeconds: 5, departureRadius: shortRadius
  });
  const long = RallyTactical.actorProjection({
    nowMs: 120_000, pressAtMs: 0, gatherEndsAtMs: 100_000,
    marchSeconds: 20, departureRadius: longRadius
  });
  assert.deepEqual(plain(short), { phase: 'landed', progress: 1, radius: 0 });
  assert.deepEqual(plain(long), { phase: 'landed', progress: 1, radius: 0 });
});

test('staged and gathering actors stay at their departure radius', () => {
  const base = {
    marchSeconds: 40,
    pressAtMs: 100_000,
    gatherEndsAtMs: 400_000,
    scaleMaxSeconds: 43.2,
    departureRadius: 122.22222222222221
  };

  assert.deepEqual(plain(RallyTactical.actorProjection({ ...base, nowMs: 90_000 })), {
    phase: 'staged', progress: 0, radius: base.departureRadius
  });
  assert.deepEqual(plain(RallyTactical.actorProjection({ ...base, nowMs: 250_000 })), {
    phase: 'gathering', progress: 0, radius: base.departureRadius
  });
  assert.deepEqual(plain(RallyTactical.actorProjection({ ...base, nowMs: 400_000 })), {
    phase: 'marching', progress: 0, radius: base.departureRadius
  });
});

test('marching actors move linearly from departure to the castle using absolute time', () => {
  const base = {
    marchSeconds: 40,
    pressAtMs: 100_000,
    gatherEndsAtMs: 400_000,
    scaleMaxSeconds: 43.2,
    departureRadius: 120
  };

  assert.deepEqual(plain(RallyTactical.actorProjection({ ...base, nowMs: 410_000 })), {
    phase: 'marching', progress: 0.25, radius: 90
  });
  assert.deepEqual(plain(RallyTactical.actorProjection({ ...base, nowMs: 420_000 })), {
    phase: 'marching', progress: 0.5, radius: 60
  });
  assert.deepEqual(plain(RallyTactical.actorProjection({ ...base, nowMs: 440_000 })), {
    phase: 'landed', progress: 1, radius: 0
  });
  assert.deepEqual(plain(RallyTactical.actorProjection({ ...base, nowMs: 500_000 })), {
    phase: 'landed', progress: 1, radius: 0
  });
});

test('selected groups show both kingdoms in role order and never exceed six captains', () => {
  const room = {
    players: {
      a: { name: 'A canonical', march: 13 },
      b: { name: 'B canonical', march: 34 },
      c: { name: 'C canonical', march: 36 },
      d: { name: 'D canonical', march: 40 },
      e: { name: 'E canonical', march: 45 },
      f: { name: 'F canonical', march: 50 },
      ignored: { name: 'Not selected', march: 60 }
    },
    rallyModes: {
      1: { mode: 'triple', revision: 2 },
      2: { mode: 'triple', revision: 4 }
    },
    live: {
      commands: {
        1: null,
        2: {
          id: 'command-k2',
          type: 'triple_rally',
          kingdom: 2,
          payload: {
            pairs: [
              { pid: 'f', name: 'F frozen', march: 51, role: 'main', pressUTC: 900 },
              { pid: 'd', name: 'D frozen', march: 41, role: 'weak', pressUTC: 890 },
              { pid: 'e', name: 'E frozen', march: 46, role: 'weak2', pressUTC: 895 }
            ]
          }
        }
      },
      staged: {
        1: {
          pairs: [
            { pid: 'c', name: 'stale C', march: 1, role: 'main' },
            { pid: 'a', name: 'stale A', march: 1, role: 'weak' },
            { pid: 'b', name: 'stale B', march: 1, role: 'weak2' },
            { pid: 'ignored', name: 'extra', march: 60, role: 'weak' }
          ]
        },
        2: null
      }
    }
  };

  assert.deepEqual(plain(RallyTactical.selectedGroups(room, 'a')), [
    {
      kingdom: 1,
      mode: 'triple',
      required: 3,
      source: 'staged',
      commandId: '',
      actors: [
        { pid: 'a', name: 'A canonical', march: 13, role: 'weak', kingdom: 1, mine: true },
        { pid: 'b', name: 'B canonical', march: 34, role: 'weak2', kingdom: 1, mine: false },
        { pid: 'c', name: 'C canonical', march: 36, role: 'main', kingdom: 1, mine: false }
      ]
    },
    {
      kingdom: 2,
      mode: 'triple',
      required: 3,
      source: 'live',
      commandId: 'command-k2',
      actors: [
        { pid: 'd', name: 'D frozen', march: 41, role: 'weak', kingdom: 2, mine: false, pressUTC: 890 },
        { pid: 'e', name: 'E frozen', march: 46, role: 'weak2', kingdom: 2, mine: false, pressUTC: 895 },
        { pid: 'f', name: 'F frozen', march: 51, role: 'main', kingdom: 2, mine: false, pressUTC: 900 }
      ]
    }
  ]);
});

test('double mode exposes two actors per kingdom and ignores malformed or duplicate roles', () => {
  const groups = RallyTactical.selectedGroups({
    players: {
      a: { name: 'A', march: 20 },
      b: { name: 'B', march: 30 },
      c: { name: 'C', march: 40 }
    },
    rallyModes: { 1: { mode: 'double' }, 2: { mode: 'double' } },
    live: {
      commands: { 1: null, 2: null },
      staged: {
        1: { pairs: [
          { pid: 'a', role: 'weak' },
          { pid: 'c', role: 'weak2' },
          { pid: 'b', role: 'main' },
          { pid: 'c', role: 'main' }
        ] },
        2: null
      }
    }
  }, '');

  assert.deepEqual(plain(groups.map(group => group.actors.map(actor => [actor.pid, actor.role]))), [
    [['a', 'weak'], ['b', 'main']],
    []
  ]);
});

test('legacy projected Triple keeps all three roles when the wire type is double_rally', () => {
  const groups = RallyTactical.selectedGroups({
    players: {},
    rallyModes: { 1: { mode: 'double' }, 2: { mode: 'double' } },
    live: {
      commands: {
        1: {
          id: 'legacy-triple',
          type: 'double_rally',
          payload: {
            rallySize: 3,
            pairs: [
              { pid: 'a', name: 'A', march: 20, role: 'weak', pressUTC: 100 },
              { pid: 'b', name: 'B', march: 25, role: 'weak2', pressUTC: 105 },
              { pid: 'c', name: 'C', march: 30, role: 'main', pressUTC: 110 }
            ]
          }
        },
        2: null
      },
      staged: { 1: null, 2: null }
    }
  }, 'b');

  assert.equal(groups[0].mode, 'triple');
  assert.equal(groups[0].required, 3);
  assert.deepEqual(plain(groups[0].actors.map(actor => [actor.pid, actor.role, actor.mine])), [
    ['a', 'weak', false],
    ['b', 'weak2', true],
    ['c', 'main', false]
  ]);
});

test('render key changes only when canonical tactical fields change', () => {
  const groups = [{
    kingdom: 1,
    mode: 'double',
    required: 2,
    source: 'staged',
    commandId: '',
    actors: [
      { pid: 'a', name: 'A', march: 20, role: 'weak', kingdom: 1, mine: true },
      { pid: 'b', name: 'B', march: 30, role: 'main', kingdom: 1, mine: false }
    ]
  }];
  const base = { live: false, groups, nowMs: 100, decorativeSeed: 1 };

  assert.equal(RallyTactical.renderKey(base), RallyTactical.renderKey({ ...base, nowMs: 999, decorativeSeed: 2 }));
  assert.notEqual(RallyTactical.renderKey(base), RallyTactical.renderKey({
    ...base,
    groups: [{ ...groups[0], actors: [{ ...groups[0].actors[0], name: 'Renamed' }, groups[0].actors[1]] }]
  }));
  assert.notEqual(RallyTactical.renderKey(base), RallyTactical.renderKey({
    ...base,
    groups: [{ ...groups[0], actors: [{ ...groups[0].actors[0], march: 21 }, groups[0].actors[1]] }]
  }));
});
