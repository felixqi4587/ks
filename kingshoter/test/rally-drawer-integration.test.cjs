const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'public', 'kvk.html');
const SCRIPT_PATH = path.join(ROOT, 'public', 'kvk.js');
const CSS_PATH = path.join(ROOT, 'public', 'app.css');
const html = fs.readFileSync(HTML_PATH, 'utf8');
const source = fs.readFileSync(SCRIPT_PATH, 'utf8');
const css = fs.readFileSync(CSS_PATH, 'utf8');

function startTags(markup) {
  const records = [];
  const tagPattern = /<([a-z][\w:-]*)\b([^>]*)>/gi;
  let match;
  while ((match = tagPattern.exec(markup))) {
    if (match[0].startsWith('</') || match[0].startsWith('<!--')) continue;
    const attributes = Object.create(null);
    const attributePattern = /([:\w-]+)\s*=\s*(["'])(.*?)\2/g;
    let attribute;
    while ((attribute = attributePattern.exec(match[2]))) attributes[attribute[1].toLowerCase()] = attribute[3];
    records.push({ tag: match[1].toLowerCase(), attributes, start: match.index, end: tagPattern.lastIndex });
  }
  return records;
}

const tags = startTags(html);

function tagsWithId(id) {
  return tags.filter(record => record.attributes.id === id);
}

function oneTagWithId(id) {
  const matches = tagsWithId(id);
  assert.equal(matches.length, 1, `#${id} must exist exactly once`);
  return matches[0];
}

function elementRange(id) {
  const record = oneTagWithId(id);
  const tokenPattern = new RegExp(`<\\/?${record.tag}\\b[^>]*>`, 'gi');
  tokenPattern.lastIndex = record.start;
  let depth = 0;
  let token;
  while ((token = tokenPattern.exec(html))) {
    const isClose = /^<\//.test(token[0]);
    const isSelfClosing = /\/\s*>$/.test(token[0]);
    if (isClose) depth -= 1;
    else if (!isSelfClosing) depth += 1;
    if (depth === 0) return { start: record.start, end: tokenPattern.lastIndex };
  }
  assert.fail(`#${id} has no closing </${record.tag}>`);
}

function assertInside(containerId, childId) {
  const container = elementRange(containerId);
  const child = oneTagWithId(childId);
  assert.ok(child.start > container.start && child.end < container.end, `#${childId} must be inside #${containerId}`);
}

function resourcePath(value) {
  return new URL(value, 'https://kingshoter.test/').pathname;
}

function extractBalancedFunction(text, marker, label) {
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, `missing ${label}`);
  const functionStart = text.indexOf('function', start);
  assert.notEqual(functionStart, -1, `missing function expression for ${label}`);
  const open = text.indexOf('{', functionStart);
  assert.notEqual(open, -1, `missing function body for ${label}`);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (character === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return text.slice(functionStart, index + 1);
  }
  assert.fail(`unterminated ${label}`);
}

function extractFunction(name) {
  return extractBalancedFunction(source, `function ${name}(`, name);
}

class FakeClassList {
  constructor(initial = []) { this.values = new Set(initial); }
  add(...names) { names.forEach(name => this.values.add(name)); }
  remove(...names) { names.forEach(name => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    if (force === undefined) force = !this.values.has(name);
    if (force) this.values.add(name); else this.values.delete(name);
    return force;
  }
}

function fakeElement(initial = []) {
  return {
    classList: new FakeClassList(initial),
    attributes: new Map(),
    value: '', textContent: '', focusCount: 0,
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    removeAttribute(name) { this.attributes.delete(name); },
    focus() { this.focusCount += 1; }
  };
}

test('Rally loads the shared battle shell and drawer before its controller', () => {
  const styles = tags.filter(record => record.tag === 'link' && record.attributes.rel === 'stylesheet');
  const scripts = tags.filter(record => record.tag === 'script' && record.attributes.src);
  const battleStyle = styles.filter(record => resourcePath(record.attributes.href) === '/battle-ui.css');
  const battleDrawer = scripts.filter(record => resourcePath(record.attributes.src) === '/battle-drawer.js');
  const rallyController = scripts.filter(record => resourcePath(record.attributes.src) === '/kvk.js');

  assert.equal(battleStyle.length, 1, 'battle-ui.css must be loaded exactly once');
  assert.equal(battleDrawer.length, 1, 'battle-drawer.js must be loaded exactly once');
  assert.equal(rallyController.length, 1, 'kvk.js must be loaded exactly once');
  assert.ok(battleDrawer[0].start < rallyController[0].start, 'BattleDrawer must exist before the Rally controller starts');
});

test('the existing Rally console is partitioned into accessible Command and Manage panes without changing control identities', () => {
  const consoleTag = oneTagWithId('console');
  assert.ok((consoleTag.attributes.class || '').split(/\s+/).includes('battle-drawer'), '#console remains the controller root and gains the shared drawer class');

  ['commanderDrawerHandle', 'commanderDrawerClose', 'commanderCommandPane', 'commanderManageOpen',
    'commanderManagePane', 'commanderManageBack', 'commanderToast'].forEach(oneTagWithId);
  assert.equal(oneTagWithId('commanderDrawerClose').tag, 'button', 'Close console has a button alternative to the gesture');
  assert.equal(oneTagWithId('commanderManageOpen').tag, 'button', 'Manage has a button alternative to swipe up');
  assert.equal(oneTagWithId('commanderManageBack').tag, 'button', 'Back to command has a button alternative to swipe down');

  const preservedIds = [
    'kingdomPick', 'rallyModeControl', 'tripleMode', 'pickSlots', 'lead',
    'fireDock', 'fireDouble', 'cancelBtn', 'rosterSearchWrap', 'rosterSearch',
    'roster', 'commanderMarchEditor', 'commanderMarchInput'
  ];
  preservedIds.forEach(id => {
    assert.equal(tagsWithId(id).length, 1, `existing #${id} identity must remain unique`);
    assertInside('console', id);
  });

  ['lead', 'fireDock', 'fireDouble', 'cancelBtn', 'commanderManageOpen'].forEach(id => assertInside('commanderCommandPane', id));
  ['rosterSearchWrap', 'roster', 'commanderMarchEditor', 'commanderManageBack'].forEach(id => assertInside('commanderManagePane', id));
  assertInside('console', 'commanderToast');
});

test('the tactical background wrapper never blocks the required audio gesture', () => {
  assertInside('battleMain', 'soundGate');
  assertInside('battleMain', 'cmdGate');
  assert.doesNotMatch(css, /#roomView\.presound\s*>\s*\*:/,
    'the background wrapper itself must not receive the pre-audio pointer lock');
  assert.match(css, /#roomView\.presound\s*>\s*\.battle-main\s*>\s*\*:/,
    'only the wrapper children other than the audio controls are dimmed');
  assert.match(css, /#roomView\.presound\s*>\s*\.console\.battle-drawer/,
    'a remembered commander session remains unavailable until sound is explicitly enabled');
});

test('drawer state changes only presentation: Command is live, Manage is full-height, and Closed restores the entry', () => {
  const elements = {
    cmdGate: fakeElement(),
    console: fakeElement(['hide']),
    chrome: fakeElement(),
    commanderCommandPane: fakeElement(['hide']),
    commanderManagePane: fakeElement(['hide'])
  };
  const sandbox = {
    document: { body: fakeElement() },
    $(id) { return elements[id]; }
  };
  vm.runInNewContext(`${extractFunction('applyCommanderDrawerState')}\nthis.apply = applyCommanderDrawerState;`, sandbox);

  sandbox.apply('command');
  assert.equal(sandbox.document.body.classList.contains('cmdmode'), true);
  assert.equal(elements.cmdGate.classList.contains('hide'), true);
  assert.equal(elements.chrome.classList.contains('cmd'), true);
  assert.equal(elements.commanderCommandPane.classList.contains('hide'), false);
  assert.equal(elements.commanderManagePane.classList.contains('hide'), true);

  sandbox.apply('manage');
  assert.equal(sandbox.document.body.classList.contains('cmdmode'), true);
  assert.equal(elements.cmdGate.classList.contains('hide'), true);
  assert.equal(elements.commanderCommandPane.classList.contains('hide'), true);
  assert.equal(elements.commanderManagePane.classList.contains('hide'), false);

  sandbox.apply('closed');
  assert.equal(sandbox.document.body.classList.contains('cmdmode'), false);
  assert.equal(elements.cmdGate.classList.contains('hide'), false);
  assert.equal(elements.chrome.classList.contains('cmd'), false);
});

test('collapse preserves authenticated commander identity while explicit lock clears it', () => {
  const removed = [];
  const elements = { cmdGate: fakeElement(), console: fakeElement(), chrome: fakeElement() };
  const sandbox = {
    roomPw: 'accepted-secret',
    managerAuthenticated: true,
    commanderDrawer: { closes: 0, close() { this.closes += 1; } },
    document: { body: fakeElement(['cmdmode']) },
    localStorage: { removeItem(key) { removed.push(key); } },
    LS(key) { return `kvk:qa:${key}`; },
    $(id) { return elements[id]; },
    applyCommanderDrawerState() {}
  };
  vm.runInNewContext(
    `${extractFunction('closeCmdDrawer')}\n${extractFunction('lockCmd')}\n` +
    'this.closeCmdDrawer = closeCmdDrawer; this.lockCmd = lockCmd;',
    sandbox
  );

  sandbox.closeCmdDrawer();
  assert.equal(sandbox.commanderDrawer.closes, 1);
  assert.equal(sandbox.roomPw, 'accepted-secret', 'collapse is not logout');
  assert.equal(sandbox.managerAuthenticated, true, 'drawer visibility cannot revoke commander identity');
  assert.deepEqual(removed, [], 'collapse performs no credential storage write');

  sandbox.lockCmd();
  assert.equal(sandbox.roomPw, '');
  assert.equal(sandbox.managerAuthenticated, false);
  assert.deepEqual(removed, ['kvk:qa:pw'], 'only lock/invalidation clears the accepted credential');
});

test('successful authentication is remembered and an authenticated console entry reopens without the password modal', () => {
  const modal = fakeElement();
  const elements = {
    pwOvl: modal, t_pwtitle: fakeElement(), pwInput: fakeElement(), pwGo: fakeElement(), pwHint: fakeElement()
  };
  const writes = [];
  const unlockSandbox = {
    pendingUnlock: true,
    managerAuthenticated: false,
    roomPw: 'accepted-secret',
    $: id => elements[id],
    openCmdCalls: 0,
    openCmd() { unlockSandbox.openCmdCalls += 1; },
    wr(key, value) { writes.push([key, value]); },
    LS(key) { return `kvk:qa:${key}`; }
  };
  vm.runInNewContext(`${extractFunction('unlockedOK')}\nthis.unlockedOK = unlockedOK;`, unlockSandbox);
  unlockSandbox.unlockedOK();
  assert.equal(unlockSandbox.managerAuthenticated, true);
  assert.equal(unlockSandbox.openCmdCalls, 1);
  assert.deepEqual(writes, [['kvk:qa:pw', 'accepted-secret']]);

  const entryFunction = extractBalancedFunction(source, '$("cmdUnlock").onclick = function', 'cmdUnlock.onclick');
  const entryModal = fakeElement();
  const entryElements = {
    pwOvl: entryModal, t_pwtitle: fakeElement(), pwInput: fakeElement(), pwGo: fakeElement(), pwHint: fakeElement()
  };
  const entrySandbox = {
    managerAuthenticated: true,
    roomPw: 'accepted-secret',
    room: { hasPw: true },
    tk(key) { return key; },
    $(id) { return entryElements[id]; },
    openCmdCalls: 0,
    openCmd() { entrySandbox.openCmdCalls += 1; },
    setTimeout(callback) { callback(); }
  };
  vm.runInNewContext(`this.handler = ${entryFunction};`, entrySandbox);
  entrySandbox.handler();
  assert.equal(entrySandbox.openCmdCalls, 1, 'authenticated entry goes straight back to Command');
  assert.equal(entryModal.classList.contains('show'), false, 'reopen must not flash or focus the password modal');
});

function cueRoute({ commander, selected }) {
  const bookings = [];
  const command = {
    id: 'rally-one', type: 'double_rally',
    payload: { firstPress: 200, leadSeconds: 10, pairs: selected ? [{ pid: 'me', role: 'main', pressUTC: 200 }] : [] }
  };
  const sandbox = {
    managerAuthenticated: commander,
    myPid: 'me',
    room: { live: {} },
    scheduledBeeps: {},
    document: { body: { classList: { contains() { return false; } } } },
    window: { serverNow() { return 100_000; } },
    reconcileCues() {},
    pruneDeliveryAckState() {},
    liveCommands() { return [command]; },
    myTarget() { return { mine: selected, anchor: 200 }; },
    isRallyCommand(value) { return value === command; },
    scheduleBeeps(key) { bookings.push(key); },
    schedulePrepareCue(key) { bookings.push(`${key}:prepare`); },
    acknowledgeClassicCommand() {},
    activeCommand() { return command; },
    stopCue() {}
  };
  vm.runInNewContext(
    `${extractFunction('isCommanderDevice')}\n${extractFunction('shouldBookJoinAudio')}\n` +
    `${extractFunction('cancelJoinCues')}\n${extractFunction('scheduleAllCues')}\n` +
    'this.scheduleAllCues = scheduleAllCues; this.isCommanderDevice = isCommanderDevice;',
    sandbox
  );
  sandbox.scheduleAllCues();
  return { bookings, commanderSeen: sandbox.isCommanderDevice() };
}

test('a collapsed commander stays silent unless selected, while a selected commander keeps only the personal cue', () => {
  assert.deepEqual(cueRoute({ commander: false, selected: false }).bookings, ['rally-one-join'], 'ordinary members keep the existing JOIN cue');

  const unselectedCommander = cueRoute({ commander: true, selected: false });
  assert.equal(unselectedCommander.commanderSeen, true, 'commander identity survives with body.cmdmode absent');
  assert.deepEqual(unselectedCommander.bookings, [], 'an unselected collapsed commander never inherits ordinary JOIN audio');

  const selectedCommander = cueRoute({ commander: true, selected: true });
  assert.equal(selectedCommander.commanderSeen, true);
  assert.deepEqual(selectedCommander.bookings, ['rally-one-me'], 'a selected commander keeps that captain’s personal cue and no JOIN cue');
});
