const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/kvk.js'), 'utf8');

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

function identityMismatchHarness() {
  const toasts = [];
  const classes = [];
  const sandbox = {
    pendingMarchMutation: { mutationId: 'march-save-1' },
    pendingRegistrationProfile: null,
    registrationPending: false,
    draftActive: false,
    nicknameDraftRoutingKey: 'nickname-key',
    myProfile: { pid: '001', name: 'Player', march: 40, marchRevision: 0 },
    identityMode: 'playerId',
    cancelIdentityLookup() {},
    showExistingIdentity() { sandbox.identityRestored = true; },
    syncIdentityControls() {},
    tk(key) { return key; },
    window: { toast(message) { toasts.push(message); } },
    sock: { refresh() { sandbox.refreshes += 1; } },
    $(id) {
      return {
        classList: {
          remove(name) { classes.push(`${id}:remove:${name}`); },
          add(name) { classes.push(`${id}:add:${name}`); }
        }
      };
    },
    identityRestored: false,
    refreshes: 0,
    toasts,
    classes
  };
  vm.runInNewContext(`${extractFunction('handlePlayerProtocolError')}\nthis.handlePlayerProtocolError = handlePlayerProtocolError;`, sandbox);
  return sandbox;
}

test('identity mismatch releases a pending self-save and reconnects for a fresh socket binding', () => {
  const h = identityMismatchHarness();

  assert.equal(h.handlePlayerProtocolError({
    t: 'error', error: 'core_identity_mismatch', mutationId: 'march-save-1', pid: '001'
  }), true);
  assert.equal(h.pendingMarchMutation, null);
  assert.equal(h.draftActive, true);
  assert.equal(h.identityRestored, true);
  assert.deepEqual(h.toasts, ['identity_rebinding']);
  assert.equal(h.refreshes, 1);
  assert.deepEqual(h.classes, ['fillCard:remove:hide', 'youChip:add:hide']);
});

test('identity mismatch for another mutation does not disturb the current self-save', () => {
  const h = identityMismatchHarness();

  assert.equal(h.handlePlayerProtocolError({
    t: 'error', error: 'core_identity_mismatch', mutationId: 'another-save', pid: '001'
  }), false);
  assert.equal(h.pendingMarchMutation.mutationId, 'march-save-1');
  assert.equal(h.refreshes, 0);
  assert.deepEqual(h.toasts, []);
});
