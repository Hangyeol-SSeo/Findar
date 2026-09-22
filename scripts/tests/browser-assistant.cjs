// Run with FINDAR_PLAYWRIGHT pointing to the bundled Playwright package and a running dev server.
const { chromium } = require(process.env.FINDAR_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const ts = require('typescript');
const Module = require('node:module');
const downloadModule = new Module(path.resolve('lib/document-download.ts'), module);
downloadModule._compile(ts.transpileModule(fs.readFileSync('lib/document-download.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, path.resolve('lib/document-download.ts'));
const { storeDocumentDownload, documentDownloadResponse } = downloadModule.exports;
(async () => {
  const downloadServer = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const download = documentDownloadResponse('qa-fixture', url.searchParams.get('token'));
    response.writeHead(download.status, Object.fromEntries(download.headers));
    response.end(Buffer.from(await download.arrayBuffer()));
  });
  await new Promise((resolve) => downloadServer.listen(0, '127.0.0.1', resolve));
  const downloadOrigin = `http://127.0.0.1:${downloadServer.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.FINDAR_BROWSER ? { executablePath: process.env.FINDAR_BROWSER } : {}) });
  try {
    const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1440, height: 1100 } });
    // Actual browser DOM execution; no connection to a real recruiting service.
    await page.setContent(`<form onsubmit="event.preventDefault();window.submitted=true"><label>성명<input id="name"></label><label>이메일<input id="email" type="email"></label><label>기존 정보<input id="existing" value="보존"></label><label>동의<input id="consent" type="checkbox"></label><label>주민등록번호<input id="sensitive"></label><input type="hidden" id="hidden"><label>국적<select id="nationality"><option value="">선택</option><option value="KR">대한민국</option></select></label><label>짧은 코드<input id="code" maxlength="2"></label><button type="submit">제출</button></form>`);
    await page.addScriptTag({ path: path.resolve('browser-extension/form-engine.js') });
    const targets = await page.evaluate(() => globalThis.__findarForm.targets);
    assert.equal(targets.length, 4);
    const find = (label) => targets.find((t) => t.label.includes(label));
    const result = await page.evaluate((assignments) => globalThis.__findarForm.apply(assignments), [
      { targetId: find('성명').id, value: '홍길동' }, { targetId: find('이메일').id, value: 'not-email' },
      { targetId: find('국적').id, value: '대한민국' }, { targetId: find('짧은 코드').id, value: '123' },
    ]);
    assert.equal(await page.locator('#name').inputValue(), '홍길동');
    assert.equal(await page.locator('#nationality').inputValue(), 'KR');
    assert.equal(await page.locator('#email').inputValue(), '');
    assert.equal(await page.locator('#existing').inputValue(), '보존');
    assert.equal(await page.locator('#code').inputValue(), '');
    assert.equal(await page.locator('#consent').isChecked(), false);
    assert.equal(await page.evaluate(() => !!window.submitted), false);
    assert.equal(result.filter((r) => r.filled).length, 2);
    console.log('PASS browser actual fill, select, format validation, preservation, no submission');
    await page.setContent('<label>이름<input id="name"></label>');
    await page.addScriptTag({ path: path.resolve('browser-extension/form-engine.js') });
    await page.locator('#name').fill('사용자 수정');
    const skipped = await page.evaluate(() => globalThis.__findarForm.apply([{ targetId: 'field-0', value: '덮어쓰기' }]));
    assert.equal(skipped[0].filled, undefined);
    assert.equal(await page.locator('#name').inputValue(), '사용자 수정');
    console.log('PASS concurrent user input not overwritten');

    const job = { seq: 'qa-fixture', company: '테스트 회사', title: '지원 도우미 검증 공고', date: '2026-09-20', applicationPeriod: '', siteUrl: 'https://example.com/apply', attachments: [], positionType: '신입', experienceYears: '신입', positions: ['운영'], categories: ['기타'], jdSummary: '운영 문제 해결', qualifications: [], deadline: '2099-12-31' };
    let saved = { seq: job.seq, personalFields: [], essayAnswers: [{ question: '예전 공통 문항', answer: '보존할 답변' }], notesForUser: [], model: 'test', generatedAt: Date.now(), revision: 'initial' };
    let failSave = false;
    let generationRequests = 0;
    let taskRequests = 0;
    let webRequests = 0;
    const tasks = [];
    let releaseWriting;
    let profilePayload = { name: '테스트 이름', address: '기존 기본주소', addressDetail: '101호', updatedAt: 1 };
    const downloadBytes = Buffer.from('test-document-bytes');
    await page.route('**/api/**', async (route) => {
      const req = route.request(); const url = new URL(req.url());
      let data = {}; let status = 200;
      if (url.origin === downloadOrigin) return route.continue();
      if (url.pathname === '/api/jobs') data = { jobs: [job], hasProfile: true };
      else if (url.pathname === '/api/jobs/hide') data = { jobs: [] };
      else if (url.pathname === '/api/profile/overrides') data = { careerGoals: '' };
      else if (url.pathname === '/api/profile/applicant') {
        if (req.method() === 'PUT') { profilePayload = req.postDataJSON(); data = { ok: true }; }
        else data = { profile: profilePayload };
      }
      else if (url.pathname.endsWith('/fill/document/download')) {
        const response = documentDownloadResponse(job.seq, url.searchParams.get('token'));
        return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
      }
      else if (url.pathname.endsWith('/tasks')) { taskRequests++; data = { tasks }; }
      else if (url.pathname.endsWith('/fill/web')) { webRequests++; data = { token: 'a'.repeat(64) }; }
      else if (url.pathname.endsWith('/fill/document')) { const document = { total: 3, downloadUrl: downloadOrigin + storeDocumentDownload(job.seq, '지원서-작성본.docx', downloadBytes.toString('base64')), filename: '지원서-작성본.docx', filled: 3, skipped: [], note: '작성본을 확인해주세요.' }; const task = { id: 'doc-' + tasks.length, kind: 'document', status: 'completed', done: 1, total: 1, result: { document } }; tasks.push(task); data = { task }; status = 202; }
      else if (url.pathname.endsWith('/draft/question')) {
        generationRequests++;
        const body = req.postDataJSON().questions[0]; assert.equal(body.question, '팀의 문제를 해결한 경험을 설명해주세요.');
        const answer = { ...body, source: 'user_question', intent: '문제 해결 과정의 판단과 행동', answer: '재현 절차를 기록하고 담당자와 확인 순서를 맞췄습니다.', evidence: [{ sourceId: 'memory.episode.test', quote: '재현 절차 기록', usedFor: '실제 행동' }], missingInfo: [], reviewNotes: [], status: 'draft', generatedAt: Date.now() };
        const task = { id: 'writing', kind: 'writing', status: 'running', done: 0, total: 1 }; tasks.push(task); data = { task }; status = 202;
        releaseWriting = () => { saved = { ...saved, revision: 'generated', essayAnswers: [...saved.essayAnswers, answer] }; task.status = 'completed'; task.done = 1; task.result = { draft: saved }; };
      } else if (url.pathname.endsWith('/draft')) {
        if (req.method() === 'PUT') {
          if (failSave) { data = { error: '테스트 저장 실패' }; status = 500; }
          else { saved = { ...req.postDataJSON(), revision: 'edited' }; data = { draft: saved }; }
        } else data = { draft: saved, siteUrl: job.siteUrl, submissionMethod: { method: 'web_form', templateAttachments: [], consentAttachments: [], submissionEmail: null } };
      } else { status = 400; data = { error: 'Unexpected API in fixture test' }; }
      await route.fulfill({ status, json: data });
    });
    await page.addInitScript(() => localStorage.setItem('findar:matchEnabled', 'false'));
    await page.goto(process.env.FINDAR_TEST_URL || 'http://localhost:3000');
    await page.getByText(job.title, { exact: true }).click();
    await page.getByRole('button', { name: '지원 도우미', exact: true }).click();
    await page.getByText('실제 문항에 맞춰 자기소개서 작성', { exact: true }).waitFor();
    assert.equal(generationRequests, 0);
    await page.waitForTimeout(300);
    const idleRequests = taskRequests;
    await page.waitForTimeout(4500);
    assert.equal(taskRequests, idleRequests, 'no idle task polling');
    await page.getByRole('button', { name: '지원서 자동 입력', exact: true }).click();
    const connect = page.getByRole('button', { name: '웹 지원서 연결', exact: true });
    assert.equal(await connect.isEnabled(), true, 'missing handshake must not permanently disable connect');
    await connect.click();
    await page.getByRole('alert').getByText(/현재 Findar 페이지에서 확장에 연결할 수 없습니다/).waitFor();
    assert.equal(webRequests, 0, 'no capability API call before extension detection');
    // Simulate a content script injected after the first ping has already been missed.
    await page.evaluate(() => {
      setTimeout(() => window.addEventListener('message', event => {
        if (event.data?.type === 'FINDAR_PING') window.postMessage({ type: 'FINDAR_READY' }, location.origin);
        if (event.data?.type === 'FINDAR_CONNECT') window.postMessage({ type: 'FINDAR_CONNECTED', seq: event.data.seq }, location.origin);
      }), 650);
    });
    await connect.click();
    await page.getByText(/지원 사이트를 열었습니다/).waitFor();
    assert.equal(webRequests, 1);
    await page.getByRole('button', { name: '문항별 자기소개서', exact: true }).click();
    console.log('PASS no idle polling, missing extension guidance, delayed extension handshake and connection');
    await page.getByPlaceholder(/문항 1 — 실제 지원서/).fill('팀의 문제를 해결한 경험을 설명해주세요.');
    await page.getByRole('button', { name: '이 문항 답변 작성', exact: true }).click();
    await page.getByText(/백그라운드에서 문항을 작성합니다/).waitFor();
    await page.getByRole('button', { name: '지원서 자동 입력', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Word 파일 선택', exact: true }).isEnabled(), true);
    await page.getByLabel('Word 지원서 양식').setInputFiles({ name: '동시작업.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('fixture') });
    await page.getByRole('button', { name: '개인정보·답변 채운 Word 만들기', exact: true }).click();
    await page.getByText(/Word 작성을 시작했습니다/).waitFor();
    assert.ok(tasks.some(t => t.kind === 'writing' && t.status === 'running'));
    assert.ok(tasks.some(t => t.kind === 'document'));
    await page.waitForTimeout(300);
    const runningRequests = taskRequests;
    await page.waitForTimeout(2300);
    assert.ok(taskRequests > runningRequests, 'new task resumes polling');
    await page.getByRole('button', { name: '공고 상세', exact: true }).click();
    releaseWriting();
    await page.getByRole('button', { name: '지원 도우미', exact: true }).click();
    await page.getByText(/문항 1개를 작성하고 저장했습니다/).waitFor();
    assert.equal(generationRequests, 1);
    const completedRequests = taskRequests;
    await page.waitForTimeout(4500);
    assert.equal(taskRequests, completedRequests, 'no polling after completion');
    console.log('PASS terminal tasks stop polling');
    await page.getByLabel('팀의 문제를 해결한 경험을 설명해주세요. 답변').fill('사용자가 직접 고친 문장입니다.');
    failSave = true;
    await page.getByRole('button', { name: '수정한 답변 저장' }).click();
    await page.getByRole('alert').getByText('테스트 저장 실패').waitFor();
    assert.equal(await page.getByRole('button', { name: '수정한 답변 저장' }).isEnabled(), true);
    failSave = false;
    await page.getByRole('button', { name: '수정한 답변 저장' }).click();
    await page.getByText('수정한 답변을 저장했습니다.', { exact: true }).waitFor();
    assert.equal(saved.essayAnswers[0].answer, '보존할 답변');
    assert.equal(saved.essayAnswers[1].answer, '사용자가 직접 고친 문장입니다.');
    fs.mkdirSync('/tmp/findar-assistant-qa', { recursive: true });
    await page.screenshot({ path: '/tmp/findar-assistant-qa/ui.png', fullPage: true });
    console.log('PASS UI background generation, concurrent Word task, tab switch/unmount recovery, legacy preservation, editing, failed-save recovery');
    await page.getByRole('button', { name: '지원서 자동 입력', exact: true }).click();
    const picker = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Word 파일 선택', exact: true }).click();
    await (await picker).setFiles({ name: '지원서.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('fixture') });
    await page.getByText('지원서.docx', { exact: true }).waitFor();
    await page.getByRole('button', { name: '개인정보·답변 채운 Word 만들기', exact: true }).click();
    const downloadEvent = page.waitForEvent('download');
    const pageUrl = page.url();
    await page.getByRole('link', { name: '작성본 다운로드', exact: true }).click();
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), '지원서-작성본.docx');
    assert.equal(await download.failure(), null);
    assert.deepEqual(fs.readFileSync(await download.path()), downloadBytes);
    assert.equal(page.url(), pageUrl);
    fs.mkdirSync('/tmp/findar-assistant-qa', { recursive: true });
    await page.screenshot({ path: '/tmp/findar-assistant-qa/download-ui.png', fullPage: true });
    console.log('PASS visible file picker and attachment download with Korean filename, bytes, no page navigation');
    await page.goto((process.env.FINDAR_TEST_URL || 'http://localhost:3000') + '/settings');
    await page.getByRole('button', { name: '지원 정보', exact: true }).click();
    await page.getByLabel('한자 이름', { exact: true }).fill('洪吉童');
    await page.getByLabel('종교', { exact: true }).fill('없음');
    assert.equal(await page.getByLabel('주소', { exact: true }).inputValue(), '기존 기본주소');
    await page.getByLabel('주소', { exact: true }).fill('서울시 예시로 1');
    await page.getByLabel('취미', { exact: true }).fill('독서');
    await page.getByLabel('특기', { exact: true }).fill('문서 정리');
    await page.getByRole('button', { name: '저장', exact: true }).last().click();
    await page.getByText('저장되었습니다', { exact: true }).waitFor();
    assert.equal(profilePayload.nameHanja, '洪吉童'); assert.equal(profilePayload.religion, '없음');
    assert.equal(profilePayload.address, '서울시 예시로 1'); assert.equal(profilePayload.addressDetail, '101호');
    assert.equal(profilePayload.hobbies, '독서'); assert.equal(profilePayload.specialties, '문서 정리');
    await page.reload();
    await page.getByRole('button', { name: '지원 정보', exact: true }).click();
    await page.getByLabel('한자 이름', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('한자 이름', { exact: true }).inputValue(), '洪吉童');
    assert.equal(await page.getByLabel('취미', { exact: true }).inputValue(), '독서');
    console.log('PASS personal profile new fields save/reload and existing address preserved');

  } finally { await browser.close(); await new Promise((resolve) => downloadServer.close(resolve)); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
