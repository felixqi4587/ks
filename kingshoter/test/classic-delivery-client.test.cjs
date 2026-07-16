const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'public', 'kvk.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'kvk.html'), 'utf8');
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
  assert.match(script, /DELIVERY_ACK_RETRY_DELAYS_MS/);
  assert.doesNotMatch(script, /DELIVERY_ACK_MAX_ATTEMPTS/);
  assert.match(script, /if\s*\(sent\)\s*entry\.attempts\s*\+=\s*1/);
  assert.match(script, /rejectedDeliveryAcks/);
  assert.match(script, /function rejectPendingDeliveryAck\(/);
  assert.match(script, /message\.source\s*!==\s*["']deliveryAck["']/);
  assert.match(script, /rejected\.generation\s*!==\s*generation/);
  assert.match(script, /function handleDeviceStatusSaved\(/);
  assert.match(script, /message\.t\s*!==\s*["']deviceStatusSaved["']/);
  assert.match(script, /DEVICE_STATUS_RETRY_MS/);
  assert.match(script, /lastDeviceStatusSentAt/);
  assert.match(script, /delivery_persist_failed/);
  assert.match(script, /connectionGeneration/);
});

test('returning profiles force a fresh device binding as soon as canonical registration appears', () => {
  assert.match(script, /becameCanonical[\s\S]{0,180}sendDeviceStatus\(["']deviceStatus["'],\s*true\)/);
});

test('every AudioContext transition immediately refreshes canonical device readiness', () => {
  assert.match(script, /ac\.onstatechange\s*=\s*function\s*\(\)\s*\{[\s\S]{0,220}ac\.state\s*!==\s*["']running["'][\s\S]{0,160}sendDeviceStatus\(["']deviceStatus["'],\s*true\)/);
  assert.doesNotMatch(script, /if\s*\(ac\.state\s*===\s*["']running["']\)\s*sendDeviceStatus/);
});

test('every reconnect and resume closes the ACK gate until a fresh time sync succeeds', () => {
  assert.match(script, /function beginClockSync\(/);
  assert.match(script, /attempt\s*!==\s*syncAttempt/);
  assert.match(script, /window\.clockOffset\s*=\s*lastAcceptedClockOffset/);
  assert.match(script, /function onResume\(\)\s*\{[^}]*beginClockSync\(\)/);
  assert.match(script, /sock\.onOpen\s*=\s*function\s*\(\)\s*\{[^}]*beginClockSync\(\)/);
});

test('a large clock correction stops stale audio nodes even when the target is now past', () => {
  assert.doesNotMatch(script, /e\.t\s*>\s*nowMs\s*\+\s*400\s*&&\s*Math\.abs\(/);
  assert.match(script, /Math\.abs\(\(e\.off\s*\|\|\s*0\)\s*-\s*window\.clockOffset\)\s*>\s*300\)\s*\{\s*stopCue\(e\);\s*delete scheduledBeeps\[k\]/);
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

test('KvK cache versions move atomically with the delivery client and styles', () => {
  assert.match(html, /app\.css\?v=2026071506/);
  assert.match(html, /kvk-update\.js\?v=2026071506/);
  assert.match(html, /app\.js\?v=2026071506/);
  assert.match(html, /kvk-delivery-shadow\.js\?v=2026071506/);
  assert.match(html, /kvk-rally\.js\?v=2026071506/);
  assert.match(html, /kvk\.js\?v=2026071506/);
});
