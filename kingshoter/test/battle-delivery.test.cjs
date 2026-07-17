const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const deliveryPath = path.join(__dirname, '../public/battle-delivery.js');
const deliveryModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(deliveryPath, 'utf8'), {
  module: deliveryModule, exports: deliveryModule.exports, globalThis: {},
  Object, Array, String, Number, Math, TypeError, Error
}, { filename: deliveryPath });
const BattleDelivery = deliveryModule.exports;

test('BattleDelivery exposes the same frozen browser UMD surface', () => {
  const globalThis = {};
  vm.runInNewContext(fs.readFileSync(deliveryPath, 'utf8'), {
    globalThis, Object, Array, String, Number, Math, TypeError, Error
  }, { filename: deliveryPath });
  assert.equal(Object.isFrozen(globalThis.BattleDelivery), true);
  assert.deepEqual(Object.keys(globalThis.BattleDelivery).sort(), Object.keys(BattleDelivery).sort());
});

function harness(overrides = {}) {
  let now = overrides.nowMs ?? 1_000;
  let generation = overrides.generation ?? 1;
  let nextTimer = 1;
  const timers = new Map();
  const sent = [];
  const queue = BattleDelivery.createAckQueue({
    send(payload) { sent.push({ payload, generation, at: now }); return overrides.sendResult !== false; },
    nowMs() { return now; },
    generation() { return generation; },
    retryDelaysMs: [100, 200, 400],
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  });
  return {
    queue, sent, timers,
    setNow(value) { now = value; },
    setGeneration(value) { generation = value; },
    runTimer(id) {
      const timer = timers.get(id);
      assert.ok(timer, `missing timer ${id}`);
      timers.delete(id);
      timer.callback();
    }
  };
}

test('delivery key includes order, revision, profile, and device identity', () => {
  assert.equal(BattleDelivery.ackKey({
    orderId: 'order-a', revision: 7, pid: 'profile-a', deviceId: 'device-a'
  }), 'order-a:7:profile-a:device-a');
  assert.throws(() => BattleDelivery.ackKey({ orderId: 'order-a', pid: 'profile-a', deviceId: 'device-a' }), /revision/);
  assert.throws(() => BattleDelivery.ackKey({ orderId: 'order-a', revision: 1, pid: '', deviceId: 'device-a' }), /pid/);
});

test('enqueue is idempotent and retries with bounded backoff', () => {
  const h = harness();
  const item = { key: 'order:1:pid:device', scope: 'order:1', payload: { t: 'ack', n: 1 }, deadlineAtMs: 10_000 };
  assert.equal(h.queue.enqueue(item), true);
  assert.equal(h.sent.length, 1);
  assert.deepEqual([...h.timers.values()].map(timer => timer.delay), [100]);

  assert.equal(h.queue.enqueue({ ...item, payload: { t: 'ack', n: 2 } }), false);
  assert.equal(h.sent.length, 1, 'duplicate enqueue cannot replace or resend an in-flight ACK');
  assert.equal(h.queue.pending(item.key).payload.n, 1);

  h.runTimer([...h.timers.keys()][0]);
  assert.equal(h.sent.length, 2);
  assert.deepEqual([...h.timers.values()].map(timer => timer.delay), [200]);
});

test('retry payload is frozen at enqueue and cannot drift between generations', () => {
  const h = harness();
  const payload = { t: 'ack', outcome: 'scheduled' };
  h.queue.enqueue({ key: 'order:1:pid:device', payload, deadlineAtMs: 10_000 });
  payload.outcome = 'too_late';
  h.setGeneration(2);
  h.queue.retryAll();
  assert.deepEqual(h.sent.map(entry => entry.payload.outcome), ['scheduled', 'scheduled']);
  assert.equal(Object.isFrozen(h.queue.pending('order:1:pid:device').payload), true);
});

test('a disconnected initial send reports false while retaining its bounded retry', () => {
  const h = harness({ sendResult: false });
  const key = 'order:1:pid:device';
  assert.equal(h.queue.enqueue({ key, payload: { t: 'ack' }, deadlineAtMs: 10_000 }), false);
  assert.ok(h.queue.pending(key));
  assert.equal(h.queue.pending(key).attempts, 0);
  assert.equal(h.timers.size, 1);
});

test('a new connection generation resets backoff and retries once', () => {
  const h = harness();
  const key = 'order:1:pid:device';
  h.queue.enqueue({ key, payload: { t: 'ack' }, deadlineAtMs: 10_000 });
  h.runTimer([...h.timers.keys()][0]);
  assert.equal(h.queue.pending(key).attempts, 2);

  h.setGeneration(2);
  assert.equal(h.queue.retryAll(), 1);
  assert.equal(h.sent.length, 3);
  assert.equal(h.queue.pending(key).attempts, 1);
  assert.deepEqual([...h.timers.values()].map(timer => timer.delay), [100]);

  assert.equal(h.queue.retryAll(), 0, 'same generation does not duplicate an armed retry');
  assert.equal(h.sent.length, 3);
});

test('deadline cutoff removes an ACK and stale timers cannot revive it', () => {
  const h = harness();
  const key = 'order:1:pid:device';
  h.queue.enqueue({ key, payload: { t: 'ack' }, deadlineAtMs: 1_050 });
  const timerId = [...h.timers.keys()][0];
  h.setNow(1_051);
  h.runTimer(timerId);
  assert.equal(h.queue.pending(key), null);
  assert.equal(h.sent.length, 1);
  assert.equal(h.timers.size, 0);
});

test('confirmation and cancellation are idempotent and stop timers', () => {
  const h = harness();
  h.queue.enqueue({ key: 'a:1:p:d', scope: 'a:1', payload: { n: 1 }, deadlineAtMs: 10_000 });
  h.queue.enqueue({ key: 'a:1:q:e', scope: 'a:1', payload: { n: 2 }, deadlineAtMs: 10_000 });
  h.queue.enqueue({ key: 'b:1:p:d', scope: 'b:1', payload: { n: 3 }, deadlineAtMs: 10_000 });

  assert.equal(h.queue.confirm('a:1:p:d'), true);
  assert.equal(h.queue.confirm('a:1:p:d'), false);
  assert.equal(h.queue.isConfirmed('a:1:p:d'), true);
  assert.equal(h.queue.pending('a:1:p:d'), null);

  assert.equal(h.queue.cancelScope('a:1'), 2, 'scope removes pending and confirmed state');
  assert.equal(h.queue.cancelScope('a:1'), 0);
  assert.ok(h.queue.pending('b:1:p:d'));
  assert.equal(h.timers.size, 1);
});

test('scope cancellation observes segment boundaries', () => {
  const h = harness();
  h.queue.enqueue({ key: 'a:1:p:d', scope: 'a:1', payload: { n: 1 }, deadlineAtMs: 10_000 });
  h.queue.enqueue({ key: 'a:10:p:d', scope: 'a:10', payload: { n: 2 }, deadlineAtMs: 10_000 });
  assert.equal(h.queue.cancelScope('a:1'), 1);
  assert.ok(h.queue.pending('a:10:p:d'), 'revision 10 is not a child of revision 1');
});

test('reconnect resumes only nonterminal rejection in a later generation', () => {
  const h = harness();
  const recoverable = 'a:1:p:d';
  const terminal = 'a:1:q:e';
  h.queue.enqueue({ key: recoverable, payload: { n: 1 }, deadlineAtMs: 10_000 });
  h.queue.enqueue({ key: terminal, payload: { n: 2 }, deadlineAtMs: 10_000 });
  h.queue.reject(recoverable, { error: 'bad_delivery_identity', terminal: false });
  h.queue.reject(terminal, { error: 'ack_conflict', terminal: true });
  assert.equal(h.timers.size, 0);

  assert.equal(h.queue.retryAll(), 0, 'same generation keeps rejected ACK paused');
  h.setGeneration(2);
  assert.equal(h.queue.retryAll(), 1);
  assert.equal(h.queue.rejected(recoverable), null);
  assert.ok(h.queue.pending(recoverable));
  assert.ok(h.queue.rejected(terminal));
  assert.equal(h.sent.filter(entry => entry.payload.n === 1).length, 2);
  assert.equal(h.sent.filter(entry => entry.payload.n === 2).length, 1);
});

test('forced reconnect retries a recoverable rejection exactly once', () => {
  const h = harness();
  const key = 'a:1:p:d';
  h.queue.enqueue({ key, payload: { n: 1 }, deadlineAtMs: 10_000 });
  h.queue.reject(key, { error: 'bad_delivery_identity', terminal: false });
  h.setGeneration(2);
  assert.equal(h.queue.retryAll(true), 1);
  assert.equal(h.sent.length, 2, 'resume send is not repeated by the pending pass');
  assert.equal(h.queue.pending(key).attempts, 1);
});

test('pause and explicit retry preserve reconnect-safe pending state', () => {
  const h = harness();
  const key = 'a:1:p:d';
  h.queue.enqueue({ key, payload: { n: 1 }, deadlineAtMs: 10_000 });
  assert.equal(h.queue.pause(), 1);
  assert.equal(h.timers.size, 0);
  assert.ok(h.queue.pending(key));
  assert.equal(h.queue.retryAll(true), 1);
  assert.equal(h.sent.length, 2);
  assert.equal(h.timers.size, 1);
});

test('confirmed and cancelled keys remain generation-scoped and never resend', () => {
  const h = harness();
  h.queue.enqueue({ key: 'done:1:p:d', scope: 'done:1', payload: { n: 1 }, deadlineAtMs: 10_000 });
  h.queue.confirm('done:1:p:d');
  h.queue.enqueue({ key: 'cancel:1:p:d', scope: 'cancel:1', payload: { n: 2 }, deadlineAtMs: 10_000 });
  h.queue.cancel('cancel:1:p:d');
  h.setGeneration(2);
  assert.equal(h.queue.retryAll(), 0);
  assert.equal(h.sent.length, 2);
});
