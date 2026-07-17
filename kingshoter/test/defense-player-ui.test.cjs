const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function loadUmd(file) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, exports: module.exports, globalThis: {},
    Object, Array, String, Number, JSON, Math, RegExp, TypeError, Error
  }, { filename: file });
  return module.exports;
}

const DefenseController = loadUmd(path.join(root, 'public/defense-controller.js'));

function source(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

test('Defense ordinary page keeps the approved constant-size mobile reading order', () => {
  const html = source('public/defense.html');
  const ids = [
    'defenseStatus', 'defenseProfileCard', 'defenseAudioRow',
    'defenseProgress', 'defensePersonal', 'defenseConsoleEntry'
  ];
  let previous = -1;
  for (const id of ids) {
    const index = html.indexOf(`id="${id}"`);
    assert.ok(index > previous, `${id} follows the approved ordinary reading order`);
    previous = index;
  }
  assert.match(html, /<main\b[^>]*class="[^"]*battle-shell/);
  assert.match(html, /id="defenseStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="defenseLocalClock"[^>]*aria-hidden="true"/,
    'the changing wall clock is excluded from the polite status announcement');
  assert.match(html, /id="defenseProgressCard"[^>]*hidden/,
    'no fake personal distance is exposed before a profile exists');
  assert.match(html, /id="defenseProgress"[^>]*role="progressbar"[^>]*aria-valuemin="5"[^>]*aria-valuemax="120"/);
  assert.doesNotMatch(html, /id="defenseProgress"[^>]*aria-valuenow=/,
    'the unregistered initial progressbar has no fabricated five-second value');
  assert.match(html, /id="defenseCountdownLive"[^>]*aria-live="assertive"/);
  assert.match(html, /id="defenseIdentityValue"[^>]*class="[^"]*battle-identity-input/);
  assert.match(html, /id="defenseYouStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /<meta\s+name="viewport"\s+content="width=device-width,\s*initial-scale=1,\s*viewport-fit=cover">/);
});

test('ordinary Defense contains no roster, manager metrics, tactical radar, or legacy calculator', () => {
  const html = source('public/defense.html');
  const controller = source('public/defense-controller.js');
  assert.doesNotMatch(html, /playersPage|defenseManagerState|registeredProfiles|connectedProfiles/i);
  assert.doesNotMatch(html, /\bid="(?:roster|playersList|radar|dsvg|enemyList|whaleChips)"/i);
  assert.doesNotMatch(html, /Attack\s*\/\s*Defense|enemy whale|castle radar/i);
  assert.doesNotMatch(controller, /playersPage|registeredProfiles|connectedProfiles/);
});

test('Defense browser wiring reuses every shared battle foundation on surface defense', () => {
  const html = source('public/defense.html');
  const controller = source('public/defense-controller.js');
  const scripts = [
    'battle-connection.js', 'battle-status.js', 'battle-audio.js', 'battle-cues.js',
    'battle-identity.js', 'battle-delivery.js', 'defense-domain.js', 'defense-controller.js'
  ];
  let previous = -1;
  for (const script of scripts) {
    const index = html.indexOf(`src="/${script}`);
    assert.ok(index > previous, `${script} loads in dependency order`);
    previous = index;
  }
  assert.match(controller, /createRoomConnection\(\{[\s\S]*surface:\s*"defense"/);
  assert.match(controller, /BattleAudio\.createAudioEngine/);
  assert.match(controller, /BattleCues\.createCueScheduler/);
  assert.match(controller, /BattleDelivery\.createAckQueue/);
  assert.match(controller, /BattleIdentity\.createIdentityStore/);
  assert.match(controller, /BattleStatus/);
  assert.doesNotMatch(html, /src="\/app\.js/);
});

test('English and Chinese Defense strings use website-only truth and exact Now copy', () => {
  const controller = source('public/defense-controller.js');
  for (const value of [
    'Defense Coordination', '防守协调',
    'Enable page alerts', '开启页面提醒',
    'Waiting for the next Defense order', '等待下一轮防守指令',
    'Your alert is complete', '本轮提醒已完成',
    'Connected · confirming this device', '已连接 · 正在确认本设备',
    'Connected · alert status unconfirmed', '已连接 · 提醒状态尚未确认',
    'Alerts on · switch to the game', '提醒已开启 · 可切换到游戏',
    'Switch language', '切换语言', 'Identity type', '身份类型',
    'Decrease march time', '减少行军时间', 'Increase march time', '增加行军时间',
    'Now'
  ]) assert.ok(controller.includes(value), `contains ${value}`);
  assert.doesNotMatch(controller, /responded|arrived|joined the game|successfully defended/i);
  assert.doesNotMatch(controller, /Defend now/i);
});

test('Defense-specific CSS retains mobile accessibility and no decorative waiting loop', () => {
  const css = source('public/defense.css');
  assert.match(css, /\.defense-identity-input[\s\S]*font-size:\s*16px/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /text-overflow:\s*ellipsis/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/);
  assert.doesNotMatch(css, /animation[^;{]*:\s*[^;]*(?:infinite|infinity)/i);
});

test('identity mode keyboard navigation supports the complete custom-radiogroup contract', () => {
  const move = DefenseController.identityModeForKey;
  assert.equal(move('playerId', 'ArrowRight'), 'nickname');
  assert.equal(move('playerId', 'ArrowDown'), 'nickname');
  assert.equal(move('nickname', 'ArrowLeft'), 'playerId');
  assert.equal(move('nickname', 'ArrowUp'), 'playerId');
  assert.equal(move('nickname', 'Home'), 'playerId');
  assert.equal(move('playerId', 'End'), 'nickname');
  assert.equal(move('playerId', 'Tab'), null);
});

test('connected-but-unbound readiness uses accurate non-green wording', () => {
  const present = DefenseController.statusPresentation;
  const text = {
    disconnected: 'lost', confirming: 'confirming', statusUnconfirmed: 'unconfirmed',
    ready: 'ready', enable: 'enable', restore: 'restore', timeSyncing: 'time'
  };
  const base = {
    connected: true,
    handshakeComplete: false,
    audio: { userEnabled: true, audioContextRunning: true, carrierAlive: true },
    clockFresh: true,
    readiness: { green: false, reasons: ['handshake_pending'] }
  };
  assert.equal(present(base, text).label, 'confirming');
  assert.equal(present(base, text).level, 'warning');
  assert.equal(present({
    ...base, handshakeComplete: true,
    readiness: { green: false, reasons: ['binding_unconfirmed'] }
  }, text).label, 'confirming');
  assert.equal(present({
    ...base, handshakeComplete: true,
    readiness: { green: false, reasons: ['device_status_unconfirmed'] }
  }, text).label, 'unconfirmed');
  assert.equal(present({
    ...base, handshakeComplete: true,
    audio: { userEnabled: false, audioContextRunning: false, carrierAlive: false },
    readiness: { green: false, reasons: ['audio_disabled', 'device_status_unconfirmed'] }
  }, text).label, 'enable');
  assert.equal(present({ ...base, connected: false }, text).label, 'lost');
});
