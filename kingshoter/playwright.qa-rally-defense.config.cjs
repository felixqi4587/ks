const os = require('node:os');
const path = require('node:path');
const { defineConfig, devices } = require('playwright/test');

const LOCAL_BASE_URL = 'http://127.0.0.1:8799';
const KNOWN_REMOTE_QA_ORIGIN = 'https://kingshoter-qa.kingshot1406.workers.dev';
const requestedBaseURL = String(process.env.QA_BASE_URL || '').trim();
const configuredRemoteOrigin = String(process.env.QA_REMOTE_ORIGIN || '').trim();
let baseURL = LOCAL_BASE_URL;

function cleanOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch (error) { throw new Error('unapproved_qa_origin'); }
  const clean = !parsed.username && !parsed.password && parsed.pathname === '/' &&
    !parsed.search && !parsed.hash && ['http:', 'https:'].includes(parsed.protocol);
  if (!clean) throw new Error('unapproved_qa_origin');
  return parsed;
}

function isKnownRemoteQaOrigin(origin) {
  return origin === KNOWN_REMOTE_QA_ORIGIN;
}

if (requestedBaseURL) {
  const parsed = cleanOrigin(requestedBaseURL);
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
  if (!loopback) {
    if (parsed.protocol !== 'https:' || process.env.ALLOW_REMOTE_QA !== '1') {
      throw new Error('remote_qa_requires_ALLOW_REMOTE_QA_1');
    }
    if (!configuredRemoteOrigin || cleanOrigin(configuredRemoteOrigin).origin !== parsed.origin) {
      throw new Error('unapproved_qa_origin');
    }
    if (parsed.hostname === 'kingshoter.com' || parsed.hostname === 'www.kingshoter.com') {
      throw new Error('production_origin_is_not_qa');
    }
    if (!isKnownRemoteQaOrigin(parsed.origin)) {
      throw new Error('unapproved_qa_origin');
    }
  }
  baseURL = parsed.origin;
}

const runRoot = path.join(os.tmpdir(), `kingshoter-qa-rally-defense-${process.pid}`);
const statePath = path.join(runRoot, 'wrangler-state');

module.exports = defineConfig({
  testDir: './test',
  testMatch: /qa-rally-(?:defense|delivery|triple)\.spec\.cjs$/,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['line']],
  outputDir: path.join(runRoot, 'artifacts'),
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off'
  },
  webServer: requestedBaseURL ? undefined : {
    command: `npx wrangler dev --local --ip 127.0.0.1 --port 8799 --persist-to ${JSON.stringify(statePath)} --var TRIPLE_RALLY_ENABLED:0 --var TRIPLE_RALLY_QA_ENABLED:1 --log-level warn`,
    url: `${LOCAL_BASE_URL}/api/time`,
    reuseExistingServer: false,
    timeout: 120_000
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] }
      }
    },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } }
  ]
});
