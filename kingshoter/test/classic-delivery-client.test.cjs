const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'public', 'rally-controller.js'), 'utf8');
const audioScript = fs.readFileSync(path.join(root, 'public', 'battle-audio.js'), 'utf8');
const cuesScript = fs.readFileSync(path.join(root, 'public', 'battle-cues.js'), 'utf8');
const deliveryScript = fs.readFileSync(path.join(root, 'public', 'battle-delivery.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'rally.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'app.css'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated ${name}`);
}

function stageIntentBlocksFire(pendingStageMutation, queuedStageByK, kingdom) {
  const context = { pendingStageMutation, queuedStageByK, kingdom, result: null };
  vm.runInNewContext(`${extractFunction(script, 'stageIntentBlocksFire')}; result = stageIntentBlocksFire(kingdom);`, context);
  return context.result;
}

test('Classic client confirms only canonical persisted delivery ACKs and retries with bounded backoff', () => {
  assert.match(script, /function hasFuturePersonalCue\(/);
  assert.match(script, /function acknowledgeClassicCommand\(/);
  assert.match(script, /if\s*\(!syncedOK\)\s*return false/);
  assert.match(script, /outcome\s*=\s*[^;]*["']expired["']/);
  assert.match(script, /message\.t\s*!==\s*["']deliveryAckSaved["']/);
  assert.match(script, /sameDeliveryAck\(entry\.payload,\s*message\)/);
  assert.match(deliveryScript, /DEFAULT_RETRY_DELAYS_MS\s*=\s*\[1200,\s*2400,\s*5000,\s*10000,\s*15000\]/);
  assert.doesNotMatch(deliveryScript, /ACK_MAX_ATTEMPTS/);
  assert.match(deliveryScript, /if\s*\(sent\)\s*entry\.attempts\s*\+=\s*1/);
  assert.match(deliveryScript, /rejectedEntries/);
  assert.match(script, /function rejectPendingDeliveryAck\(/);
  assert.match(script, /message\.source\s*!==\s*["']deliveryAck["']/);
  assert.match(script, /rejected\.lastGeneration\s*!==\s*generation/);
  assert.match(script, /function handleDeviceStatusSaved\(/);
  assert.match(script, /message\.t\s*!==\s*["']deviceStatusSaved["']/);
  assert.match(script, /DEVICE_STATUS_RETRY_MS/);
  assert.match(script, /lastDeviceStatusSentAt/);
  assert.match(script, /delivery_persist_failed/);
  assert.match(script, /connectionGeneration/);
});

test('Classic ACK state is a compatibility adapter over the shared generation-scoped queue', () => {
  assert.match(html, /battle-delivery\.js\?v=2026071701/);
  assert.ok(
    html.indexOf('/battle-delivery.js?v=2026071701') < html.indexOf('/rally-controller.js?v=2026071701'),
    'delivery module loads before the Rally controller'
  );
  assert.match(script, /BattleDelivery\.createAckQueue\(\{/);
  assert.match(extractFunction(script, 'deliveryAckKey'), /BattleDelivery\.ackKey\(/);
  assert.match(extractFunction(script, 'sendPendingDeliveryAck'), /deliveryAckQueue\.send\(key,\s*force/);
  assert.match(extractFunction(script, 'retryPendingDeliveryAcks'), /deliveryAckQueue\.retryAll\(force/);
  assert.doesNotMatch(script, /var\s+pendingDeliveryAcks\s*=/);
});

test('returning profiles force a fresh device binding as soon as canonical registration appears', () => {
  assert.match(script, /becameCanonical[\s\S]{0,180}sendDeviceStatus\(["']deviceStatus["'],\s*true\)/);
});

test('a rejected readiness persistence clears coalescing guards before retrying', () => {
  assert.match(script, /device_status_persist_failed/);
  assert.match(script, /function clearDeviceStatusGuards\([\s\S]{0,500}clearTimeout\(deviceStatusGreenTimer\)/);
  assert.match(script, /function clearDeviceStatusGuards\([\s\S]{0,700}lastDeviceStatusSentSignature\s*=\s*["']["']/);

  const handler = extractFunction(script, 'handleDeviceStatusError');
  const calls = [];
  const timers = [];
  const sandbox = {
    DEVICE_STATUS_RETRY_MS: 1200,
    clearDeviceStatusGuards() { calls.push('clear'); },
    sendDeviceStatus(type, force) { calls.push([type, force]); },
    setTimeout(callback, delay) { timers.push({ callback, delay }); }
  };
  vm.runInNewContext(`${handler}; this.handle = handleDeviceStatusError;`, sandbox);
  assert.equal(sandbox.handle({ source: 'deviceStatus', error: 'device_status_persist_failed' }), true);
  assert.deepEqual(calls, ['clear']);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 1200);
  timers[0].callback();
  assert.deepEqual(calls, ['clear', ['deviceStatus', true]]);
});

test('identity rejection clears every readiness guard without an immediate retry loop', () => {
  const reset = extractFunction(script, 'clearDeviceStatusGuards');
  const cleared = [];
  const sandbox = {
    deviceStatusGreenTimer: 9,
    pendingGreenGeneration: 7,
    pendingGreenSignature: 'pending',
    lastDeviceStatusSignature: 'confirmed',
    lastDeviceStatusGeneration: 7,
    lastDeviceStatusSentSignature: 'sent',
    lastDeviceStatusSentGeneration: 7,
    lastDeviceStatusSentAt: 123,
    clearTimeout(id) { cleared.push(id); }
  };
  vm.runInNewContext(`${reset}; this.reset = clearDeviceStatusGuards;`, sandbox);
  sandbox.reset();
  assert.deepEqual(cleared, [9]);
  assert.deepEqual({
    timer: sandbox.deviceStatusGreenTimer,
    pendingGeneration: sandbox.pendingGreenGeneration,
    pendingSignature: sandbox.pendingGreenSignature,
    confirmedGeneration: sandbox.lastDeviceStatusGeneration,
    confirmedSignature: sandbox.lastDeviceStatusSignature,
    sentGeneration: sandbox.lastDeviceStatusSentGeneration,
    sentSignature: sandbox.lastDeviceStatusSentSignature,
    sentAt: sandbox.lastDeviceStatusSentAt
  }, {
    timer: 0, pendingGeneration: -1, pendingSignature: '',
    confirmedGeneration: -1, confirmedSignature: '',
    sentGeneration: -1, sentSignature: '', sentAt: 0
  });

  const handler = extractFunction(script, 'handleDeviceStatusError');
  let helperClears = 0;
  let helperRetries = 0;
  let pendingReleases = 0;
  const handlerSandbox = {
    DEVICE_STATUS_RETRY_MS: 1200,
    pendingMarchMutation: { awaitingDeviceStatus: true },
    clearDeviceStatusGuards() { helperClears += 1; },
    releasePendingOwnProfileMutation() { pendingReleases += 1; },
    sendDeviceStatus() { helperRetries += 1; },
    setTimeout() { helperRetries += 1; }
  };
  vm.runInNewContext(`${handler}; this.handle = handleDeviceStatusError;`, handlerSandbox);
  for (const error of ['invalid_device_identity', 'socket_identity_locked', 'device_owned_by_other_pid']) {
    assert.equal(handlerSandbox.handle({ source: 'deviceStatus', error }), true);
  }
  assert.equal(helperClears, 3);
  assert.equal(pendingReleases, 3, 'terminal binding errors release a queued profile edit');
  assert.equal(helperRetries, 0, 'identity errors never start an immediate retry loop');
  assert.equal(handlerSandbox.handle({ source: 'deliveryAck', error: 'invalid_device_identity' }), false);
  assert.equal(helperClears, 3);
});

test('every AudioContext transition immediately refreshes canonical device readiness', () => {
  assert.match(audioScript, /context\.onstatechange = function \(\)[\s\S]*context\.state !== "running"[\s\S]*notify\(\)/);
  assert.match(extractFunction(script, 'onBattleAudioStateChange'), /sendDeviceStatus\("deviceStatus", true\)/);
  assert.doesNotMatch(extractFunction(script, 'onBattleAudioStateChange'), /if\s*\([^)]*running[^)]*\)\s*sendDeviceStatus/);
});

test('every reconnect and resume closes the ACK gate until a fresh time sync succeeds', () => {
  assert.match(script, /function beginClockSync\(/);
  assert.match(script, /attempt\s*!==\s*syncAttempt/);
  assert.match(script, /window\.clockOffset\s*=\s*lastAcceptedClockOffset/);
  assert.match(script, /function onResume\(\)\s*\{[^}]*beginClockSync\(\)/);
  assert.match(script, /sock\.onOpen\s*=\s*function\s*\(\)\s*\{[^}]*beginClockSync\(\)/);
});

test('a large clock correction stops stale audio nodes even when the target is now past', () => {
  assert.doesNotMatch(cuesScript, /entry\.atMs\s*>[\s\S]{0,80}Math\.abs/);
  assert.match(cuesScript, /Math\.abs\(entry\.clockOffsetMs - current\) > threshold/);
  assert.match(extractFunction(script, 'rebookCuesOnDrift'), /battleCues\.cancelDrifted\(window\.clockOffset, 300\)/);
});

test('Fire consumes same-kingdom queued stage intent before a late broadcast can revive it', () => {
  assert.match(script, /function consumeStageForFire\(/);
  assert.match(script, /if\s*\(ok\)\s*consumeStageForFire\(commandKingdom\)/);
  assert.match(script, /function handleStageSuperseded\(/);
  const currentQueue = { 1: { picks: [{ pid: 'a' }, { pid: 'b' }] }, 2: null };
  assert.equal(stageIntentBlocksFire(null, currentQueue, 1), false);
  assert.equal(stageIntentBlocksFire({ kingdom: 1 }, currentQueue, 1), false);
  assert.equal(stageIntentBlocksFire({ kingdom: 2 }, currentQueue, 1), true);
  assert.equal(stageIntentBlocksFire({ kingdom: 1 }, { 1: currentQueue[1], 2: { picks: [{ pid: 'c' }] } }, 1), true);
});

test('Classic commander keeps fired slots visible and reserves green for receipt', () => {
  assert.match(script, /function deliveryForPlayer\(/);
  assert.match(script, /liveCommand/);
  assert.match(script, /deliveryStatusTimer/);
  assert.match(css, /\.delivery\.received/);
  assert.match(css, /\.delivery\.received\.partial/);
});

test('Rally cache versions move atomically with the delivery client and styles', () => {
  assert.match(html, /app\.css\?v=2026071701/);
  assert.match(html, /rally-update\.js\?v=2026071701/);
  assert.match(html, /app\.js\?v=2026071701/);
  assert.match(html, /rally-room\.js\?v=2026071701/);
  assert.match(html, /rally-delivery-shadow\.js\?v=2026071701/);
  assert.match(html, /rally-domain\.js\?v=2026071701/);
  assert.match(html, /rally-controller\.js\?v=2026071701/);
});
