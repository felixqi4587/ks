const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'rally.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'app.css'), 'utf8');
const source = fs.readFileSync(path.join(root, 'public', 'rally-controller.js'), 'utf8');

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

function modeHarness(record = { mode: 'double', revision: 0 }) {
  const context = {
    pendingRallyMode: null,
    room: { rallyModes: { 1: { ...record }, 2: { mode: 'double', revision: 0 } } },
    tripleClientAvailable: true,
    fireKingdom: 1,
    roomPw: 'commander-password',
    rendered: 0,
    toasts: [],
    tk: (key) => key,
    window: {
      clearTimeout() {},
      toast(value) { context.toasts.push(value); }
    }
  };
  const names = [
    'rallyModeRecord', 'rallyMode', 'clearPendingRallyMode',
    'settleRallyModeMutation', 'handleRallyModeMessage'
  ];
  vm.runInNewContext(names.map(extractFunction).join('\n'), context);
  context.renderRallyMode = () => { context.rendered += 1; };
  return context;
}

test('the per-kingdom Triple switch and all three explicit replacement choices are accessible', () => {
  assert.match(html, /id="rallyModeControl"[^>]*hidden[^>]*aria-labelledby="rallyModeScope"/);
  assert.match(html, /id="tripleMode"[^>]*type="checkbox"[^>]*role="switch"[^>]*aria-describedby="rallyModeStatus"/);
  assert.match(html, /id="rallyModeStatus"[^>]*aria-live="polite"/);
  for (const id of ['replaceWeak', 'replaceWeak2', 'replaceMain']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1);
  }
});

test('mode mutation settles only after its exact ACK and canonical state both arrive', () => {
  const ackFirst = modeHarness();
  ackFirst.pendingRallyMode = {
    mutationId: 'mode-a', kingdom: 1, mode: 'triple', baseRevision: 0, ackRevision: null, timeoutId: 1
  };
  assert.equal(ackFirst.handleRallyModeMessage({
    t: 'rallyModeSaved', mutationId: 'mode-a', kingdom: 1, mode: 'triple', revision: 1
  }), true);
  assert.equal(ackFirst.pendingRallyMode.ackRevision, 1);
  ackFirst.room.rallyModes[1] = { mode: 'triple', revision: 1 };
  ackFirst.settleRallyModeMutation();
  assert.equal(ackFirst.pendingRallyMode, null);
  assert.deepEqual(ackFirst.toasts, ['rally_mode_saved']);

  const stateFirst = modeHarness({ mode: 'triple', revision: 1 });
  stateFirst.pendingRallyMode = {
    mutationId: 'mode-b', kingdom: 1, mode: 'triple', baseRevision: 0, ackRevision: null, timeoutId: 2
  };
  stateFirst.settleRallyModeMutation();
  assert.notEqual(stateFirst.pendingRallyMode, null);
  stateFirst.handleRallyModeMessage({
    t: 'rallyModeSaved', mutationId: 'mode-b', kingdom: 1, mode: 'triple', revision: 1
  });
  assert.equal(stateFirst.pendingRallyMode, null);

  const wrong = modeHarness({ mode: 'triple', revision: 1 });
  wrong.pendingRallyMode = {
    mutationId: 'mode-c', kingdom: 1, mode: 'triple', baseRevision: 0, ackRevision: null, timeoutId: 3
  };
  assert.equal(wrong.handleRallyModeMessage({
    t: 'rallyModeSaved', mutationId: 'other', kingdom: 1, mode: 'triple', revision: 1
  }), true);
  assert.equal(wrong.pendingRallyMode.ackRevision, null);
  wrong.handleRallyModeMessage({
    t: 'rallyModeSaved', mutationId: 'mode-c', kingdom: '1', mode: 'triple', revision: 1
  });
  assert.equal(wrong.pendingRallyMode.ackRevision, null, 'ACK kingdom must match without coercion');

  const superseded = modeHarness({ mode: 'double', revision: 2 });
  superseded.pendingRallyMode = {
    mutationId: 'mode-d', kingdom: 1, mode: 'triple', baseRevision: 0, ackRevision: null, timeoutId: 4
  };
  superseded.settleRallyModeMutation();
  assert.equal(superseded.pendingRallyMode, null, 'a newer canonical revision settles immediately as superseded');
  assert.deepEqual(superseded.toasts, ['mode_changed_elsewhere']);
});

test('mode and stage messages preserve the existing reconnect-safe state machines', () => {
  const handle = extractFunction('handleSocketMessage');
  assert.match(handle, /handleRallyModeMessage\(message\)/);
  const connect = extractFunction('connect');
  assert.match(connect, /sock\.onClose\s*=\s*function[\s\S]*pendingRallyMode\.status\s*=\s*["']retry["']/,
    'mode state must survive reconnect and replay rather than being discarded');
  assert.match(connect, /handleRallyModeError\(m\)[\s\S]*handleRallyStageConflict\(m\)/);
  assert.ok(connect.indexOf('handleRallyModeError(m)') < connect.indexOf('if (m && m.mutationId) return'),
    'mode errors must not be swallowed by the generic mutation guard');

  const pump = extractFunction('pumpStageQueue');
  assert.match(pump, /modeRevision:\s*record\.revision/);
  assert.match(pump, /rallyApi\.reconcilePicks/);
  assert.match(pump, /pendingStageMutation\s*=\s*\{[\s\S]*modeRevision/);
  assert.match(source, /rally_mode_conflict[\s\S]{0,500}(rollbackStageSelection|refresh)/);
});

test('canonical snapshots reconcile all kingdoms against their own modes', () => {
  const onState = extractFunction('onState');
  assert.match(onState, /rallyModeRecord\(kd,\s*r\)/);
  assert.match(onState, /rallyApi\.reconcilePicks/);
  assert.doesNotMatch(source, /picksTouched/,
    'no commander may keep a private staged selection after a canonical snapshot');
  assert.match(onState, /settleRallyModeMutation\(\)/);
  assert.match(extractFunction('openReplacement'), /modeRevision:\s*modeRecord\.revision/);
  assert.match(onState, /replacementRecord\.revision\s*!==\s*pendingReplacementIncumbents\.modeRevision/,
    'a remote mode revision must close a stale role or replacement dialog');
});

test('Triple gets three vertical canonical slots while the Double renderer stays intact', () => {
  const canonical = extractFunction('canonicalPick');
  assert.match(canonical, /role === ["']weak2["']/);
  const slots = extractFunction('renderSlots');
  assert.match(slots, /rallyMode\(selectedKingdom\) === ["']triple["']/);
  assert.match(slots, /renderTripleSlots\(selectedKingdom\)/);
  assert.match(slots, /commandUsesTripleRoles\(selectedCommand\)/,
    'an active projected Triple command must keep all three frozen slots after a mode change');
  assert.match(slots, /swapRoles/,
    'the approved Double swap control must remain in its original renderer');
  const triple = extractFunction('renderTripleSlots');
  assert.match(triple, /rolesForMode/);
  assert.match(triple, /deliveryForPlayer/);
  assert.doesNotMatch(triple, /fireKingdom/,
    'Triple rendering must use its explicit kingdom argument throughout');
  assert.match(css, /\.slots\.triple\s*\{[^}]*grid-template-columns:\s*minmax\(0,1fr\)/s);
  assert.match(css, /\.slots\.triple\s+\.slot\s*\{[^}]*grid-template-columns:/s);
  assert.doesNotMatch(css, /\.slots\.triple[^}]*overflow-x:\s*(auto|scroll)/s);
});

test('Triple role labels are never collapsed into the first sacrifice label', () => {
  assert.match(source, /function rallyRoleLabel\(/);
  assert.match(source, /slot_weak2/);
  for (const name of ['paintHero', 'renderRoster', 'renderRemovalDialog']) {
    assert.match(extractFunction(name), /rallyRoleLabel/);
  }
  assert.match(source, /role_choose/);
  assert.match(source, /confirm_drop_weak2/);
});

test('Triple selection cannot accidentally invoke the unchanged Double Fire path', () => {
  const roster = extractFunction('renderRoster');
  assert.match(roster, /rallyMode\(fireKingdom\)/);
  assert.match(roster, /requiredCaptains\(fireKingdom\)/);
  assert.match(roster, /updateFireControl\(\)/);
  const control = extractFunction('updateFireControl');
  assert.match(control, /button\.disabled\s*=\s*!rallyModeWritable\(fireKingdom\)/);
  const fireDouble = extractFunction('fireDouble');
  const fireCurrent = extractFunction('fireCurrentRally');
  assert.match(fireCurrent, /!rallyModeWritable\(fireKingdom\)/,
    'the direct Double path must also fail closed in a raw Triple room');
  assert.match(fireCurrent, /rallyMode\(fireKingdom\) === ["']triple["']/);
  assert.doesNotMatch(fireDouble, /triple_rally|weak2/);
});
