const { chromium } = require(process.env.FINDAR_PLAYWRIGHT || 'playwright');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
(async () => {
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/api/applications/fixture/fill/web')) {
      assert.equal(req.headers.authorization, 'Bearer ' + 'a'.repeat(64));
      let raw = ''; for await (const chunk of req) raw += chunk;
      const { targets, taskId } = JSON.parse(raw);
      if (taskId) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ task: { status: 'completed', result: { plan: { assignments: [{ targetId: 'field-0', value: '연결 테스트', label: '성명' }], skipped: [] } } } })); return; }
      const name = targets.find((t) => t.label.includes('성명'));
      res.setHeader('Content-Type', 'application/json');
      assert.equal(name.id, 'field-0'); res.end(JSON.stringify({ task: { id: 'web-fixture', status: 'running' } }));
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
    const handshake = ts.transpileModule(fs.readFileSync('lib/browser-extension-client.ts', 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    await page.addScriptTag({ content: `(function () { const exports = {}; ${handshake}; window.detectFindar = exports.detectBrowserExtension; })();` });
    assert.equal(await page.evaluate(() => window.detectFindar()), true, 'installed extension handshake');
    const opened = context.waitForEvent('page');
    await page.evaluate((port) => window.postMessage({ type: 'FINDAR_CONNECT', seq: 'fixture', token: 'a'.repeat(64), url: `http://127.0.0.1:${port}/apply` }, location.origin), port);
    const application = await opened;
    await application.waitForLoadState();
    const stored = await worker.evaluate(() => chrome.storage.session.get(null));
    assert.equal(Object.entries(stored).find(([key]) => key.startsWith('findar-connection-'))[1].seq, 'fixture');
    // A second company's connection must not replace the first tab's capability.
    const secondOpened = context.waitForEvent('page');
    await page.evaluate(port => window.postMessage({ type: 'FINDAR_CONNECT', seq: 'other-company', token: 'b'.repeat(64), url: `http://127.0.0.1:${port}/other-apply` }, location.origin), port);
    const secondApplication = await secondOpened; await secondApplication.waitForLoadState();
    // Opening action popup is a user gesture in normal use. Grant the activeTab-equivalent permission
    // in this isolated test by using the worker to execute on the already authorized loopback host.
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    const appTab = await worker.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url?.endsWith('/apply')));
    await worker.evaluate((tabId) => chrome.tabs.update(tabId, { active: true }), appTab.id);
    await popup.reload();
    await popup.getByRole('button', { name: '현재 양식 채우기' }).click();
    await popup.getByText(/팝업을 닫거나 탭을 이동해도/).waitFor({ timeout: 10000 }).catch(async error => { console.log(await popup.locator('body').innerText()); throw error; });
    await popup.close();
    // With no popup left, the service-worker alarm must complete and report the fill.
    await worker.evaluate(() => chrome.alarms.create('findar-fill', { when: Date.now() + 100 }));
    await application.waitForFunction(() => document.querySelector('#name').value === '연결 테스트', { timeout: 10000 });
    await application.waitForTimeout(400);
    const result = await worker.evaluate(async tabId => (await chrome.storage.session.get('findar-job-' + tabId))['findar-job-' + tabId], appTab.id);
    assert.equal(result.status, 'completed');
    assert.equal(await application.locator('#name').inputValue(), '연결 테스트');
    assert.equal(await application.evaluate(() => !!window.submitted), false);
    console.log('PASS installed extension per-tab company isolation, popup closure, alarm background fill, report, no submission');
  } finally {
    if (context) await context.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
