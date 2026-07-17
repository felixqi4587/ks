const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/rally-controller.js'), 'utf8');
const tacticalSource = fs.readFileSync(path.join(__dirname, '../public/rally-tactical.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  let depth = 0;
  let body = false;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '{') { depth += 1; body = true; }
    if (source[index] === '}') depth -= 1;
    if (body && depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unable to extract ${name}`);
}

function loadMapRenderKey() {
  const sandbox = {};
  vm.runInNewContext(tacticalSource, sandbox);
  sandbox.rallyTactical = sandbox.RallyTactical;
  vm.runInNewContext(`${extractFunction('mapRenderKey')}\nthis.mapRenderKey = mapRenderKey;`, sandbox);
  return sandbox.mapRenderKey;
}

test('idle tactical render key includes canonical display fields', () => {
  const key = loadMapRenderKey();
  const base = {
    live: false,
    actors: [{ pid: 'route-a', name: 'Ff', march: 34, role: 'weak', mine: true, kingdom: 1 }],
    groups: [{
      kingdom: 1, mode: 'double', required: 2,
      actors: [{ pid: 'route-a', name: 'Ff', march: 34, role: 'weak', mine: true, kingdom: 1 }]
    }]
  };
  const withActor = patch => ({
    ...base,
    actors: [{ ...base.actors[0], ...patch }],
    groups: [{
      ...base.groups[0],
      actors: [{ ...base.groups[0].actors[0], ...patch }]
    }]
  });
  const kimchi = withActor({ name: 'Kimchi' });
  assert.notEqual(key(base), key(kimchi));
  assert.equal(key(base), key(structuredClone(base)));
  assert.notEqual(key(base), key({ ...base, groups: [{ ...base.groups[0], mode: 'triple' }] }));
  assert.notEqual(key(base), key({ ...base, groups: [{ ...base.groups[0], required: 3 }] }));
  assert.notEqual(key(base), key({ ...base, groups: [{ ...base.groups[0], kingdom: 2 }] }));
  assert.notEqual(key(base), key(withActor({ march: 35 })));
  assert.notEqual(key(base), key(withActor({ role: 'main' })));
  assert.notEqual(key(base), key(withActor({ mine: false })));
  assert.notEqual(key(base), key(withActor({ kingdom: 2 })));
});

test('live tactical render key tracks the immutable command snapshot, never clock-only fields', () => {
  const key = loadMapRenderKey();
  const base = {
    live: true,
    nowMs: 100,
    groups: [{
      kingdom: 1,
      mode: 'double',
      required: 2,
      source: 'live',
      commandId: 'cmd-1',
      actors: [{ pid: 'a', name: 'Ff', march: 34, role: 'weak', kingdom: 1, mine: true, pressUTC: 900 }]
    }]
  };
  assert.equal(
    key(base),
    key({ ...structuredClone(base), nowMs: 999 })
  );
  assert.notEqual(key(base), key({
    ...base,
    groups: [{ ...base.groups[0], commandId: 'cmd-2' }]
  }));
  assert.notEqual(key(base), key({
    ...base,
    groups: [{ ...base.groups[0], actors: [{ ...base.groups[0].actors[0], name: 'Kimchi' }] }]
  }));
});
