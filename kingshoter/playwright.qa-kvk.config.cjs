const os = require('node:os');
const path = require('node:path');
const { defineConfig, devices } = require('playwright/test');

const LOCAL_BASE_URL = 'http://127.0.0.1:8799';
const requestedBaseURL = String(process.env.QA_BASE_URL || '').trim();
let baseURL = LOCAL_BASE_URL;

if (requestedBaseURL) {
  let parsed;
  try {
    parsed = new URL(requestedBaseURL);
  } catch (error) {
    throw new Error('unapproved_qa_origin');
  }
  const productionHost = parsed.hostname === 'kingshoter.com' ||
    parsed.hostname === 'www.kingshoter.com';
  const exactOrigin = parsed.protocol === 'https:' && productionHost &&
    (!parsed.port || parsed.port === '443') &&
    !parsed.username && !parsed.password && parsed.pathname === '/' &&
    !parsed.search && !parsed.hash;
  if (!exactOrigin) throw new Error('unapproved_qa_origin');
  if (process.env.ALLOW_PRODUCTION_QA !== '1') {
    throw new Error('production_qa_requires_ALLOW_PRODUCTION_QA_1');
  }
  baseURL = parsed.origin;
}

const runRoot = path.join(os.tmpdir(), `kingshoter-qa-delivery-${process.pid}`);
const statePath = path.join(runRoot, 'wrangler-state');

module.exports = defineConfig({
  testDir: './test',
  testMatch: /qa-kvk-delivery\.spec\.cjs/,
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
    command: `npx wrangler dev --local --ip 127.0.0.1 --port 8799 --persist-to ${JSON.stringify(statePath)} --log-level warn`,
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
