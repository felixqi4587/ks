const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/rally-controller.js'), 'utf8');

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
    sock: {
      connectionGeneration: 7,
      refresh() { sandbox.refreshes += 1; }
    },
    renders: 0,
    rosterRenders: 0,
    refreshes: 0,
    invalidations: 0,
    renderRemovalDialog() { sandbox.renders += 1; },
    renderRoster() { sandbox.rosterRenders += 1; },
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
  assert.equal(h.rosterRenders, 1);
  assert.equal(h.refreshes, 0);
  assert.equal(h.invalidations, 0);
});

test('active-player rejection blocks removal, repaints roster availability, and refreshes state', () => {
  const h = harness();

  assert.equal(h.handleRemovalProtocolError({
    t: 'error', error: 'player_in_live_command', pid: '001'
  }), true);
  assert.equal(h.removalState.status, 'blocked');
  assert.equal(h.renders, 1);
  assert.equal(h.rosterRenders, 1);
  assert.equal(h.refreshes, 1);
  assert.equal(h.invalidations, 0);
});

test('scoped removal errors for another player cannot repaint or disturb this pending removal', () => {
  for (const error of ['remove_persist_failed', 'player_in_live_command']) {
    const h = harness();

    assert.equal(h.handleRemovalProtocolError({
      t: 'error', error, pid: 'kimchi'
    }), false, error);
    assert.equal(h.removalState.status, 'pending', error);
    assert.equal(h.renders, 0, error);
    assert.equal(h.rosterRenders, 0, error);
    assert.equal(h.refreshes, 0, error);
    assert.equal(h.invalidations, 0, error);
  }
});
