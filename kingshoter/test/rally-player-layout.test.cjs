const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '../public/rally.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../public/rally-controller.js'), 'utf8');
const appCss = fs.readFileSync(path.join(__dirname, '../public/app.css'), 'utf8');
const rallyCssPath = path.join(__dirname, '../public/rally.css');
const rallyCss = fs.existsSync(rallyCssPath) ? fs.readFileSync(rallyCssPath, 'utf8') : '';

function functionSource(name) {
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
    if (character === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated ${name}`);
}

test('Rally tactical projector and surface CSS load before the page controller', () => {
  const tactical = html.indexOf('/rally-tactical.js');
  const controller = html.indexOf('/rally-controller.js');
  assert.ok(tactical > 0, 'pure Rally tactical projector is loaded');
  assert.ok(tactical < controller, 'projector loads before the controller');
  assert.match(html, /<link[^>]+href="\/rally\.css\?v=2026071701"/);
});

test('ordinary connection chrome does not expose room-wide online counts', () => {
  const paintChrome = functionSource('paintChrome');
  assert.doesNotMatch(paintChrome, /online_n|presenceN/);
  assert.match(paintChrome, /net_ready/);
  assert.match(html, /id="netlab"/);
  assert.match(html, /id="loc"/);
});

test('ordinary page keeps the full roster exclusively inside the full manage pane', () => {
  const manageStart = html.indexOf('id="commanderManagePane"');
  const roster = html.indexOf('id="roster"');
  const commandEnd = html.indexOf('</section>', html.indexOf('id="commanderCommandPane"'));
  assert.ok(manageStart > 0 && roster > manageStart);
  assert.ok(roster > commandEnd);
  assert.equal((html.match(/id="roster"/g) || []).length, 1);
});

test('both kingdom groups remain visible and each selected captain keeps a precise fixed-scale bar', () => {
  const render = functionSource('renderLanes');
  const row = functionSource('laneRow');
  assert.match(render, /\[1, 2\]|groups/);
  assert.doesNotMatch(render, /if \(!group\.actors\.length\) return/);
  assert.match(render, /group\.actors\.slice\(0, 3\)/);
  assert.match(row, /MARCH_MAX_SECONDS/);
  assert.match(row, /ltrack idle/);
  assert.match(row, /ltimev/);
  assert.match(appCss + rallyCss, /\.lane \.lname\{[^}]*font:[^;}]*1[3-5]px/);
  assert.match(appCss + rallyCss, /\.lane \.ltimev\{[^}]*font:[^;}]*1[4-6]px/);
});

test('castle field uses the dynamic tactical scale, full centered frame, and truthful phases', () => {
  const syncMap = functionSource('syncMap');
  const frame = functionSource('mapFrame');
  assert.match(source, /var CX = 180, CY = 135/);
  assert.match(source, /FIELD_RADIUS = 120/);
  assert.match(syncMap, /rallyTactical\.scaleMax/);
  assert.match(frame, /rallyTactical\.actorProjection/);
  assert.match(html, /id="mapScaleLabel"/);
  assert.match(appCss + rallyCss, /\.rally-map-scale/);
  assert.match(html, /viewBox="0 0 360 270"[^>]*id="radar"[^>]*preserveAspectRatio="xMidYMid slice"/);
});

test('idle castle legend describes the dynamic field scale instead of a fixed ring duration', () => {
  const radar = functionSource('renderRadar');
  assert.match(radar, /d\.live \? "legend_live" : "legend"/);
  assert.doesNotMatch(source, /每环\s*30\s*秒|30s per ring/i);
  assert.match(source, /legend:\s*"[^"]*(?:自动缩放|longest selected march)/);
});

test('idle and live castle legends use the same truthful identity and role glyphs', () => {
  assert.match(source, /legend:\s*"黄色外圈=你 · ● 主力 ○ 消耗 · 距离按本轮最远行军时间自动缩放"/);
  assert.match(source, /legend_live:\s*"黄色外圈=你 · ● 主力 ○ 消耗 · 距离按本轮最远行军时间自动缩放"/);
  assert.match(source, /legend:\s*"yellow ring = you · ● main ○ sacrifice · field fits the longest selected march"/);
  assert.match(source, /legend_live:\s*"yellow ring = you · ● main ○ sacrifice · field fits the longest selected march"/);
});

test('tactical copy and monitor states stay explicit about website scheduling rather than game telemetry', () => {
  assert.match(source, /atk_note:\s*"[^"]*(?:网站排程|Website schedule)[^"]*(?:非游戏实时|not live game data)"/);
  assert.match(source, /join_note:\s*"[^"]*(?:无法确认游戏动作|game action is not confirmed)"/);
  assert.match(source, /cmd_watch_opened:\s*"(?:发令时间已过|GO passed)"/);
  assert.doesNotMatch(source, /cmd_watch_opened:\s*"(?:已开车|Opened)"/);
});

test('the tactical SVG has no undersized pointer-only room-link control', () => {
  assert.doesNotMatch(html, /id="copyLinkT"/);
  assert.doesNotMatch(functionSource('renderRadar'), /copyLinkT|tk\("copylink"\)/);
  assert.doesNotMatch(functionSource('wireRoom'), /copyLinkT/);
});

test('meaningful map copy stays in unscaled HTML instead of shrinking with the SVG viewBox', () => {
  assert.match(html, /id="mapMessage"/);
  assert.match(html, /id="mapLegend"/);
  const radar = functionSource('renderRadar');
  assert.match(radar, /\$\("mapMessage"\)/);
  assert.match(radar, /\$\("mapLegend"\)/);
  assert.doesNotMatch(radar, /E2\("text"[^\n]*(?:mapempty|legend)/);
  assert.match(rallyCss, /\.rally-map-(?:message|legend)[^}]*font:[^;}]*11px/s);
});

test('new tactical labels use readable battle text tokens instead of decorative mint and brown', () => {
  assert.match(rallyCss, /\.kvk-page \.lane-empty\s*\{[^}]*color:\s*var\(--battle-label-secondary\)/s);
  assert.match(rallyCss, /\.rally-map-scale\s*\{[^}]*color:\s*var\(--battle-label-primary\)/s);
  assert.match(rallyCss, /\.kvk-page \.lanenote[^}]*color:\s*var\(--battle-label-secondary\)/s);
  assert.match(rallyCss, /\.lane-group\.kingdom-1 \.lane-group-head[^}]*color:\s*var\(--battle-label-primary\)/s);
  assert.match(rallyCss, /\.lane\.me \.lname[^}]*color:\s*var\(--battle-label-primary\)/s);
  assert.doesNotMatch(functionSource('renderRadar'), /#729e96/);
});

test('reduced motion keeps clock-derived positions but limits tactical DOM movement to one step per second', () => {
  const frame = functionSource('mapFrame');
  assert.match(frame, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
  assert.match(frame, /Math\.floor\(nowMs\s*\/\s*1000\)/);
  assert.match(frame, /mapS\.motionBucket/);
  assert.match(frame, /requestAnimationFrame\(mapFrame\)/);
});

test('mobile tactical density supports six rows without horizontal scrolling or tiny decision text', () => {
  assert.match(rallyCss, /@media \(max-width: ?430px\)/);
  assert.match(rallyCss, /@media \(max-width: ?375px\)/);
  assert.match(rallyCss, /overflow-x:\s*hidden/);
  assert.doesNotMatch(rallyCss, /\.lane[^}]*font-size:\s*(?:8|9|10)px/);
  assert.match(rallyCss, /min-height:\s*44px/);
});
