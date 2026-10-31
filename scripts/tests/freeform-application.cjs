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
      for (const input of [null, [], { mode: 'pdf' }, { applicationType: '추정 신입' }, { applicationType: true }, { includeEssays: 'false' }, { extra: true }, { toString: true }, JSON.parse('{"__proto__":true}')]) assert.throws(() => parseFreeformOptions(input));
      assert.equal(parseFreeformOptions({ applicationType: '신입' }).applicationType, '신입');
    });
    draft = { essayAnswers: [entry({}), entry({ question: '두 번째 질문', answer: '두 번째 답변 그대로입니다.' })] };
    const built = buildFreeformDocument('테스트 회사', role, profile, draft, defaults);
    const composition = load('lib/freeform-composition.ts');
    const store = load('lib/freeform-composition-store.ts');
    const catalogFor = (p = profile, focus = 'general', materials = [], jobText = '') => ({ version: 'fixture-v1', roleRevision: role.revision, focus, items: composition.recommendComposition(p, materials, role.role, jobText, focus) });
    const selectAll = catalog => ({ ...composition.defaultComposition(catalog), choices: catalog.items.map(i => ({ id: i.id, level: ['work', 'experience'].includes(i.kind) && i.detail ? 'detail' : 'brief' })) });
    test('defaults retain university, languages and concise employment, excluding unrelated records', () => {
      const body = JSON.stringify(built.pages);
      for (const name of ['테스트 대학교', '회사 A', '회사 B', '테스트 어학']) assert.ok(body.includes(name), name);
      for (const name of ['테스트 고등학교', '학습 프로젝트', '테스트 교육', '테스트 연구', '테스트 수상', '테스트 자격']) assert.equal(body.includes(name), false, name);
      assert.equal(built.pages[0].blocks.find(b => b.title === '학력').rows.length, 1);
      assert.equal(built.pages[0].blocks.find(b => b.title === '경력').rows.length, 2);
      assert.equal(built.pages.length, 2, 'no detail page without selected detailed experiences');
    });
    test('explicit selection preserves all saved records and original detail without fabrication', () => {
      const catalog = catalogFor();
      const result = buildFreeformDocument('회사', role, profile, draft, { ...defaults, composition: selectAll(catalog) }, catalog);
      const body = JSON.stringify(result.pages);
      for (const name of ['테스트 고등학교', '학습 프로젝트', '테스트 교육', '테스트 연구', '테스트 수상', '테스트 자격']) assert.ok(body.includes(name), name);
      assert.equal(result.pages[0].blocks.find(b => b.title === '학력').rows[0][3], '');
      assert.ok(body.includes('50%')); assert.ok(body.includes('재직 중'));
      assert.equal(result.pages.length, 3);
    });
    test('saved essays preserve wording, paragraph breaks, Unicode and order', () => {
      const entries = built.pages.at(-1).blocks[0].entries;
      assert.equal(entries[0].lines[0].text, draft.essayAnswers[0].answer);
      assert.equal(entries[1].title, '두 번째 질문');
      assert.equal(entries[1].lines[0].text, '두 번째 답변 그대로입니다.');
    });
    test('brief and excluded experiences never leak full detail; detailed selections alone create detail sections', () => {
      const material = { id: 'verified', title: '데이터 검증 프로젝트', category: '개인 프로젝트', period: '', summary: '자료 정합성 확인', detail: '원본 데이터 오류를 확인한 구체적인 수행 내용', tags: ['risk'], status: 'confirmed', source: '실제 코드', updatedAt: 1 };
      const catalog = catalogFor(profile, 'risk', [material]);
      const plan = composition.defaultComposition(catalog);
      assert.equal(plan.choices.find(c => c.id === 'material:verified').level, 'detail');
      const build = level => buildFreeformDocument('회사', role, profile, draft, { ...defaults, composition: { ...plan, choices: plan.choices.map(c => c.id === 'material:verified' ? { ...c, level } : c) } }, catalog);
      const brief = build('brief');
      assert.ok(JSON.stringify(brief).includes(material.summary));
      assert.equal(JSON.stringify(brief).includes(material.detail), false);
      assert.equal(brief.pages.length, 2);
      assert.equal(JSON.stringify(build('exclude')).includes(material.title), false);
      const detailed = build('detail');
      assert.equal(detailed.pages[1].blocks[0].entries[0].lines[0].text, material.detail);
      const inline = buildFreeformDocument('회사', role, profile, draft, { ...defaults, composition: plan, includeDetails: false }, catalog);
      assert.equal(inline.pages.length, 2);
      assert.ok(JSON.stringify(inline.pages[0]).includes(material.detail));
    });
    test('long employment details are exported only when explicitly selected', () => {
      const duties = '긴 업무 원문과 문단을 보존합니다. '.repeat(40) + '\n두 번째 문단 끝';
      const p = { ...profile, workExperiences: [{ ...profile.workExperiences[0], duties }] }, catalog = catalogFor(p);
      const brief = buildFreeformDocument('회사', role, p, draft, defaults);
      assert.equal(JSON.stringify(brief).includes(duties), false);
      const withDetails = buildFreeformDocument('회사', role, p, draft, { ...defaults, composition: selectAll(catalog) }, catalog);
      assert.equal(JSON.stringify(withDetails.pages[0]).includes(duties), false);
      assert.equal(withDetails.pages[1].blocks[0].entries[0].lines[0].text, duties);
    });
    test('focus changes relevance; finance credentials stay and development research stays auxiliary', () => {
      const p = { ...profile, certifications: [{ name: '투자자산운용사' }, { name: '재무위험관리사' }, { name: '정보처리기사' }], activities: [{ organization: 'Babylon 연구', category: '학회', role: '프로토콜 조사', detail: '블록체인 구조 조사' }] };
      const digital = catalogFor(p, 'digital'), risk = catalogFor(p, 'risk');
      assert.equal(digital.items.find(i => i.title === 'Babylon 연구').recommended, 'detail');
      assert.equal(risk.items.find(i => i.title === 'Babylon 연구').recommended, 'exclude');
      assert.equal(risk.items.find(i => i.title === '재무위험관리사').recommended, 'brief');
      assert.equal(risk.items.find(i => i.title === '정보처리기사').recommended, 'exclude');
      assert.equal(risk.items.find(i => i.category === '학술 연구').recommended, 'exclude');
      assert.equal(composition.inferCompositionFocus('리스크관리'), 'risk');
      assert.equal(composition.inferCompositionFocus('매크로 리서치'), 'macro');
      assert.equal(composition.inferCompositionFocus('운용지원'), 'bond');
    });
    test('full-career and high-school requirements cannot be excluded', () => {
      const catalog = catalogFor(profile, 'general', [], '고등학교 포함하여 작성. 모든 경력을 기재해주세요.');
      const plan = composition.defaultComposition(catalog);
      assert.equal(catalog.items.filter(i => i.required).length, 3);
      const required = catalog.items.find(i => i.required);
      assert.throws(() => composition.resolveComposition(catalog, { ...plan, choices: plan.choices.map(c => c.id === required.id ? { ...c, level: 'exclude' } : c) }), /제외할 수/);
    });
    test('stale versions, roles, unknown and duplicate IDs and unconfirmed selections are rejected', () => {
      const material = { id: 'review', title: '미확인', category: '학습', period: '', summary: '요약', detail: '미검증 수치', tags: ['risk'], status: 'review', source: '이전 글', updatedAt: 0 };
      const catalog = catalogFor(profile, 'risk', [material]), plan = composition.defaultComposition(catalog);
      for (const changed of [{ version: 'old' }, { roleRevision: 'old' }, { focus: 'equity' }]) assert.throws(() => composition.resolveComposition(catalog, { ...plan, ...changed }), /변경/);
      assert.throws(() => composition.resolveComposition(catalog, { ...plan, choices: [{ id: 'unknown', level: 'brief' }] }), /없는 이력/);
      assert.throws(() => composition.resolveComposition(catalog, { ...plan, choices: [{ id: 'material:review', level: 'detail' }] }), /확인하지/);
      assert.throws(() => composition.parseComposition({ ...plan, choices: [plan.choices[0], plan.choices[0]] }), /중복/);
      assert.throws(() => composition.parseComposition({ ...plan, choices: [{ id: 'x', level: 'brief', summary: '두\n줄' }] }));
      assert.throws(() => composition.parseComposition({ ...plan, toString: true }));
      const core = catalog.items.find(i => i.kind === 'education');
      assert.throws(() => composition.resolveComposition(catalog, { ...plan, choices: [{ id: core.id, level: 'detail' }] }), /기본 항목/);
    });
    test('per-posting overrides change only exported explanation and do not mutate source records', () => {
      const catalog = catalogFor(), plan = composition.defaultComposition(catalog), job = catalog.items.find(i => i.kind === 'work');
      const chosen = { ...plan, choices: plan.choices.map(c => c.id === job.id ? { ...c, level: 'detail', summary: '이번 공고의 한 줄 설명', detail: '이번 공고에 맞춰 직접 확인한 설명' } : c) };
      const result = buildFreeformDocument('회사', role, profile, null, { ...defaults, includeEssays: false, composition: chosen }, catalog);
      assert.ok(JSON.stringify(result).includes('이번 공고의 한 줄 설명'));
      assert.ok(JSON.stringify(result).includes('이번 공고에 맞춰 직접 확인한 설명'));
      assert.equal(profile.workExperiences[0].duties, '사용자가 저장한 업무 내용');
      assert.equal(job.detail, profile.workExperiences[0].duties);
    });
    test('military/personal details are optional; defaults from unsaved profiles are never facts', () => {
      assert.equal(JSON.stringify(built.pages).includes('비공개 주소'), false);
      assert.equal(JSON.stringify(built.personalRows).includes('비공개 주소'), false);
      assert.equal(built.personalRows.length, 2);
      assert.equal(JSON.stringify(built.pages).includes('군필'), false);
      const opted = buildFreeformDocument('회사', role, profile, null, { ...defaults, includeMilitary: true, includePersonalDetails: true });
      assert.ok(JSON.stringify(opted.personalRows).includes('비공개 주소')); assert.ok(JSON.stringify(opted.pages).includes('2020.01 ~ 2021.07'));
      const unsaved = buildFreeformDocument('회사', role, emptyApplicantProfile(), null, { ...defaults, includePersonalDetails: true });
      assert.equal(JSON.stringify(unsaved).includes('대한민국'), false); assert.ok(unsaved.warnings.some(w => w.label === '지원 정보'));
      assert.equal(built.applicationType, '', 'prior work experience must not determine the application category');
      assert.equal(buildFreeformDocument('회사', role, profile, null, { ...defaults, applicationType: '신입' }).applicationType, '신입');
    });
    test('blank template copies no candidate facts or saved answers', () => {
      const blank = buildFreeformDocument('테스트 회사', role, profile, draft, { ...defaults, mode: 'blank' });
      const value = JSON.stringify(blank);
      for (const secret of [profile.name, profile.phone, profile.email, '회사 A', '저장한 첫 문단']) assert.equal(value.includes(secret), false);
      assert.equal(blank.filled, 0); assert.equal(blank.pages.length, 3);
      assert.ok(value.includes('[성명]')); assert.ok(value.includes('[내용을 입력해주세요.]'));
      const opted = buildFreeformDocument('회사', role, profile, draft, { ...defaults, mode: 'blank', includePersonalDetails: true, includeMilitary: true });
      assert.equal(opted.personalRows.length, 4);
      assert.ok(JSON.stringify(opted).includes('[주소]'));
      for (const secret of ['비공개 주소', profile.birthDate, profile.phone, profile.name, '군필']) assert.equal(JSON.stringify(opted).includes(secret), false);
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
    const get = (seq = 'fixture', query = '') => route.GET(new Request(`http://localhost:3000/api/test${query}`), { params: Promise.resolve({ seq }) });
    const put = (plan, seq = 'fixture', origin = 'http://localhost:3000') => route.PUT(new Request('http://localhost:3000/api/test', { method: 'PUT', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(plan) }), { params: Promise.resolve({ seq }) });
    fs.writeFileSync('data/experience-cards.json', JSON.stringify({ cards: [
      { id: 'EXP-01', context: '과거 기록', personal_actions: ['실제 수행 여부 확인 전'], result_limitations: ['수치 불일치'] },
      { id: 'EXP-02', excluded: true, context: '제외된 경험', personal_actions: ['포함 금지'] },
    ] }));
    let catalogResponse = await (await get()).json();
    assert.equal(catalogResponse.catalog.items.filter(i => i.status === 'review').length, 1);
    const materialsRoute = load('app/api/application-materials/route.ts');
    const save = (fields, origin = 'http://localhost:3000') => materialsRoute.PUT(new Request('http://localhost:3000/api/application-materials', { method: 'PUT', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(fields) }));
    const input = { title: '직접 확인한 경험', category: '개인 프로젝트', period: '', summary: '실제 자료 확인', detail: '실제로 수행한 범위만 정리했습니다.', tags: ['risk'], status: 'confirmed', source: '검토한 원본', originId: 'card:EXP-01' };
    assert.equal((await save(input, 'https://evil.example')).status, 403);
    assert.equal((await save({ ...input, summary: '' })).status, 400);
    const added = await (await save(input)).json();
    assert.ok(added.material.id);
    assert.equal((await save({ ...input, id: added.material.id, expectedUpdatedAt: 0 })).status, 400);
    catalogResponse = await (await get('fixture', '?focus=risk&reset=1')).json();
    assert.equal(catalogResponse.catalog.items.filter(i => i.status === 'review').length, 0, 'imported cards disappear; excluded cards never appear');
    assert.equal(catalogResponse.plan.choices.find(c => c.id === `material:${added.material.id}`).level, 'detail');
    assert.equal((await put(catalogResponse.plan, 'fixture', 'https://evil.example')).status, 403);
    assert.equal((await put({ ...catalogResponse.plan, version: 'old' })).status, 400);
    assert.equal((await put(catalogResponse.plan)).status, 200);
    assert.equal((await (await get()).json()).catalog.focus, 'risk', 'saved focus retained for the same role');
    const changedProfile = { ...profile, skillsNote: '변경된 자료', updatedAt: Date.now() + 10 };
    writeApplicantProfile(changedProfile);
    assert.equal((await put(catalogResponse.plan)).status, 400);
    assert.equal((await post({ ...defaults, composition: catalogResponse.plan })).status, 400, 'stale source snapshot cannot generate');
    assert.match((await (await get()).json()).notice, /달라/);
    assert.equal((await get('fixture', '?focus=invalid')).status, 400);
    assert.equal((await get('missing')).status, 404);
    passed++; console.log('PASS material confirmation, origin, concurrency, saved focus and source invalidation through routes');
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
