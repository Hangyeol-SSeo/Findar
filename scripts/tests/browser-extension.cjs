const { chromium } = require(process.env.FINDAR_PLAYWRIGHT || 'playwright');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/api/applications/fixture/fill/web')) {
      assert.equal(req.headers.authorization, 'Bearer ' + 'a'.repeat(64));
      let raw = ''; for await (const chunk of req) raw += chunk;
      const { targets } = JSON.parse(raw);
      const name = targets.find((t) => t.label.includes('성명'));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ assignments: [{ targetId: name.id, value: '연결 테스트', label: '성명' }], skipped: [] }));
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(req.url === '/apply' ? '<html><body><label>성명<input id="name"></label><button onclick="window.submitted=true">제출</button></body></html>' : '<html><body>연결 테스트</body></html>');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'findar-extension-test-'));
  let context;
  try {
    const extension = path.resolve('browser-extension');
    context = await chromium.launchPersistentContext(temp, { headless: true, executablePath: process.env.FINDAR_BROWSER,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`http://localhost:${port}/`);
    await page.waitForTimeout(300);
    const opened = context.waitForEvent('page');
    await page.evaluate((port) => window.postMessage({ type: 'FINDAR_CONNECT', seq: 'fixture', token: 'a'.repeat(64), url: `http://127.0.0.1:${port}/apply` }, location.origin), port);
    const application = await opened;
    await application.waitForLoadState();
    const stored = await worker.evaluate(() => chrome.storage.session.get('findar'));
    assert.equal(stored.findar.seq, 'fixture');
    // Opening action popup is a user gesture in normal use. Grant the activeTab-equivalent permission
    // in this isolated test by using the worker to execute on the already authorized loopback host.
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    const appTab = await worker.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url?.endsWith('/apply')));
    await worker.evaluate((tabId) => chrome.tabs.update(tabId, { active: true }), appTab.id);
    await popup.getByRole('button', { name: '현재 양식 채우기' }).click();
    await popup.getByText('1개 입력 완료. 화면에서 내용을 확인해주세요.', { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await application.locator('#name').inputValue(), '연결 테스트');
    assert.equal(await application.evaluate(() => !!window.submitted), false);
    console.log('PASS installed Brave extension connection, token storage, page read, API mapping, actual fill, report, no submission');
  } finally {
    if (context) await context.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
