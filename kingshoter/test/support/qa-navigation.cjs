const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function responseStatus(response) {
  return response && typeof response.status === 'function' ? response.status() : null;
}

function responseContentType(response) {
  if (!response || typeof response.headers !== 'function') return '';
  const headers = response.headers() || {};
  return String(headers['content-type'] || '');
}

function retryableDocumentFailure(status, error) {
  return !!error || status === null || status === 404 || status >= 500;
}

async function gotoQaDocument(page, url, options = {}) {
  const {
    attempts = 2,
    retryDelayMs = 250,
    navigationTimeoutMs = 15_000,
    sentinel = '#soundGate',
    sentinelTimeoutMs = 5_000,
    sleep = delay
  } = options;
  let lastFailure = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response = null;
    let navigationError = null;
    try {
      response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: navigationTimeoutMs
      });
    } catch (error) {
      navigationError = error;
    }

    const status = responseStatus(response);
    const contentType = responseContentType(response);
    const isHtml = /^text\/html(?:\s*;|$)/i.test(contentType);
    if (!navigationError && response && response.ok() && isHtml) {
      await page.locator(sentinel).waitFor({
        state: 'visible',
        timeout: sentinelTimeoutMs
      });
      return response;
    }

    const detail = navigationError
      ? navigationError.message
      : `HTTP ${status === null ? 'no response' : status}, content-type ${contentType || 'missing'}`;
    lastFailure = new Error(`QA document navigation failed: ${detail} (${url})`);
    if (attempt >= attempts || !retryableDocumentFailure(status, navigationError)) break;
    await sleep(retryDelayMs);
  }

  throw lastFailure || new Error(`QA document navigation failed (${url})`);
}

module.exports = { gotoQaDocument };
