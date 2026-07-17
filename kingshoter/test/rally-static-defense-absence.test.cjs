const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const rallyHtml = read('public/rally.html');
const rallyRuntime = read('public/rally-controller.js');
const rallyDomain = read('public/rally-domain.js');
const rallyCss = read('public/rally.css');
const appCss = read('public/app.css');
const defenseHtml = read('public/defense.html');

test('canonical Rally contains no legacy static Defense surface or commander editor', () => {
  for (const id of [
    'viewToggle', 'tabAtk', 'tabDef', 'defBadge', 'defenseView',
    'defenseDemoNote', 'whaleChips', 'dphaselab', 'dleg', 'dsvg',
    'dpp', 'dscrub', 'dstrips', 'cdefense', 'enemyList', 'addEnemy',
    'pubWhales', 'pubMsg'
  ]) {
    assert.doesNotMatch(rallyHtml, new RegExp(`id=["']${id}["']`), id);
  }
});

test('Rally runtime has no static Defense state, rendering, event hooks, or config writes', () => {
  for (const token of [
    'enemyWhales', 'viewMode', 'adminEnemies', 'lastWhalesKey',
    'pendingPubWhales', 'pendingPubTok', 'dCalc', 'dBuildBase',
    'dRebuild', 'dFrame', 'dRefocus', 'renderDefense', 'renderDStrips',
    'renderWhaleChips', 'setView', 'setBadge', 'renderAdmin', 'sendWhales',
    'publishWhales', 'wireDefenseTruth', 'pauseDefenseRehearsal'
  ]) {
    assert.doesNotMatch(rallyRuntime, new RegExp(`\\b${token}\\b`), token);
  }
  assert.doesNotMatch(rallyRuntime, /\b(?:tab_def|dpanel|dpanelhint|defsethint|addenemy|pubwhales|defense_demo)\s*:/);
  assert.doesNotMatch(rallyRuntime, /\b(?:d_empty|d_you_send|d_enemy_land|d_refilled|d_gather_band|d_send_now|d_your_march|d_depart|d_side_enemy|d_side_our|d_indep_note|d_short_|d_cue_|d_note|d_erow|d_lane_title|d_ph_|d_fx_|d_gather_cd|d_land_cd|d_whale|d_enemy)\w*\s*:/);
});

test('canonical Rally uses Rally product hooks and active globals', () => {
  assert.match(rallyHtml, /<body[^>]*class=["'][^"']*\brally-page\b/);
  assert.match(rallyHtml, /class=["'][^"']*\brally-wrap\b/);
  assert.match(rallyHtml, /<title>kingshoter · Rally<\/title>/);
  assert.match(rallyHtml, /id=["']rallyView["']/);
  assert.match(rallyDomain, /root\.RallyDomain\s*=\s*api/);
  assert.match(rallyRuntime, /window\.RallyDomain/);
  assert.match(rallyRuntime, /window\.RallyUpdate/);
  assert.match(rallyCss, /\.rally-page/);
  assert.ok(rallyCss.indexOf('body.rally-page') < rallyCss.indexOf('body.kvk-page'),
    'Rally is the primary body hook; the one-release KvK class is compatibility only');
});

test('Rally-only CSS no longer carries the deleted static Defense controls', () => {
  assert.doesNotMatch(appCss, /\.(?:viewseg|dbadge|cdefense|demotruth|whalechips|dblk|dlane)(?:\b|[\s.:#])/);
});

test('the independent Defense page retains the personal voice workflow', () => {
  assert.match(defenseHtml, /id="defenseCountdown"/);
  assert.match(defenseHtml, /id="defenseAudioRow"/);
  assert.match(defenseHtml, /id="defenseConsoleEntry"/);
  assert.match(defenseHtml, /\/defense-controller\.js/);
});
