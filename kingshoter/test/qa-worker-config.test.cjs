const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const configPath = path.join(__dirname, '..', 'wrangler.qa.toml');

test('QA Worker config is isolated from production bindings', () => {
  assert.equal(fs.existsSync(configPath), true, 'wrangler.qa.toml must exist');

  const config = fs.readFileSync(configPath, 'utf8');
  const significantLines = config
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  assert.deepEqual(significantLines, [
    'name = "kingshoter-qa"',
    'main = "src/worker.js"',
    'compatibility_date = "2026-01-01"',
    'workers_dev = true',
    'preview_urls = false',
    '[vars]',
    'TRIPLE_RALLY_ENABLED = "1"',
    'TRIPLE_RALLY_QA_ENABLED = "1"',
    '[assets]',
    'directory = "public"',
    'binding = "ASSETS"',
    'run_worker_first = ["/rally", "/defense", "/kvk", "/kvk.html"]',
    '[[durable_objects.bindings]]',
    'name = "ROOM"',
    'class_name = "Room"',
    '[[migrations]]',
    'tag = "v1"',
    'new_sqlite_classes = ["Room"]'
  ]);

  for (const productionOnly of [
    'routes',
    'triggers',
    'crons',
    'kv_namespaces',
    'GIFT_KV',
    'MASTER',
    'script_name'
  ]) {
    assert.doesNotMatch(config, new RegExp(`\\b${productionOnly}\\b`));
  }
});
