const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/rally-controller.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/rally.html'), 'utf8');
const audioSource = fs.readFileSync(path.join(__dirname, '../public/battle-audio.js'), 'utf8');
const cuesSource = fs.readFileSync(path.join(__dirname, '../public/battle-cues.js'), 'utf8');
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

function loadCueApi() {
  const moduleValue = { exports: {} };
  vm.runInNewContext(cuesSource, {
    module: moduleValue, exports: moduleValue.exports, globalThis: {},
    Object, Array, Number, Math, TypeError, Error
  });
  return moduleValue.exports;
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
  const clock = { nowMs, offset: 0 };
  const scheduledBeeps = {};
  function node(kind) {
    const actions = [];
    nodeActions.push({ kind, actions });
    return instrumentedNode(actions, kind);
  }
  const audio = {
    nowSeconds: () => 10,
    schedule(event, when) {
      calls.push({ ...event, when });
      if (event.kind === 'go') return [node('clip'), node('beep'), node('beep')];
      if (event.kind === 'prepare') return [node('beep'), node('beep')];
      return [node(event.kind)];
    },
    cancel(nodes) {
      for (const value of nodes || []) {
        value.g.gain.cancelScheduledValues(0);
        value.g.gain.setValueAtTime(0.0001, 0);
        value.o.stop(0);
        value.o.disconnect();
        value.g.disconnect();
      }
    }
  };
  const window = {
    serverNow: () => clock.nowMs,
    clockOffset: 0,
    __beeps: 0
  };
  const battleCues = loadCueApi().createCueScheduler({
    audio,
    registry: scheduledBeeps,
    nowMs: () => clock.nowMs,
    clockOffsetMs: () => window.clockOffset,
    onScheduled: () => { window.__beeps += 1; }
  });
  const context = {
    scheduledBeeps, battleCues, clock, window,
    ensureAudio() {}, ac: { state: 'running' }, L: () => true,
    calls, nodeActions
  };
  vm.runInNewContext(extractFunction(source, 'scheduleBeeps'), context);
  return context;
}

test('Rally keeps one shared 10-to-Now cue grammar and the shipped clips', () => {
  assert.equal(count(source, 'function scheduleBeeps('), 1, 'one Rally adapter owns countdown policy');
  assert.match(extractFunction(source, 'scheduleBeeps'), /\[10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0\]\.map/);
  assert.match(audioSource, /var SFX_NAMES = \["5", "4", "3", "2", "1", "go"\]/);
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
  assert.equal(h.calls.filter(call => call.kind === 'go').length, 1);
  assert.equal(h.scheduledBeeps['command-me:0'].nodes.length, 3,
    'GO retains one voice node and its two-tone reinforcement');
  assert.deepEqual(h.calls.map(call => call.kind), [
    'tick', 'tick', 'tick', 'tick', 'tick',
    'countdown', 'countdown', 'countdown', 'countdown', 'countdown', 'go'
  ]);
});

test('cancellation stops only obsolete future cues and preserves live/self-test history', () => {
  const h = cueHarness();
  h.scheduleBeeps('cancelled-me', 101, 360_000);
  h.scheduleBeeps('live-me', 102, 360_000);
  h.scheduleBeeps('past-me', 99, 360_000);
  h.scheduleBeeps('locktest-1', 103, 360_000);
  const context = {
    room: {}, battleCues: h.battleCues,
    liveCommands: () => [{ id: 'live' }],
    window: h.window
  };
  vm.runInNewContext(extractFunction(source, 'reconcileCues'), context);
  assert.equal(context.reconcileCues(), true);
  assert.equal(h.battleCues.hasFutureCue('cancelled-me'), false);
  assert.equal(h.battleCues.hasFutureCue('live-me'), true);
  assert.equal(h.battleCues.hasFutureCue('locktest-1'), true);
  assert.ok(h.battleCues.snapshot().some(entry => entry.base === 'past-me'));
});

test('clock-drift replanning never replays a GO whose target already passed', () => {
  const h = cueHarness();
  h.scheduleBeeps('command-me', 111, 360_000);
  assert.equal(h.calls.filter(call => call.kind === 'go').length, 1);

  h.clock.nowMs = 112_000;
  h.window.clockOffset = 1_000;
  h.scheduleAllCues = () => h.scheduleBeeps('command-me', 111, 360_000);
  vm.runInNewContext(extractFunction(source, 'rebookCuesOnDrift'), h);
  h.rebookCuesOnDrift();

  assert.equal(h.calls.filter(call => call.kind === 'go').length, 1,
    'past GO becomes a node-free tombstone instead of replaying');
  assert.deepEqual(JSON.parse(JSON.stringify(h.scheduledBeeps['command-me:0'].nodes)), []);
  assert.equal(h.nodeActions.length, 13);
  assert.ok(h.nodeActions.every(value => value.actions.join('|') === [
    'gain.cancel:0', 'gain.set:0.0001:0', 'oscillator.stop',
    'oscillator.disconnect', 'gain.disconnect'
  ].join('|')), 'every stale oscillator/source and gain is muted, stopped, and disconnected');
});

test('the background carrier, MediaSession, and readiness truth remain coupled', () => {
  assert.match(audioSource, /Math\.sin\(index \/ sampleRate \* 2 \* Math\.PI \* 40\)/);
  assert.match(audioSource, /carrier\.loop = true/);
  assert.match(audioSource, /nav\.mediaSession\.metadata/);
  assert.match(extractFunction(source, 'audioAlive'), /battleReadiness\(\)\.green/);
  assert.match(html, /id="soundGate"/);
  assert.match(html, /battle-status\.js[\s\S]*battle-audio\.js[\s\S]*battle-cues\.js[\s\S]*rally-controller\.js/);
});

test('cancel and clock correction retain stoppable Web Audio node wiring', () => {
  assert.match(source, /nodes are RETAINED so a cue can be killed/);
  assert.match(audioSource, /cancelScheduledValues\(0\)/);
  assert.match(cuesSource, /function cancelDrifted/);
  assert.match(extractFunction(source, 'reconcileCues'), /battleCues\.cancelWhere/);
  assert.match(extractFunction(source, 'rebookCuesOnDrift'), /battleCues\.cancelDrifted\(window\.clockOffset, 300\)/);
});

test('an unselected commander has a visual-only all-captain monitor', () => {
  assert.match(source, /function shouldShowCommanderLaunchMonitor/);
  assert.match(source, /return rows\.slice\(0, 6\)/);
  assert.match(source, /cmd_watch_sub: "Commander view · silent"/);
  assert.match(source, /function shouldBookJoinAudio\(\)[\s\S]*!isCommanderDevice\(\)/);
});
