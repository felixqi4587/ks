const test = require('node:test');
const assert = require('node:assert/strict');

const { gotoQaDocument } = require('./support/qa-navigation.cjs');

function response(status, contentType = 'text/html; charset=UTF-8') {
  return {
    status: () => status,
    ok: () => status >= 200 && status < 300,
    headers: () => ({ 'content-type': contentType })
  };
}

function pageWithResponses(responses) {
  const calls = { goto: [], waitFor: [] };
  return {
    calls,
    async goto(url, options) {
      calls.goto.push({ url, options });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    locator(selector) {
      return {
        async waitFor(options) {
          calls.waitFor.push({ selector, options });
        }
      };
    }
  };
}

test('QA document navigation retries one transient empty 404 before accepting HTML', async () => {
  const page = pageWithResponses([
    response(404, 'x-unknown'),
    response(200)
  ]);
  const waits = [];

  const accepted = await gotoQaDocument(page, 'https://qa.example/rally?room=qa', {
    sleep: async milliseconds => waits.push(milliseconds)
  });

  assert.equal(accepted.status(), 200);
  assert.equal(page.calls.goto.length, 2);
  assert.deepEqual(waits, [250]);
  assert.deepEqual(page.calls.waitFor, [{
    selector: '#soundGate',
    options: { state: 'visible', timeout: 5_000 }
  }]);
  assert.deepEqual(page.calls.goto[0].options, {
    waitUntil: 'domcontentloaded',
    timeout: 15_000
  });
});

test('QA document navigation does not hide a non-retryable response', async () => {
  const page = pageWithResponses([response(403)]);

  await assert.rejects(
    gotoQaDocument(page, 'https://qa.example/rally?room=qa'),
    /HTTP 403/
  );
  assert.equal(page.calls.goto.length, 1);
  assert.equal(page.calls.waitFor.length, 0);
});

test('QA document navigation rejects a non-HTML success response', async () => {
  const page = pageWithResponses([response(200, 'application/json')]);

  await assert.rejects(
    gotoQaDocument(page, 'https://qa.example/rally?room=qa'),
    /content-type application\/json/
  );
  assert.equal(page.calls.goto.length, 1);
  assert.equal(page.calls.waitFor.length, 0);
});
