const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/kvk.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
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
  const sandbox = {
    removalState: {
      pid: '001', status: 'pending', socketGeneration: 7
    },
    sock: { connectionGeneration: 7 },
    renders: 0,
    invalidations: 0,
    renderRemovalDialog() { sandbox.renders += 1; },
    invalidateCommanderAccess() { sandbox.invalidations += 1; }
  };
  vm.runInNewContext(
    `${extractFunction('handleRemovalProtocolError')}\nthis.handleRemovalProtocolError = handleRemovalProtocolError;`,
    sandbox
  );
  return sandbox;
}

test('remove persistence failure keeps the player pending locally and exposes a manual retry', () => {
  const h = harness();

  assert.equal(h.handleRemovalProtocolError({
    t: 'error', error: 'remove_persist_failed', pid: '001'
  }), true);
  assert.equal(h.removalState.status, 'retry');
  assert.equal(h.renders, 1);
  assert.equal(h.invalidations, 0);
});

test('remove persistence failure for another player cannot disturb this pending removal', () => {
  const h = harness();

  assert.equal(h.handleRemovalProtocolError({
    t: 'error', error: 'remove_persist_failed', pid: 'kimchi'
  }), false);
  assert.equal(h.removalState.status, 'pending');
  assert.equal(h.renders, 0);
});
