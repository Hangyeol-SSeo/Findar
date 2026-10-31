// Run with FINDAR_PLAYWRIGHT pointing to the bundled Playwright package and a running dev server.
let chromium;
try { ({ chromium } = require(process.env.FINDAR_PLAYWRIGHT || 'playwright')); } catch (error) {
  // Opt-in browser regression test (see README): skip unless Playwright is available.
  if (process.env.FINDAR_PLAYWRIGHT || error.code !== 'MODULE_NOT_FOUND') throw error;
  console.log('SKIP %s: Playwright not found (set FINDAR_PLAYWRIGHT)', require('node:path').basename(__filename));
  process.exit(0);
}
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
    const freeformRequests = [];
    let freeformHint;
    let compositionPlan;
    const compositionItems = [
      { id: 'work:1', kind: 'work', title: '개발 회사', category: '근무 경력', period: '2025', summary: '앱 개발', detail: '개발 상세 수행 내용', source: '지원 정보', status: 'confirmed', tags: [], required: false, recommended: 'brief', reason: '근무 사실을 짧게 남깁니다.' },
      { id: 'experience:1', kind: 'experience', title: '자료 검증 프로젝트', category: '개인 프로젝트', period: '', summary: '수집 자료 확인', detail: '구체적으로 확인한 범위', source: '확인한 코드', status: 'confirmed', tags: ['risk'], required: false, recommended: 'detail', reason: '관련 경험을 자세히 표시합니다.' },
      { id: 'material:card-EXP-01', kind: 'experience', title: '확인 전 경험', category: '경험 자료', period: '', summary: '확인 필요', detail: '수치가 서로 다릅니다.', source: '과거 글', status: 'review', tags: [], required: false, recommended: 'exclude', reason: '실제 수행 내용을 확인해주세요.' },
    ];
    let releaseWriting;
    let profilePayload = { name: '테스트 이름', address: '기존 기본주소', addressDetail: '101호', updatedAt: 1 };
    const downloadBytes = Buffer.from('test-document-bytes');
    await page.route('**/api/**', async (route) => {
      const req = route.request(); const url = new URL(req.url());
      let data = {}; let status = 200;
      if (url.origin === downloadOrigin) return route.continue();
      if (url.pathname === '/api/jobs') data = { jobs: [job], hasProfile: true };
      else if (url.pathname === '/api/jobs/hide') data = { jobs: [] };
      // All profile sections stay mounted, even while another section is visible.
      else if (url.pathname === '/api/profile/resume') data = { files: [], status: 'missing', analyzing: false, profile: null };
      else if (url.pathname === '/api/experience-cards') data = { cards: [], sourceCount: 0, running: false, essayRunning: false };
      else if (url.pathname === '/api/essay-sources') data = { files: [], finals: [], progress: { running: false, done: 0, total: 0, current: '' } };
      else if (url.pathname === '/api/profile/narrative') data = { profile: null };
      else if (url.pathname === '/api/profile/applicant') {
        if (req.method() === 'PUT') { profilePayload = req.postDataJSON(); data = { ok: true }; }
        else data = { profile: profilePayload };
      }
      else if (url.pathname.endsWith('/fill/document/download')) {
        const response = documentDownloadResponse(job.seq, url.searchParams.get('token'));
        return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
      }
      else if (url.pathname.endsWith('/tasks')) { taskRequests++; data = { tasks }; }
      else if (url.pathname.endsWith('/role')) data = { role: '운영', revision: 'fixture-role' };
      else if (url.pathname.endsWith('/fill/web')) { webRequests++; data = { token: 'a'.repeat(64) }; }
      else if (url.pathname.endsWith('/fill/freeform')) {
        if (req.method() === 'GET') {
          const focus = url.searchParams.get('focus') || compositionPlan?.focus || 'risk';
          const catalog = { version: 'fixture-version', roleRevision: 'fixture-role', focus, items: compositionItems };
          const plan = url.searchParams.get('reset') || !compositionPlan ? { version: catalog.version, roleRevision: catalog.roleRevision, focus, choices: compositionItems.map(i => ({ id: i.id, level: i.recommended })) } : compositionPlan;
          return route.fulfill({ json: { catalog, plan, materials: [], notice: '' } });
        }
        if (req.method() === 'PUT') { compositionPlan = req.postDataJSON(); return route.fulfill({ json: { saved: true } }); }
        const options = req.postDataJSON(); freeformRequests.push(options); compositionPlan = options.composition;
        const document = { total: 10, downloadUrl: downloadOrigin + storeDocumentDownload(job.seq, '자유양식-입사지원서.docx', downloadBytes.toString('base64')), filename: '자유양식-입사지원서.docx', filled: 8, skipped: [{ label: '확인 항목', reason: '테스트용 누락 안내' }], note: '저장한 내용으로 생성했습니다.' };
        const task = { id: 'freeform-' + tasks.length, kind: 'freeform', status: 'completed', done: 1, total: 1, result: { document } };
        tasks.push(task); data = { task }; status = 202;
      }
      else if (url.pathname.endsWith('/fill/document')) { const document = { total: 3, downloadUrl: downloadOrigin + storeDocumentDownload(job.seq, '지원서-작성본.docx', downloadBytes.toString('base64')), filename: '지원서-작성본.docx', filled: 3, skipped: [], note: '작성본을 확인해주세요.' }; const task = { id: 'doc-' + tasks.length, kind: 'document', status: 'completed', done: 1, total: 1, result: { document } }; tasks.push(task); data = { task }; status = 202; }
      else if (url.pathname.endsWith('/draft/import')) {
        const body = req.postDataJSON(); assert.ok(['팀의 문제를 해결한 경험을 설명해주세요.', '입사 후 포부를 적어주세요.'].includes(body.question));
        const answer = { question: body.question, countSpaces: true, guidance: '', source: 'user_question', intent: '', answer: body.answer, evidence: [], missingInfo: [], reviewNotes: [], status: 'draft', generatedAt: Date.now() };
        saved = { ...saved, revision: 'imported', essayAnswers: [...saved.essayAnswers, answer] }; data = { draft: saved };
      }
      else if (url.pathname.endsWith('/draft/answer-action')) {
        const body = req.postDataJSON(); assert.equal(body.action, 'move'); assert.equal(body.revision, saved.revision);
        const list = [...saved.essayAnswers];
        const slots = list.flatMap((a, k) => (a.source === 'user_question' ? [k] : []));
        const from = slots.findIndex((k) => list[k].question === body.question);
        const a = slots[from], b = slots[body.direction === 'up' ? from - 1 : from + 1];
        [list[a], list[b]] = [list[b], list[a]];
        saved = { ...saved, revision: 'moved', essayAnswers: list }; data = { draft: saved };
      }
      else if (url.pathname.endsWith('/draft/review')) {
        generationRequests++;
        const { question } = req.postDataJSON();
        const task = { id: 'review', kind: 'revision', question, status: 'running', done: 0, total: 1 }; tasks.push(task); data = { task }; status = 202;
        releaseWriting = () => {
          saved = { ...saved, revision: 'reviewed', essayAnswers: saved.essayAnswers.map((a) => a.question === question ? { ...a, feedback: { focus: '', baseText: a.answer, summary: '흐름이 자연스럽습니다.', strengths: [], issues: [], suggestions: [], createdAt: Date.now() } } : a) };
          task.status = 'completed'; task.done = 1; task.result = { draft: saved, outcome: 'feedback' };
        };
      } else if (url.pathname.endsWith('/draft')) {
        if (req.method() === 'PUT') {
          if (failSave) { data = { error: '테스트 저장 실패' }; status = 500; }
          else { saved = { ...req.postDataJSON(), revision: 'edited' }; data = { draft: saved }; }
        } else data = { draft: saved, finals: [], siteUrl: job.siteUrl, submissionMethod: { method: 'web_form', templateAttachments: [], consentAttachments: [], submissionEmail: null, freeform: freeformHint } };
      } else { status = 400; data = { error: 'Unexpected API in fixture test' }; }
      await route.fulfill({ status, json: data });
    });
    await page.addInitScript(() => localStorage.setItem('findar:matchEnabled', 'false'));
    await page.goto(process.env.FINDAR_TEST_URL || 'http://localhost:3000');
    await page.getByText(job.title, { exact: true }).click();
    await page.getByRole('button', { name: '지원 도우미', exact: true }).click();
    await page.getByRole('heading', { name: '자기소개서', exact: true }).waitFor();
    assert.equal(generationRequests, 0);
    await page.waitForTimeout(300);
    const idleRequests = taskRequests;
    await page.waitForTimeout(4500);
    assert.equal(taskRequests, idleRequests, 'no idle task polling');
    await page.getByRole('button', { name: '지원서 생성·자동 입력', exact: true }).click();
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
    await page.getByLabel('지원서 문항', { exact: true }).fill('팀의 문제를 해결한 경험을 설명해주세요.');
    await page.getByLabel('내가 쓴 답변', { exact: true }).fill('재현 절차를 기록하고 담당자와 확인 순서를 맞췄습니다.');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await page.getByText(/자기소개서를 저장했습니다/).waitFor();
    assert.equal(generationRequests, 0, 'saving an essay makes no AI call');
    await page.getByRole('button', { name: '첨삭 받기', exact: true }).click();
    await page.getByRole('button', { name: '첨삭 받기', exact: true }).click();
    await page.getByText(/첨삭을 시작했습니다/).waitFor();
    await page.getByRole('button', { name: '지원서 생성·자동 입력', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Word 파일 선택', exact: true }).isEnabled(), true);
    await page.getByLabel('Word 지원서 양식').setInputFiles({ name: '동시작업.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('fixture') });
    await page.getByRole('button', { name: '개인정보·답변 채운 Word 만들기', exact: true }).click();
    await page.getByText(/Word 작성을 시작했습니다/).waitFor();
    assert.ok(tasks.some(t => t.kind === 'revision' && t.status === 'running'));
    assert.ok(tasks.some(t => t.kind === 'document'));
    await page.waitForTimeout(300);
    const runningRequests = taskRequests;
    await page.waitForTimeout(2300);
    assert.ok(taskRequests > runningRequests, 'new task resumes polling');
    await page.getByRole('button', { name: '공고 상세', exact: true }).click();
    releaseWriting();
    await page.getByRole('button', { name: '지원 도우미', exact: true }).click();
    await page.getByText('흐름이 자연스럽습니다.', { exact: true }).waitFor();
    assert.equal(generationRequests, 1);
    const completedRequests = taskRequests;
    await page.waitForTimeout(4500);
    assert.equal(taskRequests, completedRequests, 'no polling after completion');
    console.log('PASS terminal tasks stop polling');
    const answerBox = page.getByLabel('팀의 문제를 해결한 경험을 설명해주세요. 답변');
    const saveAnswer = page.locator('section', { has: answerBox }).getByRole('button', { name: '답변 저장', exact: true });
    await answerBox.fill('사용자가 직접 고친 문장입니다.');
    failSave = true;
    await saveAnswer.click();
    await page.getByRole('alert').getByText('테스트 저장 실패').waitFor();
    assert.equal(await saveAnswer.isEnabled(), true);
    failSave = false;
    await saveAnswer.click();
    await page.getByText('답변을 저장했습니다.', { exact: true }).waitFor();
    assert.equal(saved.essayAnswers[0].answer, '보존할 답변');
    assert.equal(saved.essayAnswers[1].answer, '사용자가 직접 고친 문장입니다.');
    await page.locator('section', { has: answerBox }).getByRole('button', { name: '답변 저장됨', exact: true }).waitFor();
    // 문항 순서 바꾸기: 다른 문항에서 저장하지 않은 수정은 순서가 바뀌어도 그대로 남는다.
    await page.getByText('자기소개서 저장', { exact: true }).click();
    await page.getByLabel('지원서 문항', { exact: true }).fill('입사 후 포부를 적어주세요.');
    await page.getByLabel('내가 쓴 답변', { exact: true }).fill('포부 본문입니다.');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await page.getByText(/자기소개서를 저장했습니다/).waitFor();
    await answerBox.fill('사용자가 직접 고친 문장입니다. 아직 저장 안 함');
    assert.equal(await page.getByRole('button', { name: '팀의 문제를 해결한 경험을 설명해주세요. 문항 위로 옮기기' }).isEnabled(), false);
    await page.getByRole('button', { name: '입사 후 포부를 적어주세요. 문항 위로 옮기기' }).click();
    await page.waitForFunction(() => decodeURIComponent(document.querySelector('[data-answer-section]')?.dataset.answerSection ?? '') === '입사 후 포부를 적어주세요.');
    assert.deepEqual(await page.locator('[data-answer-section]').evaluateAll((els) => els.map((el) => decodeURIComponent(el.dataset.answerSection))), ['입사 후 포부를 적어주세요.', '팀의 문제를 해결한 경험을 설명해주세요.']);
    assert.deepEqual(saved.essayAnswers.map((a) => a.question), ['예전 공통 문항', '입사 후 포부를 적어주세요.', '팀의 문제를 해결한 경험을 설명해주세요.']);
    assert.equal(await answerBox.inputValue(), '사용자가 직접 고친 문장입니다. 아직 저장 안 함');
    assert.equal(await saveAnswer.isEnabled(), true);
    fs.mkdirSync('/tmp/findar-assistant-qa', { recursive: true });
    await page.screenshot({ path: '/tmp/findar-assistant-qa/ui.png', fullPage: true });
    console.log('PASS UI essay save without AI, background review, concurrent Word task, tab switch/unmount recovery, legacy preservation, editing, failed-save recovery, question reorder keeps unsaved edits');
    await page.getByRole('button', { name: '지원서 생성·자동 입력', exact: true }).click();
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
    await page.goto((process.env.FINDAR_TEST_URL || 'http://localhost:3000') + '/profile#applicant');
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
    await page.getByLabel('한자 이름', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('한자 이름', { exact: true }).inputValue(), '洪吉童');
    assert.equal(await page.getByLabel('취미', { exact: true }).inputValue(), '독서');
    console.log('PASS personal profile new fields save/reload and existing address preserved');

    freeformHint = { status: 'freeform', evidence: '이력서와 자기소개서 자유양식 제출' };
    await page.goto(process.env.FINDAR_TEST_URL || 'http://localhost:3000');
    await page.getByText(job.title, { exact: true }).click();
    await page.getByRole('button', { name: '지원 도우미', exact: true }).click();
    await page.getByRole('heading', { name: '자유양식 지원서 만들기', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '지원서 생성·자동 입력', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByLabel('병역', { exact: true }).isChecked(), false);
    assert.equal(await page.getByLabel('생년월일·성별·국적·주소', { exact: true }).isChecked(), false);
    await page.getByLabel('병역', { exact: true }).check();
    const aiBefore = generationRequests;
    const compositionSection = page.getByRole('region', { name: '지원서 이력 구성', exact: true });
    await compositionSection.getByLabel('개발 회사 기재 방식').selectOption('exclude');
    await compositionSection.getByLabel('자료 검증 프로젝트 기재 방식').selectOption('brief');
    await compositionSection.getByText('제출할 설명 확인·수정', { exact: true }).click();
    await compositionSection.getByLabel('한 줄 설명', { exact: true }).fill('이 공고에서 확인한 수행 내용');
    await compositionSection.getByRole('button', { name: '이 공고의 구성 저장', exact: true }).click();
    await compositionSection.getByText('이 공고의 구성을 저장했습니다.', { exact: true }).waitFor();
    await page.getByRole('button', { name: '선택한 이력으로 지원서 만들기', exact: true }).click();
    const freeformDownload = page.getByRole('link', { name: '생성한 지원서 다운로드', exact: true });
    await freeformDownload.waitFor();
    assert.equal(freeformRequests.length, 1);
    assert.equal(freeformRequests[0].includeMilitary, true);
    assert.equal(freeformRequests[0].applicationType, '');
    assert.equal(freeformRequests[0].composition.choices.find(c => c.id === 'work:1').level, 'exclude');
    assert.deepEqual(freeformRequests[0].composition.choices.find(c => c.id === 'experience:1'), { id: 'experience:1', level: 'brief', summary: '이 공고에서 확인한 수행 내용' });
    await page.getByText('확인 항목: 테스트용 누락 안내', { exact: true }).waitFor();
    const freeformEvent = page.waitForEvent('download');
    await freeformDownload.click();
    const generatedDownload = await freeformEvent;
    assert.equal(generatedDownload.suggestedFilename(), '자유양식-입사지원서.docx');
    assert.deepEqual(fs.readFileSync(await generatedDownload.path()), downloadBytes);
    await page.getByLabel('이 공고의 자기소개서', { exact: true }).uncheck();
    await page.getByRole('button', { name: '빈 양식 만들기', exact: true }).click();
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).some(b => b.textContent === '지원서 생성 중...'));
    assert.equal(freeformRequests[1].mode, 'blank'); assert.equal(freeformRequests[1].includeEssays, false);
    assert.equal(generationRequests, aiBefore, 'freeform generation makes no AI call');
    await page.screenshot({ path: '/tmp/findar-assistant-qa/freeform-ui.png', fullPage: true });
    freeformHint = { status: 'mixed', evidence: '자기소개서 자유양식, 입사지원서는 자사 양식' };
    await page.reload();
    await page.getByText(job.title, { exact: true }).click();
    await page.getByRole('button', { name: '지원 도우미', exact: true }).click();
    await page.getByRole('button', { name: '지원서 생성·자동 입력', exact: true }).click();
    await page.getByText(/회사 지정 양식도 확인됩니다/).waitFor();
    await page.getByRole('link', { name: '생성한 지원서 다운로드', exact: true }).waitFor();
    await page.getByLabel('개발 회사 기재 방식').selectOption('brief');
    await page.getByLabel('자료 검증 프로젝트 기재 방식').selectOption('detail');
    await page.getByText('확인 후 추가할 경험 자료 1개', { exact: true }).click();
    await page.getByRole('button', { name: '내용 확인·추가', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '선택한 이력으로 지원서 만들기', exact: true }).isEnabled(), false, 'unfinished material edit blocks generation');
    assert.equal(await page.getByLabel('실제로 수행한 내용', { exact: true }).inputValue(), '수치가 서로 다릅니다.');
    await page.getByRole('button', { name: '닫기', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '선택한 이력으로 지원서 만들기', exact: true }).isEnabled(), true);
    await page.getByLabel('구성 기준').selectOption('macro');
    await page.getByText('상세 1개 · 한 줄 1개 · 제외 1개', { exact: true }).waitFor();
    console.log('PASS three selection levels, per-posting explanation, save, unconfirmed editor and focus reset');
    console.log('PASS freeform recommendation, optional fields, filled/blank modes, download, missing-data notice, no AI, reload recovery, mixed-template guidance');

  } finally { await browser.close(); await new Promise((resolve) => downloadServer.close(resolve)); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
