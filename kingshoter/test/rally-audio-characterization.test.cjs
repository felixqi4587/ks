const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../public/kvk.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/kvk.html'), 'utf8');

test('Rally keeps one shared 10-to-Now cue grammar and the shipped clips', () => {
  assert.match(source, /\[10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0\]\.forEach/);
  assert.match(source, /\["zh", "en"\]\.forEach/);
  assert.match(source, /\["5", "4", "3", "2", "1", "go"\]\.forEach/);
  assert.match(source, /fetch\("\/sfx\/" \+ lg \+ "_" \+ n \+ "\.mp3"\)/);
  assert.match(source, /off <= 5[\s\S]*playClip/);
  assert.match(source, /off === 0[\s\S]*sfxBuf\[lg\]\.go/);
});

test('the background carrier, MediaSession, and readiness truth remain coupled', () => {
  assert.match(source, /Math\.sin\(i \/ sr \* 2 \* Math\.PI \* 40\)/);
  assert.match(source, /keepAudio\.loop = true/);
  assert.match(source, /navigator\.mediaSession\.metadata = new window\.MediaMetadata/);
  assert.match(source, /soundReady && ac && ac\.state === "running" && keepAlive && keepAudio && !keepAudio\.paused && !keepAudio\.ended/);
  assert.match(html, /id="soundGate"/);
});

test('cancel and clock correction retain stoppable future Web Audio nodes', () => {
  assert.match(source, /nodes are RETAINED so a cue can be killed/);
  assert.match(source, /cancelScheduledValues\(0\)/);
  assert.match(source, /function reconcileCues\(\)/);
  assert.match(source, /function rebookCuesOnDrift\(\)/);
  assert.match(source, /stopCue\(e\); delete scheduledBeeps\[k\]/);
});

test('an unselected commander has a visual-only all-captain monitor', () => {
  assert.match(source, /function shouldShowCommanderLaunchMonitor/);
  assert.match(source, /return rows\.slice\(0, 6\)/);
  assert.match(source, /cmd_watch_sub: "Commander view · silent"/);
  assert.match(source, /function shouldBookJoinAudio\(\)[\s\S]*!isCommanderDevice\(\)/);
});

