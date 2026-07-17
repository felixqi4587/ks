const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function tagById(html, id) {
  const match = html.match(new RegExp(`<([a-z0-9-]+)\\b[^>]*\\bid="${id}"[^>]*>`, 'i'));
  assert.ok(match, `missing #${id}`);
  return match[0];
}

test('Rally Manage has exactly Players and Room semantic tabs', () => {
  const html = read('public/rally.html');
  assert.match(tagById(html, 'rallyManageTabs'), /role="tablist"/i);
  for (const [tab, panel] of [
    ['rallyPlayersTab', 'rallyPlayersPanel'],
    ['rallyRoomTab', 'rallyRoomPanel']
  ]) {
    const tag = tagById(html, tab);
    assert.match(tag, /<button\b/i);
    assert.match(tag, /role="tab"/i);
    assert.match(tag, new RegExp(`aria-controls="${panel}"`, 'i'));
    assert.match(tag, /aria-selected="(?:true|false)"/i);
    assert.match(tagById(html, panel), /role="tabpanel"/i);
  }
  const tablist = html.slice(html.indexOf('id="rallyManageTabs"'), html.indexOf('id="rallyPlayersPanel"'));
  assert.equal((tablist.match(/role="tab"/g) || []).length, 2);
  assert.doesNotMatch(tablist, /Timing|Status/i);
});

test('full roster and existing editor live only inside the Players tab', () => {
  const html = read('public/rally.html');
  const playersStart = html.indexOf('id="rallyPlayersPanel"');
  const roomStart = html.indexOf('id="rallyRoomPanel"');
  assert.ok(playersStart >= 0 && roomStart > playersStart);
  const players = html.slice(playersStart, roomStart);
  for (const id of ['rosterSearchWrap', 'roster', 'commanderMarchEditor']) {
    assert.match(players, new RegExp(`id="${id}"`));
    assert.equal(html.indexOf(`id="${id}"`), playersStart + players.indexOf(`id="${id}"`));
  }
});

test('Room tab has both kingdom names, independent modes, truthful website count, and a real copy button', () => {
  const html = read('public/rally.html');
  const roomPanel = html.slice(html.indexOf('id="rallyRoomPanel"'), html.indexOf('</section>', html.indexOf('id="rallyRoomPanel"')) + 10);
  assert.match(roomPanel, /id="connectedWebsiteDevices"/);
  assert.doesNotMatch(roomPanel, /game online|participants|joined in-game/i);
  for (const kingdom of [1, 2]) {
    const input = tagById(roomPanel, `kingdomName${kingdom}`);
    assert.match(input, /<input\b/i);
    assert.doesNotMatch(input, /maxlength=/i,
      'native UTF-16 maxlength must not reject a valid 24-grapheme emoji name');
    assert.match(tagById(roomPanel, `kingdomNameSave${kingdom}`), /<button\b/i);
    assert.match(tagById(roomPanel, `roomTripleMode${kingdom}`), /type="checkbox"/i);
    assert.match(tagById(roomPanel, `roomTripleMode${kingdom}`), /role="switch"/i);
  }
  const copy = tagById(roomPanel, 'copyRallyRoomLink');
  assert.match(copy, /<button\b/i);
  assert.doesNotMatch(roomPanel, /change password|password change/i);
});

test('Rally Room controller is loaded before the main Rally client', () => {
  const html = read('public/rally.html');
  const domain = html.indexOf('/rally-room.js');
  const client = html.indexOf('/rally-controller.js');
  assert.ok(domain >= 0 && client > domain);
});

test('Room controls retain 44px hit regions and 16px mobile inputs', () => {
  const css = read('public/rally.css') + '\n' + read('public/battle-ui.css') + '\n' + read('public/app.css');
  assert.match(css, /\.rally-manage-tabs[^}]*min-height:\s*44px/s);
  assert.match(css, /\.rally-room-panel[^}]*button[^}]*min-height:\s*44px/s);
  assert.match(css, /\.rally-room-panel[^}]*input[^}]*font-size:\s*16px/s);
});

test('client renders canonical kingdom names everywhere and has clipboard fallback', () => {
  const source = read('public/rally-controller.js');
  assert.match(source, /window\.RallyRoom/);
  assert.match(source, /kingdomLabel\(/);
  assert.match(source, /connectedWebsiteDevices\(/);
  assert.match(source, /navigator\.clipboard/);
  assert.match(source, /execCommand\(["']copy["']\)/);
  assert.match(source, /createNameMutation\(/);
  assert.match(source, /draftDirty[^\n]*outcome\.name !== draftValue[^\n]*return ""/,
    'editing a new draft clears the previous saved/conflict status');
});
