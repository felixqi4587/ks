const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const testDir = __dirname;
const cjsGuardCall = "require('./support/legacy-kvk-script-guard.cjs')(__filename);";
const esmGuardCall = 'stopLegacyKvkScript(import.meta.filename);';

const quarantinedScripts = [
  'alertsui.cjs',
  'beepmode.cjs',
  'bgshots.cjs',
  'cmdshot.cjs',
  'coldux.cjs',
  'dbgrow.cjs',
  'defense.cjs',
  'departshot.cjs',
  'diag.cjs',
  'diag2.cjs',
  'diag3.cjs',
  'e2e.cjs',
  'final.cjs',
  'final2.cjs',
  'fixes.cjs',
  'idlemap.cjs',
  'ios.cjs',
  'iosshot.cjs',
  'liveshot.cjs',
  'mapnote.cjs',
  'mapshot.cjs',
  'ob.cjs',
  'rbshots.cjs',
  'ready.cjs',
  'rebuild.cjs',
  'redesign-shots.cjs',
  'redesign.cjs',
  'shots.cjs',
  'smoke.cjs',
  'ta.cjs',
  'v2.cjs',
  'v2shots.cjs',
  'v3.cjs',
  'v3shots.cjs',
  'v4.cjs',
  'v5.cjs',
  'v6.cjs',
  'v6dbg.cjs',
  'v7.cjs',
  'v7dbg.cjs',
  'v7shot.cjs',
  'v8.cjs',
  'ws-smoke.mjs'
].sort();

const localQaRunners = [
  'alert-truth.cjs',
  'bg.cjs',
  'lead-timing.cjs',
  'mineaudio.cjs',
  'multikingdom.cjs'
].sort();

function executableManualKvkScripts() {
  return fs.readdirSync(testDir)
    .filter(file => /\.(?:cjs|mjs|js)$/.test(file))
    .filter(file => !/\.(?:test|e2e|spec)\.cjs$/.test(file))
    .filter(file => {
      const source = fs.readFileSync(path.join(testDir, file), 'utf8');
      const canOpenNetwork = /require\(["']playwright["']\)|from\s+["']playwright["']|require\(["']ws["']\)|from\s+["']ws["']|new WebSocket\s*\(/.test(source);
      const targetsKvk = /\/kvk(?:\.html)?|\/api\/ws|qaRoomUrl|makeQaRoom|[?&]room=/.test(source);
      return canOpenNetwork && targetsKvk;
    })
    .sort();
}

test('every manual KvK network script has an explicit safety classification', () => {
  assert.deepEqual(
    executableManualKvkScripts(),
    [...quarantinedScripts, ...localQaRunners].sort(),
    'new manual KvK network scripts must be quarantined or explicitly hardened as local QA runners'
  );
});

test('every retained legacy KvK script is disabled before browser or WebSocket launch', () => {
  for (const file of quarantinedScripts) {
    const source = fs.readFileSync(path.join(testDir, file), 'utf8');
    const isEsm = file.endsWith('.mjs');
    const guardIndex = source.indexOf(isEsm ? esmGuardCall : cjsGuardCall);
    const networkIndex = source.search(/require\(["']playwright["']\)|from\s+["']playwright["']|chromium\.launch\s*\(|new WebSocket\s*\(/);
    assert.ok(guardIndex >= 0, `${file} must install the legacy-script stop guard`);
    if (networkIndex >= 0) {
      assert.ok(guardIndex < networkIndex, `${file} must stop before browser or WebSocket launch`);
    }
  }
});

test('every retained manual QA runner is locked to a generated room and exact local origin', () => {
  for (const file of localQaRunners) {
    const source = fs.readFileSync(path.join(testDir, file), 'utf8');
    assert.match(source, /localQaBaseURL/, `${file} must reject non-loopback origins`);
    assert.match(source, /makeQaRoom/, `${file} must generate a qa-kvk-* room`);
    assert.match(source, /installQaWebSocketGuard/, `${file} must guard its WebSocket room`);
    assert.match(source, /expectedOrigin\s*:/, `${file} must guard the exact WebSocket origin`);
  }
});

test('the legacy-script stop guard always fails closed with the safe replacement command', () => {
  const stop = require('./support/legacy-kvk-script-guard.cjs');
  assert.throws(
    () => stop('/tmp/old-script.cjs'),
    error => /disabled legacy KvK script/i.test(error.message) &&
      /npm run test:qa:(?:delivery|triple)/i.test(error.message)
  );
});
