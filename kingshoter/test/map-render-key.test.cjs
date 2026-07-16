const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/kvk.js'), 'utf8');

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
  const kimchi = { ...base, actors: [{ ...base.actors[0], name: 'Kimchi' }] };
  assert.notEqual(key(base), key(kimchi));
  assert.equal(key(base), key(structuredClone(base)));
  assert.notEqual(key(base), key({ ...base, groups: [{ ...base.groups[0], mode: 'triple', required: 3 }] }));
  assert.notEqual(key(base), key({ ...base, groups: [{ ...base.groups[0], kingdom: 2 }] }));
});

test('live tactical render key remains frozen to the command id', () => {
  const key = loadMapRenderKey();
  assert.equal(
    key({ live: true, id: 'cmd-1', actors: [{ name: 'Ff' }] }),
    key({ live: true, id: 'cmd-1', actors: [{ name: 'Kimchi' }] })
  );
  assert.notEqual(key({ live: true, id: 'cmd-1', actors: [] }), key({ live: true, id: 'cmd-2', actors: [] }));
});
