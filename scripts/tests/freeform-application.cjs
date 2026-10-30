const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'findar-freeform-'));
const previousCwd = process.cwd();
process.chdir(scratch);
const modules = new Map();
const scheduled = [];
let role = { role: '테스트 직무', revision: 'role-1' };
let draft = null;
let passed = 0;
const stubs = {
  'next/server': { after: fn => scheduled.push(fn) },
  '@/lib/db': { getJobBySeq: seq => seq === 'missing' ? undefined : { seq, company: '테스트 회사' }, getApplicationRole: () => role },
  '@/lib/application-draft': { getCachedApplicationDraft: () => draft },
  '@/lib/application-role': { assertApplicationRole: (_seq, revision) => { if (role.revision !== revision) throw new Error('지원 직무가 변경되었습니다.'); } },
};
function load(relative) {
  const file = path.resolve(root, relative);
  if (modules.has(file)) return modules.get(file).exports;
  const mod = { exports: {} }; modules.set(file, mod);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const req = id => stubs[id] || (id.startsWith('@/') ? load(id.slice(2) + '.ts') : id.startsWith('.') ? load(path.relative(root, path.resolve(path.dirname(file), id + '.ts'))) : require(id));
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })(req, mod, mod.exports);
  return mod.exports;
}
function test(name, fn) { fn(); passed++; console.log('PASS', name); }
function entry(fields) { return { question: '지원동기', answer: '저장한 첫 문단입니다.\n\n둘째 문단입니다. <>& 😀', source: 'user_question', status: 'draft', targetRole: role.role, roleRevision: role.revision, ...fields }; }

(async () => {
  try {
    const { detectSubmissionMethod, detectFreeformSubmission } = load('lib/application-method.ts');
    const { buildFreeformDocument, DEFAULT_FREEFORM_OPTIONS: defaults, parseFreeformOptions, freeformFilename } = load('lib/freeform-application.ts');
    const { emptyApplicantProfile, writeApplicantProfile } = load('lib/applicant-profile.ts');
    const profile = { ...emptyApplicantProfile(), name: '테스트 지원자', phone: '010-0000-0000', email: 'candidate@example.test', address: '비공개 주소', birthDate: '2000-01-01', militaryStatus: '군필', militaryBranch: '테스트 군별', militaryRank: '테스트 계급', militaryServiceStart: '2020-01', militaryServiceEnd: '2021-07', skillsNote: '도구 A로 데이터 확인', updatedAt: 1,
      education: [{ schoolLevel: '고등학교', schoolName: '테스트 고등학교', major: '', startDate: '2014-03', endDate: '2017-02', status: '졸업', gpa: '', gpaMax: '4.5' }, { schoolLevel: '대학교', schoolName: '테스트 대학교', major: '테스트 전공', degreeType: '학사', gpa: '4.0', gpaMax: '4.5', startDate: '2017-03', endDate: '2021-02', status: '졸업' }],
      workExperiences: [{ companyName: '회사 A', department: '부서 A', position: '사원', employmentType: '정규직', startDate: '2021-03', endDate: '2022-05', duties: '사용자가 저장한 업무 내용', isCurrent: false }, { companyName: '회사 B', position: '연구원', startDate: '2022-06', duties: '검증 절차를 기록했습니다.', isCurrent: true }],
      certifications: [{ name: '테스트 자격', issuer: '테스트 기관', issuedDate: '2024-05' }],
      languageTests: [{ testName: '테스트 어학', date: '2024-06', score: '800', scoreMax: '990' }],
      projects: [{ name: '학습 프로젝트', startDate: '2024-07', endDate: '2024-08', role: '개인 학습', contributionPercent: '50' }],
      activities: [{ category: '교육', organization: '테스트 교육', startDate: '2024-01', endDate: '2024-02', role: '수강생', detail: '실습 수행' }],
      research: [{ category: '연구과제', title: '테스트 연구', organizer: '테스트 주최', date: '2023-03', authorRank: '2/4', role: '공동 연구' }],
      awards: [{ name: '테스트 수상', organizer: '테스트 주최', date: '2023-05', detail: '저장한 수상 내용' }],
      foreignLanguageSkills: [{ language: '영어', reading: '중', writing: '중', speaking: '하' }],
      portfolioLinks: 'https://example.test/portfolio',
    };
    test('explicit freeform text and consent-only attachment recommend generation', () => {
      const found = detectSubmissionMethod([{ name: '개인정보동의서.pdf', url: '/consent' }], '제출서류: 이력서 및 자기소개서 (자유 양식)\nhr@example.test', '');
      assert.equal(found.freeform.status, 'freeform'); assert.equal(found.templateAttachments.length, 0);
      assert.equal(detectFreeformSubmission('<p>양식 제한 없음</p>', false).status, 'freeform');
    });
    test('provided form and free essay are mixed; absent attachments are not proof of freedom', () => {
      assert.equal(detectSubmissionMethod([{ name: '입사지원서.docx', url: '/form' }], '자기소개서 자유양식', '').freeform.status, 'mixed');
      assert.equal(detectFreeformSubmission('자사 양식 사용\n자기소개서: 자유양식', false).status, 'mixed');
      assert.equal(detectFreeformSubmission('홈페이지에서 지원', false).status, 'unknown');
      assert.equal(detectFreeformSubmission('자기소개서 자유양식으로 인터넷 접수', false).status, 'essay_only');
      assert.equal(detectFreeformSubmission('자유양식 자기소개서', false).status, 'essay_only');
      for (const s of ['자유양식 불가', '자유 양식은 받지 않습니다.', '자유양식으로 제출하지 마세요.']) assert.equal(detectFreeformSubmission(s, false).status, 'unknown');
    });
    test('option validation rejects wrong types, unknown and inherited keys', () => {
      assert.deepEqual(parseFreeformOptions({}), defaults);
      for (const input of [null, [], { mode: 'pdf' }, { includeEssays: 'false' }, { extra: true }, { toString: true }, JSON.parse('{"__proto__":true}')]) assert.throws(() => parseFreeformOptions(input));
    });
    draft = { essayAnswers: [entry({}), entry({ question: '두 번째 질문', answer: '두 번째 답변 그대로입니다.' })] };
    const built = buildFreeformDocument('테스트 회사', role, profile, draft, defaults);
    test('all stored education/employment and experience categories are retained', () => {
      const body = JSON.stringify(built.pages);
      for (const name of ['테스트 고등학교', '테스트 대학교', '회사 A', '회사 B', '학습 프로젝트', '테스트 교육', '테스트 연구', '테스트 수상', '테스트 자격', '테스트 어학']) assert.ok(body.includes(name), name);
      assert.equal(built.pages[0].blocks.find(b => b.title === '학력').rows.length, 2);
      assert.equal(built.pages[0].blocks.find(b => b.title === '경력').rows.length, 2);
      assert.equal(built.pages[0].blocks.find(b => b.title === '경력').headers.length, 3);
      assert.equal(built.pages[0].blocks.filter(b => b.type === 'table').length, 3, 'long activity details must not create another resume table');
      assert.equal(built.pages[0].blocks.find(b => b.title === '학력').rows[0][3], '', 'do not print an unsupplied GPA just because the scale is set');
      assert.ok(body.includes('50%')); assert.ok(body.includes('재직 중'));
      assert.equal(built.pages.length, 3);
    });
    test('saved essays preserve wording, paragraph breaks, Unicode and order', () => {
      const entries = built.pages.at(-1).blocks[0].entries;
      assert.equal(entries[0].lines[0].text, draft.essayAnswers[0].answer);
      assert.equal(entries[1].title, '두 번째 질문');
      assert.equal(entries[1].lines[0].text, '두 번째 답변 그대로입니다.');
    });
    test('military/personal details are optional; defaults from unsaved profiles are never facts', () => {
      assert.equal(JSON.stringify(built.pages).includes('비공개 주소'), false);
      assert.equal(JSON.stringify(built.pages).includes('군필'), false);
      const opted = buildFreeformDocument('회사', role, profile, null, { ...defaults, includeMilitary: true, includePersonalDetails: true });
      assert.ok(JSON.stringify(opted.pages).includes('비공개 주소')); assert.ok(JSON.stringify(opted.pages).includes('2020-01 - 2021-07'));
      const unsaved = buildFreeformDocument('회사', role, emptyApplicantProfile(), null, { ...defaults, includePersonalDetails: true });
      assert.equal(JSON.stringify(unsaved.pages).includes('대한민국'), false); assert.ok(unsaved.warnings.some(w => w.label === '지원 정보'));
    });
    test('blank template copies no candidate facts or saved answers', () => {
      const blank = buildFreeformDocument('테스트 회사', role, profile, draft, { ...defaults, mode: 'blank' });
      const value = JSON.stringify(blank);
      for (const secret of [profile.name, profile.phone, profile.email, '회사 A', '저장한 첫 문단']) assert.equal(value.includes(secret), false);
      assert.equal(blank.filled, 0); assert.equal(blank.pages.length, 3);
      assert.ok(value.includes('[성명]')); assert.ok(value.includes('[내용을 입력해주세요.]'));
    });
    test('stale, needs-info and old generic answers are reported, never exported', () => {
      const result = buildFreeformDocument('회사', role, profile, { essayAnswers: [entry({ answer: 'old-role', roleRevision: 'old' }), entry({ question: '보완', answer: 'needs-info', status: 'needs_info' }), { question: '이전', answer: 'generic-old' }] }, defaults);
      for (const s of ['old-role', 'needs-info', 'generic-old']) assert.equal(JSON.stringify(result.pages).includes(s), false);
      assert.equal(result.warnings.length, 4);
    });
    test('sections can be omitted and filenames cannot contain path/control characters', () => {
      const result = buildFreeformDocument('회사/이름\n', role, profile, draft, { ...defaults, includeDetails: false, includeEssays: false });
      assert.equal(result.pages.length, 1); assert.equal(result.warnings.length, 0);
      assert.equal(/[\/\\\n]/.test(freeformFilename(result, 'filled')), false);
    });
    // Actual generator process, not a mocked DOCX encoder. Use source-root CWD for scripts.
    const { generateFreeformDocx } = load('lib/freeform-document.ts');
    process.chdir(root);
    const encoded = await generateFreeformDocx(built);
    assert.equal(Buffer.from(encoded, 'base64').subarray(0, 2).toString(), 'PK');
    if (process.env.FINDAR_TEST_OUTPUT) fs.writeFileSync(process.env.FINDAR_TEST_OUTPUT, Buffer.from(encoded, 'base64'));
    if (process.env.FINDAR_TEST_BLANK_OUTPUT) {
      const blank = buildFreeformDocument('테스트 회사', role, profile, draft, { ...defaults, mode: 'blank' });
      fs.writeFileSync(process.env.FINDAR_TEST_BLANK_OUTPUT, Buffer.from(await generateFreeformDocx(blank), 'base64'));
    }
    passed++; console.log('PASS actual Python process generates DOCX ZIP');
    const aborted = new AbortController(); aborted.abort();
    assert.throws(() => generateFreeformDocx(built, aborted.signal), { name: 'AbortError' });
    process.chdir(scratch);
    // Route tests use the real subprocess against a copied script in the isolated CWD.
    fs.mkdirSync('scripts', { recursive: true }); fs.copyFileSync(path.join(root, 'scripts/generate-application-docx.py'), 'scripts/generate-application-docx.py');
    fs.mkdirSync('assets/templates', { recursive: true });
    fs.copyFileSync(path.join(root, 'assets/templates/freeform-application.docx'), 'assets/templates/freeform-application.docx');
    writeApplicantProfile(profile);
    const route = load('app/api/applications/[seq]/fill/freeform/route.ts');
    const tasks = load('lib/application-tasks.ts');
    const post = (body, seq = 'fixture', origin = 'http://localhost:3000') => route.POST(new Request('http://localhost:3000/api/test', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ seq }) });
    assert.equal((await post({}, 'fixture', 'https://evil.example')).status, 403);
    assert.equal((await post({}, 'missing')).status, 404);
    assert.equal((await post({ mode: 'invalid' })).status, 400);
    const response = await post(defaults);
    assert.equal(response.status, 202);
    const task = (await response.json()).task;
    assert.equal(task.kind, 'freeform');
    assert.equal((await post(defaults)).status, 400, 'duplicate generation is rejected');
    await scheduled.shift()();
    const done = tasks.getApplicationTask('fixture', task.id);
    assert.equal(done.status, 'completed', done.error);
    assert.ok(done.result.document.downloadUrl.includes('/fixture/fill/document/download'));
    const { documentDownloadResponse } = load('lib/document-download.ts');
    const token = new URL(done.result.document.downloadUrl, 'http://localhost').searchParams.get('token');
    const download = documentDownloadResponse('fixture', token);
    assert.equal(download.status, 200); assert.equal(documentDownloadResponse('other-job', token).status, 410);
    assert.equal(Buffer.from(await download.arrayBuffer()).subarray(0, 2).toString(), 'PK');
    passed++; console.log('PASS async route validates origin/options/job, blocks duplicates, creates scoped download');
    const pending = (await (await post(defaults, 'cancelled')).json()).task;
    tasks.cancelApplicationTask('cancelled', pending.id); await scheduled.shift()();
    assert.equal(tasks.getApplicationTask('cancelled', pending.id).status, 'cancelled');
    assert.equal(tasks.getApplicationTask('cancelled', pending.id).result, undefined);
    const stale = (await (await post(defaults, 'role-changed')).json()).task;
    role = { ...role, revision: 'role-2' }; await scheduled.shift()();
    assert.equal(tasks.getApplicationTask('role-changed', stale.id).status, 'failed');
    assert.match(tasks.getApplicationTask('role-changed', stale.id).error, /지원 직무/);
    passed++; console.log('PASS cancelled task creates no file; role change invalidates in-flight generation');
    console.log(`${passed} freeform tests passed`);
  } finally { process.chdir(previousCwd); fs.rmSync(scratch, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
