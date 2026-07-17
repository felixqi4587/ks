const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/kvk.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/kvk.html'), 'utf8');
const sfxDir = path.join(__dirname, '../public/sfx');

function count(sourceText, token) {
  return sourceText.split(token).length - 1;
}

function extractFunction(sourceText, name) {
  const start = sourceText.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const open = sourceText.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < sourceText.length; index += 1) {
    const character = sourceText[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '{') depth += 1;
    if (character === '}' && --depth === 0) return sourceText.slice(start, index + 1);
  }
  assert.fail(`unterminated ${name}`);
}

function instrumentedNode(actions, kind = 'node') {
  return {
    kind,
    o: {
      stop() { actions.push('oscillator.stop'); },
      disconnect() { actions.push('oscillator.disconnect'); }
    },
    g: {
      disconnect() { actions.push('gain.disconnect'); },
      gain: {
        cancelScheduledValues(value) { actions.push(`gain.cancel:${value}`); },
        setValueAtTime(value, at) { actions.push(`gain.set:${value}:${at}`); }
      }
    }
  };
}

function cueHarness(nowMs = 100_000) {
  const calls = [];
  const nodeActions = [];
  const clock = { nowMs };
  function node(kind) {
    const actions = [];
    nodeActions.push({ kind, actions });
    return instrumentedNode(actions, kind);
  }
  const context = {
    scheduledBeeps: {}, BEEP_HZ: 740, clock,
    ensureAudio() {}, ac: { state: 'running', currentTime: 10 },
    window: { serverNow: () => clock.nowMs, clockOffset: 0, __beeps: 0 },
    L: () => true,
    sfxBuf: {
      en: { '5': 'five', '4': 'four', '3': 'three', '2': 'two', '1': 'one', go: 'go' },
      zh: {}
    },
    playClip(when, buffer) { calls.push({ kind: 'clip', when, buffer }); return node('clip'); },
    beep(when, frequency) { calls.push({ kind: 'beep', when, frequency }); return node('beep'); },
    calls, nodeActions
  };
  vm.runInNewContext([
    extractFunction(source, 'stopCue'),
    extractFunction(source, 'scheduleBeeps')
  ].join('\n'), context);
  return context;
}

test('Rally keeps one shared 10-to-Now cue grammar and the shipped clips', () => {
  assert.equal(count(source, 'function scheduleBeeps('), 1, 'one countdown scheduler owns the beep phase');
  assert.equal(count(source, '[10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].forEach'), 1);
  assert.equal(count(source, '["5", "4", "3", "2", "1", "go"].forEach'), 1);
  assert.deepEqual(fs.readdirSync(sfxDir).sort(), [
    'en_1.mp3', 'en_2.mp3', 'en_3.mp3', 'en_4.mp3', 'en_5.mp3', 'en_go.mp3',
    'zh_1.mp3', 'zh_2.mp3', 'zh_3.mp3', 'zh_4.mp3', 'zh_5.mp3', 'zh_go.mp3'
  ]);
  for (const language of ['en', 'zh']) {
    for (const clip of ['5', '4', '3', '2', '1', 'go']) {
      const asset = path.join(sfxDir, `${language}_${clip}.mp3`);
      assert.ok(fs.statSync(asset).size > 0, `${path.basename(asset)} must be shipped and non-empty`);
    }
  }
});

test('one command schedules one GO and duplicate reconciliation cannot schedule it twice', () => {
  const h = cueHarness();
  h.scheduleBeeps('command-me', 111, 360_000);
  h.scheduleBeeps('command-me', 111, 360_000);

  assert.deepEqual(Object.keys(h.scheduledBeeps).sort(), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    .map(offset => `command-me:${offset}`).sort());
  assert.equal(h.window.__beeps, 11);
  assert.equal(h.calls.filter(call => call.kind === 'clip' && call.buffer === 'go').length, 1);
  assert.equal(h.scheduledBeeps['command-me:0'].nodes.length, 3,
    'GO retains one voice node and its two-tone reinforcement');
});

test('cancellation stops only obsolete future cues and preserves live/self-test history', () => {
  const cancelledActions = [];
  const liveActions = [];
  const pastActions = [];
  const lockActions = [];
  const context = {
    room: {},
    scheduledBeeps: {
      'cancelled:0': { base: 'cancelled-me', t: 101_000, nodes: [instrumentedNode(cancelledActions)] },
      'live:0': { base: 'live-me', t: 102_000, nodes: [instrumentedNode(liveActions)] },
      'past:0': { base: 'past-me', t: 99_000, nodes: [instrumentedNode(pastActions)] },
      'lock:0': { base: 'locktest-1', t: 103_000, nodes: [instrumentedNode(lockActions)] }
    },
    liveCommands: () => [{ id: 'live' }],
    window: { serverNow: () => 100_000 }
  };
  vm.runInNewContext([
    extractFunction(source, 'stopCue'),
    extractFunction(source, 'reconcileCues')
  ].join('\n'), context);
  assert.equal(context.reconcileCues(), true);
  assert.deepEqual(cancelledActions, [
    'gain.cancel:0', 'gain.set:0.0001:0', 'oscillator.stop',
    'oscillator.disconnect', 'gain.disconnect'
  ]);
  assert.deepEqual(liveActions, []);
  assert.deepEqual(pastActions, []);
  assert.deepEqual(lockActions, []);
  assert.deepEqual(Object.keys(context.scheduledBeeps).sort(), ['live:0', 'lock:0', 'past:0']);
});

test('clock-drift replanning never replays a GO whose target already passed', () => {
  const h = cueHarness();
  h.scheduleBeeps('command-me', 111, 360_000);
  assert.equal(h.calls.filter(call => call.kind === 'clip' && call.buffer === 'go').length, 1);

  h.clock.nowMs = 112_000;
  h.window.clockOffset = 1_000;
  h.scheduleAllCues = () => h.scheduleBeeps('command-me', 111, 360_000);
  vm.runInNewContext(extractFunction(source, 'rebookCuesOnDrift'), h);
  h.rebookCuesOnDrift();

  assert.equal(h.calls.filter(call => call.kind === 'clip' && call.buffer === 'go').length, 1,
    'past GO becomes a node-free tombstone instead of replaying');
  assert.deepEqual(JSON.parse(JSON.stringify(h.scheduledBeeps['command-me:0'].nodes)), []);
  assert.equal(h.nodeActions.length, 13);
  assert.ok(h.nodeActions.every(node => node.actions.join('|') === [
    'gain.cancel:0', 'gain.set:0.0001:0', 'oscillator.stop',
    'oscillator.disconnect', 'gain.disconnect'
  ].join('|')), 'every stale oscillator/source and gain is muted, stopped, and disconnected');
});

test('the background carrier, MediaSession, and readiness truth remain coupled', () => {
  assert.match(source, /Math\.sin\(i \/ sr \* 2 \* Math\.PI \* 40\)/);
  assert.match(source, /keepAudio\.loop = true/);
  assert.match(source, /navigator\.mediaSession\.metadata = new window\.MediaMetadata/);
  assert.match(source, /soundReady && ac && ac\.state === "running" && keepAlive && keepAudio && !keepAudio\.paused && !keepAudio\.ended/);
  assert.match(html, /id="soundGate"/);
});

test('cancel and clock correction retain stoppable Web Audio node wiring', () => {
  assert.match(source, /nodes are RETAINED so a cue can be killed/);
  assert.match(source, /cancelScheduledValues\(0\)/);
  assert.match(source, /function reconcileCues\(\)/);
  assert.match(source, /function rebookCuesOnDrift\(\)/);
  assert.match(source, /stopCue\(e\); delete scheduledBeeps\[k\]/);
});

test('an unselected commander has a visual-only all-captain monitor', () => {
  assert.match(source, /function shouldShowCommanderLaunchMonitor/);
  assert.match(source, /return rows\.slice\(0, 6\)/);
  assert.match(source, /cmd_watch_sub: "Commander view · silent"/);
  assert.match(source, /function shouldBookJoinAudio\(\)[\s\S]*!isCommanderDevice\(\)/);
});
