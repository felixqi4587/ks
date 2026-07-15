const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('the shipped KvK command room contains no standalone counter-rally workflow', () => {
  const shipped = [
    read('public/kvk.html'),
    read('public/kvk.js'),
    read('public/app.css'),
    read('public/app.js')
  ].join('\n');

  for (const forbidden of [
    'counterSetup',
    'counterDecision',
    'fireCounter',
    'kvk-core.js',
    'KvkCore',
    'enemyLandUTC',
    'landingGap',
    'scheduleDecisionCue',
    '反集结计算与发令',
    'Plan & fire counter rally'
  ]) {
    assert.equal(shipped.includes(forbidden), false, `remove counter-rally artifact: ${forbidden}`);
  }

  assert.equal(fs.existsSync(path.join(root, 'public/kvk-core.js')), false, 'remove the counter-only runtime module');
  assert.equal(fs.existsSync(path.join(root, 'test/kvk-core.test.cjs')), false, 'remove the counter-only unit tests');
  assert.equal(fs.existsSync(path.join(root, 'test/counter-rally.cjs')), false, 'remove the counter-only browser test');
});

test('the default command room keeps its normal controls and does not add the rejected SOP hint', () => {
  const html = read('public/kvk.html');
  const js = read('public/kvk.js');
  const shipped = html + '\n' + js;

  assert.match(html, /id="lead"/);
  assert.match(html, /id="fireDouble"/);
  assert.match(html, /id="cancelBtn"/);
  assert.match(html, /id="defenseDemoNote"/);
  assert.doesNotMatch(shipped, /敌开车约一分钟后联盟2开双集结/);
  assert.doesNotMatch(shipped, /enemy.{0,20}(one minute|1 minute).{0,30}(alliance 2|second alliance)/i);
});

test('personal staggered launch timing remains the default command model', () => {
  const js = read('public/kvk.js');

  assert.match(js, /type:\s*["']double_rally["']/);
  assert.match(js, /type:\s*["']triple_rally["']/,
    'Triple is an additional launch type inside the same command console');
  assert.match(js, /off\s*=\s*\(main\.march\s*-\s*weak\.march\)\s*-\s*1/);
  assert.match(js, /pressUTC:\s*ps/);
  assert.match(js, /pressUTC:\s*pm/);
  assert.match(js, /leadSeconds:\s*lead/, 'the selected lead travels with the command');
  assert.match(js, /window\.serverNow\(\)\s*\/\s*1000/, 'launch targets retain sub-second precision');
  assert.match(js, /p\.pid\s*===\s*myPid/);
  assert.match(js, /function schedulePrepareCue\(/, 'later-captain preparation audio is isolated from the shared countdown scheduler');
  assert.match(js, /tg\.anchor\s*>\s*firstPress/, 'only a captain launching after firstPress receives a countdown-start cue');
  assert.match(js, /rem\s*>\s*countdownLead/, 'a later captain waits instead of seeing a number above the selected lead');
  assert.doesNotMatch(js, /targetSec\s*-\s*15/, 'there is no fixed T-15 cue when another lead was selected');
  assert.doesNotMatch(js, /\[15,\s*10,\s*9/, 'the common 10-to-GO sequence remains unchanged');
});
