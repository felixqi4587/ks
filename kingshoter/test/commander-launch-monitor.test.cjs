const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/rally-controller.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/rally.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/app.css'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) { if (character === '\n') lineComment = false; continue; }
    if (blockComment) { if (character === '*' && next === '/') { blockComment = false; index += 1; } continue; }
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
    else if (character === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated ${name}`);
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }

function loadProjection(commands, nowSec) {
  const sandbox = {
    liveCommands: () => commands,
    isRallyCommand: command => !!command && ['double_rally', 'triple_rally'].includes(command.type),
    commandUsesTripleRoles: command => command.type === 'triple_rally' || command.payload.rallySize === 3
  };
  vm.runInNewContext(`${extractFunction('commanderLaunchRows')}\nthis.commanderLaunchRows = commanderLaunchRows;`, sandbox);
  return sandbox.commanderLaunchRows({}, nowSec);
}

test('commander launch projection combines both kingdoms in frozen launch order', () => {
  const rows = loadProjection([
    {
      id: 'k2-triple', type: 'triple_rally', kingdom: 2,
      payload: { rallySize: 3, pairs: [
        { pid: 'k2-main', name: 'K2 Main', role: 'main', pressUTC: 1_012 },
        { pid: 'k2-weak2', name: 'K2 Sac 2', role: 'weak2', pressUTC: 1_010 },
        { pid: 'k2-weak', name: 'K2 Sac 1', role: 'weak', pressUTC: 1_010 }
      ] }
    },
    {
      id: 'k1-double', type: 'double_rally', kingdom: 1,
      payload: { pairs: [
        { pid: 'k1-main', name: 'K1 Main', role: 'main', pressUTC: 1_011 },
        { pid: 'k1-weak', name: 'K1 Sac', role: 'weak', pressUTC: 1_009 }
      ] }
    },
    { id: 'refill', type: 'refill', kingdom: 1, payload: { pairs: [{ pid: 'ignore', role: 'main', pressUTC: 900 }] } }
  ]);

  assert.deepEqual(plain(rows.map(row => [row.commandId, row.kingdom, row.pid, row.name, row.role, row.pressUTC, row.triple])), [
    ['k1-double', 1, 'k1-weak', 'K1 Sac', 'weak', 1_009, false],
    ['k2-triple', 2, 'k2-weak', 'K2 Sac 1', 'weak', 1_010, true],
    ['k2-triple', 2, 'k2-weak2', 'K2 Sac 2', 'weak2', 1_010, true],
    ['k1-double', 1, 'k1-main', 'K1 Main', 'main', 1_011, false],
    ['k2-triple', 2, 'k2-main', 'K2 Main', 'main', 1_012, true]
  ]);
});

test('commander launch projection rejects malformed pairs and caps the monitor at six rows', () => {
  const pairs = Array.from({ length: 8 }, (_, index) => ({
    pid: `captain-${index}`, name: `Captain ${index}`, role: index % 3 === 0 ? 'weak' : index % 3 === 1 ? 'weak2' : 'main', pressUTC: 2_000 + index
  }));
  pairs.splice(2, 0,
    { pid: '', name: 'No pid', role: 'main', pressUTC: 1_900 },
    { pid: 'bad-role', name: 'Bad role', role: 'joiner', pressUTC: 1_901 },
    { pid: 'bad-time', name: 'Bad time', role: 'weak', pressUTC: 'soon' }
  );
  const rows = loadProjection([{ id: 'oversized', type: 'triple_rally', payload: { kingdom: 2, rallySize: 3, pairs } }]);

  assert.equal(rows.length, 6);
  assert.equal(rows.every(row => row.pid && Number.isFinite(row.pressUTC)), true);
  assert.equal(rows.some(row => row.pid.startsWith('bad-')), false);
});

test('commander launch projection keeps opened rows until the final captain has passed', () => {
  const command = { id: 'live', type: 'double_rally', kingdom: 1, payload: { pairs: [
    { pid: 'first', name: 'First', role: 'weak', pressUTC: 1_000 },
    { pid: 'last', name: 'Last', role: 'main', pressUTC: 1_010 }
  ] } };

  assert.deepEqual(plain(loadProjection([command], 1_005).map(row => row.pid)), ['first', 'last']);
  assert.deepEqual(plain(loadProjection([command], 1_013).map(row => row.pid)), ['first', 'last']);
  assert.deepEqual(plain(loadProjection([command], 1_014)), []);
});

test('an earlier kingdom stays visible while another kingdom still has a pending captain', () => {
  const rows = loadProjection([
    { id: 'early', type: 'double_rally', kingdom: 1, payload: { pairs: [
      { pid: 'early-sac', role: 'weak', pressUTC: 1_000 },
      { pid: 'early-main', role: 'main', pressUTC: 1_001 }
    ] } },
    { id: 'later', type: 'double_rally', kingdom: 2, payload: { pairs: [
      { pid: 'later-sac', role: 'weak', pressUTC: 1_010 },
      { pid: 'later-main', role: 'main', pressUTC: 1_011 }
    ] } }
  ], 1_006);

  assert.deepEqual(plain(rows.map(row => row.pid)), ['early-sac', 'early-main', 'later-sac', 'later-main']);
});

test('commander monitor HTML shows every captain, one next launch, urgency, launched state, and escaped names', () => {
  const sandbox = {
    tk: key => ({
      cmd_watch_title: 'Launch monitor', cmd_watch_sub: 'Commander view · silent', cmd_watch_next: 'Next', cmd_watch_opened: 'Opened',
      kw1: 'Kingdom ①', kw2: 'Kingdom ②'
    })[key] || key,
    rallyRoleLabel: role => ({ weak: 'Sacrifice 1', weak2: 'Sacrifice 2', main: 'Main' })[role] || role,
    kingdomLabel: kingdom => kingdom === 2 ? 'Kingdom ②' : 'Kingdom ①',
    window: {
      esc: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
      mmss: seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
    }
  };
  vm.runInNewContext(`${extractFunction('commanderLaunchMonitorHTML')}\nthis.render = commanderLaunchMonitorHTML;`, sandbox);
  const markup = sandbox.render([
    { kingdom: 1, pid: 'done', name: 'Already Open', role: 'weak', pressUTC: 999, triple: false },
    { kingdom: 2, pid: 'next', name: '<Whale & One>', role: 'weak2', pressUTC: 1_006, triple: true },
    { kingdom: 2, pid: 'later', name: 'Main Two', role: 'main', pressUTC: 1_025, triple: true }
  ], 1_000);

  assert.match(markup, /Launch monitor/);
  assert.match(markup, /Commander view · silent/);
  assert.match(markup, /Already Open/);
  assert.match(markup, /Opened/);
  assert.match(markup, /&lt;Whale &amp; One&gt;/);
  assert.match(markup, /Main Two/);
  assert.equal((markup.match(/clm-row next urgent/g) || []).length, 1);
  assert.equal((markup.match(/clm-row launched/g) || []).length, 1);
  assert.match(markup, /<time>0:06<\/time>/);
  assert.match(markup, /<time>0:25<\/time>/);
});

test('only an unselected commander following a rally is routed to the launch monitor', () => {
  const command = { id: 'rally', type: 'double_rally', payload: { pairs: [
    { pid: 'captain-a', role: 'weak', pressUTC: 1_000 },
    { pid: 'captain-b', role: 'main', pressUTC: 1_001 }
  ] } };
  function route({ commander, pid, active = command }) {
    const sandbox = {
      isCommanderDevice: () => commander,
      liveCommands: () => [command],
      isRallyCommand: value => value.type === 'double_rally',
      myTarget: value => ({ mine: value.payload.pairs.some(pair => pair.pid === pid) })
    };
    vm.runInNewContext(`${extractFunction('shouldShowCommanderLaunchMonitor')}\nthis.route = shouldShowCommanderLaunchMonitor;`, sandbox);
    return sandbox.route({}, active);
  }

  assert.equal(route({ commander: true, pid: 'not-selected' }), true);
  assert.equal(route({ commander: true, pid: 'captain-a' }), false);
  assert.equal(route({ commander: false, pid: 'not-selected' }), false);
  assert.equal(route({ commander: true, pid: 'not-selected', active: { id: 'refill', type: 'refill' } }), false);
  assert.equal(route({ commander: true, pid: 'not-selected', active: { id: 'ping', type: 'ping' } }), false);
});

test('the monitor has a dedicated hidden section and compact responsive styles', () => {
  assert.match(html, /id="commanderLaunchMonitor"[^>]*class="commander-launch-monitor hide"[^>]*aria-labelledby="commanderLaunchMonitorTitle"/);
  assert.match(source, /id="commanderLaunchMonitorTitle"/);
  assert.match(css, /\.commander-launch-monitor\{/);
  assert.match(css, /\.clm-row\{/);
  assert.match(css, /\.clm-name\{[^}]*text-overflow:ellipsis/);
});
