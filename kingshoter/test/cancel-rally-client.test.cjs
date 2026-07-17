const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/rally-controller.js'), 'utf8');

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

test('a fired assignment preserves identity without replaying the standby alert', () => {
  const transition = vm.runInThisContext(`(${extractFunction('stageAlertTransition')})`);
  const staged = { live: { staged: { 1: { kingdom: 1, pairs: [
    { pid: '930000001', role: 'weak' }
  ] }, 2: null }, commands: { 1: null, 2: null } } };
  const fired = { live: { staged: { 1: null, 2: null }, commands: { 1: {
    type: 'double_rally', kingdom: 1,
    payload: { pairs: [{ pid: '930000001', role: 'weak', pressUTC: 1010 }] }
  }, 2: null } } };
  const empty = { live: { staged: { 1: null, 2: null }, commands: { 1: null, 2: null } } };

  const first = transition(staged, '930000001', '');
  assert.deepEqual(first, { key: '1:weak', alert: true });
  assert.deepEqual(transition(fired, '930000001', first.key), {
    key: '1:weak', alert: false
  });
  assert.deepEqual(transition(staged, '930000001', first.key), {
    key: '1:weak', alert: false
  });
  assert.deepEqual(transition(empty, '930000001', first.key), {
    key: '', alert: false
  });
  assert.deepEqual(transition(staged, '930000001', ''), {
    key: '1:weak', alert: true
  });
});
