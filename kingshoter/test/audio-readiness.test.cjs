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

test('green readiness requires both the audio clock and a playing keep-alive carrier', () => {
  const sandbox = {
    soundReady: true,
    ac: { state: 'running' },
    keepAlive: true,
    keepAudio: { paused: false, ended: false }
  };
  vm.runInNewContext(`${extractFunction('audioAlive')}\nthis.audioAlive = audioAlive;`, sandbox);

  assert.equal(sandbox.audioAlive(), true);
  sandbox.keepAlive = false;
  assert.equal(sandbox.audioAlive(), false, 'a rejected carrier play cannot stay green');
  sandbox.keepAlive = true;
  sandbox.keepAudio.paused = true;
  assert.equal(sandbox.audioAlive(), false, 'a paused carrier cannot stay green');
  sandbox.keepAudio.paused = false;
  sandbox.keepAudio.ended = true;
  assert.equal(sandbox.audioAlive(), false, 'an ended carrier cannot stay green');
  sandbox.keepAudio.ended = false;
  sandbox.ac.state = 'suspended';
  assert.equal(sandbox.audioAlive(), false, 'a suspended audio clock cannot stay green');
});

test('carrier lifecycle transitions immediately refresh canonical readiness', () => {
  const start = extractFunction('startKeepAlive');
  const resume = extractFunction('resumeAudio');
  const transition = extractFunction('setKeepAliveState');

  assert.match(start, /addEventListener\(["']playing["'][\s\S]*setKeepAliveState\(true\)/);
  assert.match(start, /addEventListener\(["']pause["'][\s\S]*setKeepAliveState\(false\)/);
  assert.match(start, /\[["']waiting["'],\s*["']stalled["'],\s*["']error["'],\s*["']ended["']\]\.forEach[\s\S]*addEventListener\(eventName,[\s\S]*setKeepAliveState\(false\)/);
  assert.match(resume, /\.then\(function \(\) \{ setKeepAliveState\(true\); \}\)[\s\S]*\.catch\(function \(\) \{ setKeepAliveState\(false\); \}\)/);
  assert.match(transition, /sendDeviceStatus\(["']deviceStatus["'],\s*true\)/);
});

test('a suspended AudioContext immediately reports not-ready before resume completes', () => {
  function FakeAudioContext() {
    this.state = 'suspended';
    this.resume = () => {};
    this.onstatechange = null;
  }
  const statuses = [];
  const sandbox = {
    ac: null,
    AC: () => FakeAudioContext,
    window: {},
    navigator: {},
    sendDeviceStatus(type, force) { statuses.push({ type, force }); },
    paintAudioStatus() {}
  };
  vm.runInNewContext(`${extractFunction('ensureAudio')}\nthis.ensureAudio = ensureAudio;`, sandbox);
  sandbox.ensureAudio();
  statuses.length = 0;
  sandbox.ac.onstatechange();
  assert.deepEqual(statuses, [{ type: 'deviceStatus', force: true }]);
});
