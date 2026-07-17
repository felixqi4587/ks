const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadUmd(file) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, exports: module.exports, globalThis: {},
    Object, Array, String, Number, JSON, Math, RegExp, TypeError, Error
  }, { filename: file });
  return module.exports;
}

const DefenseDomain = loadUmd(path.join(__dirname, '../public/defense-domain.js'));
const BattleCues = loadUmd(path.join(__dirname, '../public/battle-cues.js'));
const plain = value => JSON.parse(JSON.stringify(value));

function order(nowMs) {
  return DefenseDomain.personalOrder({
    id: 'audio-order', revision: 9,
    signalAtMs: 1, acceptedAtMs: 2,
    tapAnchorSeconds: 180, enemyMarchSeconds: 30,
    enemyLaunchAtMs: 200_000, enemyImpactAtMs: 230_000,
    completeAtMs: 200_001,
    pid: 'listener', displayName: 'Listener',
    march: 30, marchRevision: 0, goAtMs: 200_000, tooLate: false
  }, 'listener', nowMs);
}

test('Defense schedules the existing shared cue grammar exactly once per order revision', () => {
  let nowMs = 180_000;
  const played = [];
  const cancelled = [];
  const audio = {
    nowSeconds: () => nowMs / 1000,
    schedule(event, when) {
      const node = { event: structuredClone(event), when };
      played.push(node);
      return [node];
    },
    cancel(nodes) { cancelled.push(...nodes); }
  };
  const scheduler = BattleCues.createCueScheduler({ audio, nowMs: () => nowMs });
  const personal = order(nowMs);
  const plan = {
    id: personal.planId,
    targetAtMs: personal.goAtMs,
    events: DefenseDomain.cuePlan(personal)
  };
  assert.equal(scheduler.reconcile([plan]), 12);
  assert.equal(scheduler.reconcile([plan]), 0);
  assert.deepEqual(played.map(item => [item.event.kind, item.event.name || '']), [
    ['prepare', ''],
    ['beep', ''], ['beep', ''], ['beep', ''], ['beep', ''], ['beep', ''],
    ['countdown', '5'], ['countdown', '4'], ['countdown', '3'],
    ['countdown', '2'], ['countdown', '1'], ['go', 'go']
  ]);
  assert.equal(played.filter(item => item.event.kind === 'go').length, 1);
});

test('reconnect and cancellation use the same scheduler for future-only cues', () => {
  let nowMs = 193_500;
  const played = [];
  const cancelled = [];
  const audio = {
    nowSeconds: () => nowMs / 1000,
    schedule(event) { const node = { event }; played.push(node); return [node]; },
    cancel(nodes) { cancelled.push(...nodes); }
  };
  const scheduler = BattleCues.createCueScheduler({ audio, nowMs: () => nowMs });
  const personal = order(nowMs);
  const events = DefenseDomain.cuePlan(personal);
  assert.deepEqual(plain(events.map(event => event.id)), [
    'beep-6', 'count-5', 'count-4', 'count-3', 'count-2', 'count-1', 'now'
  ]);
  scheduler.reconcile([{ id: personal.planId, targetAtMs: personal.goAtMs, events }]);
  assert.equal(played.some(node => node.event.id === 'beep-10'), false);
  assert.equal(scheduler.cancelScope(personal.planId), events.length);
  assert.equal(cancelled.length, events.length);

  nowMs = 200_001;
  const missed = order(nowMs);
  assert.equal(missed.tooLate, true);
  assert.deepEqual(plain(DefenseDomain.cuePlan(missed)), []);
  assert.equal(scheduler.reconcile([]), 0);
});

test('Defense sources contain no forked media path or Defend-now copy', () => {
  const domain = fs.readFileSync(path.join(__dirname, '../public/defense-domain.js'), 'utf8');
  const controller = fs.readFileSync(path.join(__dirname, '../public/defense-controller.js'), 'utf8');
  const combined = `${domain}\n${controller}`;
  assert.doesNotMatch(combined, /\/sfx\/(?:defense|defend)|defend(?:\s|_|-)now/i);
  assert.match(controller, /BattleAudio/);
  assert.match(controller, /BattleCues/);
});
