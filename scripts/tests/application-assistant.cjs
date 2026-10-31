const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'findar-assistant-test-'));
const oldCwd = process.cwd();
process.chdir(scratch);
const cache = new Map();
function load(relative) {
  const filename = path.resolve(root, relative);
  if (cache.has(filename)) return cache.get(filename).exports;
  const mod = { exports: {} }; cache.set(filename, mod);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const req = (id) => id === '@anthropic-ai/claude-agent-sdk' ? { query() { throw new Error('Live model not permitted in unit test'); } } : id.startsWith('.') ? load(path.relative(root, path.resolve(path.dirname(filename), id + '.ts'))) : require(id);
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename })(req, mod, mod.exports);
  return mod.exports;
}
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS', name); }
try {
  const { parseEssayRequest, hasBanmalEnding, characterCount } = load('lib/essay-contract.ts');
  const request = parseEssayRequest({ question: '협업 경험을 설명해주세요. 500자 이내, 공백 제외' });
  test('pasted question limit and whitespace convention', () => { assert.equal(request.maxChars, 500); assert.equal(request.countSpaces, false); assert.equal(characterCount('한 글😀', false), 3); });
  test('no generic essay request', () => assert.throws(() => parseEssayRequest({ question: '  ' })));
  test('explicit limit overrides pasted limit', () => assert.equal(parseEssayRequest({ question: '500자 이내', maxChars: 300 }).maxChars, 300));
  test('reject invalid constraints', () => assert.throws(() => parseEssayRequest({ question: '경험', maxChars: -1 })));
  test('detect informal endings and mixed speech levels', () => {
    for (const answer of ['손실을 보고 나서야 이해했다. 이후 공부했습니다.', '확인 절차를 바꿨다.', '원인을 기록했다.\n결과를 확인했습니다.'])
      assert.equal(hasBanmalEnding(answer), true);
    assert.equal(hasBanmalEnding('문의 재현 절차를 기록했습니다.'), false);
  });
  test('quoted informal speech does not count as informal narration', () => assert.equal(hasBanmalEnding('“문제가 있다.”라는 의견을 듣고 확인했습니다.'), false));
  const { resolveFillPlan, buildFillSources, permittedTarget, buildEssayFillSources, deterministicFillAssignments } = load('lib/application-fill.ts');
  const { emptyApplicantProfile } = load('lib/applicant-profile.ts');
  const profile = { ...emptyApplicantProfile(), name: '홍길동', phone: '010-1234-5678', updatedAt: 1 };
  const values = buildFillSources(profile);
  const targets = [{ id: 'name', label: '성명', type: 'text' }, { id: 'sign', label: '서명' }, { id: 'phone', label: '연락처' }];
  test('no assumed defaults before profile saved', () => assert.deepEqual(buildFillSources(emptyApplicantProfile()), []));
  test('mapping cannot invent values', () => { const p = resolveFillPlan([{ targetId: 'name', sourceId: 'name', value: '발명한 이름' }], targets, values); assert.equal(p.assignments[0].value, '홍길동'); });
  test('signatures cannot be filled even when model maps them', () => assert.equal(resolveFillPlan([{ targetId: 'sign', sourceId: 'name' }], targets, values).assignments.length, 0));
  test('sensitive controls excluded', () => { assert.equal(permittedTarget({ id: 'x', label: '비밀번호' }), false); assert.equal(permittedTarget({ id: 'x', label: '선택', type: 'checkbox' }), false); });
  test('unknown source and duplicate assignments skipped', () => assert.equal(resolveFillPlan([{ targetId: 'name', sourceId: 'name' }, { targetId: 'name', sourceId: 'phone' }, { targetId: 'phone', sourceId: 'missing' }], targets, values).assignments.length, 0));
  test('select requires exact saved value', () => assert.equal(resolveFillPlan([{ targetId: 'name', sourceId: 'name' }], [{ id: 'name', label: '성명', options: ['다른값'] }], values).assignments.length, 0));
  test('new personal details retain user-entered values for autofill', () => {
    const fields = buildFillSources({ ...profile, nameHanja: '洪吉童', religion: '없음', hobbies: '독서', specialties: '문서 정리', address: '서울시 예시로 1', addressDetail: '101호' });
    for (const [id, expected] of Object.entries({ nameHanja: '洪吉童', religion: '없음', hobbies: '독서', specialties: '문서 정리', fullAddress: '서울시 예시로 1 101호' })) assert.equal(fields.find((f) => f.id === id).value, expected);
  });
  test('old profiles get empty new fields without losing address', () => {
    fs.writeFileSync(path.join(scratch, 'data/applicant-profile.json'), JSON.stringify({ name: '홍길동', address: '기존 주소', addressDetail: '기존 상세주소', updatedAt: 1 }));
    const restored = load('lib/applicant-profile.ts').readApplicantProfile();
    assert.equal(restored.nameHanja, ''); assert.equal(restored.religion, ''); assert.equal(restored.hobbies, ''); assert.equal(restored.specialties, '');
    assert.equal(restored.address, '기존 주소'); assert.equal(restored.addressDetail, '기존 상세주소');
  });
  test('structured repeated rows keep education entries and compound values distinct', () => {
    const entries = [{ schoolName: '학교 A', schoolLevel: '대학교', startDate: '2010-03', endDate: '2014-02', gpa: '4.0', gpaMax: '4.5' }, { schoolName: '학교 B', schoolLevel: '대학원', startDate: '2014-03', endDate: '2016-02', gpa: '4.2', gpaMax: '4.5' }];
    const sources = buildFillSources({ ...profile, education: entries });
    const ts = [{ id: 'a', section: '학력', rowIndex: 0, label: '구 분' }, { id: 'b', section: '학력', rowIndex: 1, label: '평점 / 만점' }, { id: 'c', section: '학력', rowIndex: 1, label: '기 간' }];
    assert.deepEqual(resolveFillPlan(deterministicFillAssignments(ts, sources), ts, sources).assignments.map(a => a.value), ['학교 A / 대학교', '4.2 / 4.5', '2014-03 ~ 2016-02']);
  });
  test('only completed current-job essays are eligible; personal data never fills essay boxes', () => {
    const essays = buildEssayFillSources([{ question: '지원동기', answer: '저장한 답변', source: 'user_question', status: 'draft' }, { question: '보완', answer: '미완성', source: 'user_question', status: 'needs_info' }, { question: '이전 답변', answer: 'legacy' }]);
    assert.equal(essays.length, 1);
    const targets = [{ id: 'essay', label: '지원동기', type: 'textarea' }, { id: 'family', label: '성명', section: '가족사항' }];
    assert.equal(resolveFillPlan([{ targetId: 'essay', sourceId: 'name' }, { targetId: 'family', sourceId: 'name' }], targets, values).assignments.length, 0);
    assert.equal(resolveFillPlan(deterministicFillAssignments(targets, essays), targets, essays).assignments[0].value, '저장한 답변');
  });
  const planFor = (ts, sources) => resolveFillPlan(deterministicFillAssignments(ts, sources), ts, sources);
  const multiProfile = { ...profile, gender: '남', militaryStatus: '군필',
    education: [{ schoolName: '고교', schoolLevel: '고등학교', schoolLocation: '서울', startDate: '2015-03', endDate: '2018-02', gpa: '', gpaMax: '4.5' },
      { schoolName: '대학', schoolLevel: '대학교', schoolLocation: '경기', major: '소프트웨어', startDate: '2019-03', endDate: '2026-02', gpa: '3.98', gpaMax: '4.5' }],
    workExperiences: [{ companyName: 'A사', startDate: '2025-01', endDate: '2025-08', department: '개발팀', position: '사원', duties: '앱 개발' }, { companyName: 'B사', startDate: '2025-12', endDate: '2026-03' }],
    foreignLanguageSkills: [{ language: '영어', reading: 'advanced', writing: 'intermediate', speaking: 'beginner' }] };
  const multi = buildFillSources(multiProfile);
  test('year/month placeholders are formatted, and a form needing the day is not guessed', () => {
    const ts = [{ id: 'p', label: '재학기간', section: '학력정보', heading: '대학교 학력정보 1', rowIndex: 0, mode: 'replace', placeholder: '년   월 ~     년   월' },
      { id: 'd', label: '입학일', section: '학력정보', heading: '대학교 학력정보 1', rowIndex: 0, mode: 'replace', placeholder: '년 월 일' }];
    const plan = planFor(ts, multi);
    assert.equal(plan.assignments.find((a) => a.targetId === 'p').value, '2019년 03월 ~ 2026년 02월');
    assert.match(plan.skipped.find((x) => x.label.includes('입학일')).reason, /일\(日\)/);
  });
  test('banner headings choose the education row by school level, not by position', () => {
    const ts = [{ id: 'h', label: '학교명', section: '학력정보', heading: '고등학교 학력정보', rowIndex: 0, mode: 'replace', placeholder: '고등학교' },
      { id: 'u1', label: '학교명', section: '학력정보', heading: '대학교 학력정보 1', rowIndex: 0, mode: 'replace', placeholder: '대학교' },
      { id: 'u2', label: '학교명', section: '학력정보', heading: '대학교 학력정보 2', rowIndex: 1, mode: 'replace', placeholder: '대학교' },
      { id: 'loc', label: '소재지', section: '학력정보', heading: '대학교 학력정보 1', rowIndex: 0, mode: 'replace', placeholder: '(시/도 단위로 입력)' }];
    assert.deepEqual(planFor(ts, multi).assignments.map((a) => [a.targetId, a.value]), [['h', '고교'], ['u1', '대학'], ['loc', '경기']]);
  });
  test('choice cells map saved gender, military status and language levels only to real options', () => {
    const ts = [{ id: 'g', label: '성별', type: 'choice', mode: 'choice', options: ['남', '여'] }, { id: 'm', label: '병역여부', type: 'choice', mode: 'choice', options: ['필', '미필', '면제'] },
      { id: 'sp', label: '회화', section: '외국어', rowIndex: 0, type: 'choice', mode: 'choice', options: ['상', '중', '하'] }, { id: 'rd', label: '독해', section: '외국어', rowIndex: 0, type: 'choice', mode: 'choice', options: ['상', '중', '하'] },
      { id: 'v', label: '보훈대상여부', type: 'choice', mode: 'choice', options: ['대상', '비대상'] }];
    assert.deepEqual(planFor(ts, multi).assignments.map((a) => [a.targetId, a.value]), [['g', '남'], ['m', '필'], ['sp', '하'], ['rd', '상']]);
  });
  test('consent boxes are never offered as choices', () => assert.equal(permittedTarget({ id: 'c', label: '항목', type: 'choice', mode: 'choice', options: ['동의', '거부'] }), false));
  test('placeholder essays ("ㅇ") are not written into the form', () => assert.equal(buildEssayFillSources([{ question: '지원동기', answer: 'ㅇ', source: 'user_question', status: 'draft' }]).length, 0));
  test('hobby and specialty share one box when the form has a single 취미/특기 cell', () =>
    assert.equal(planFor([{ id: 'hs', label: '취미/특기' }], buildFillSources({ ...profile, hobbies: '달리기', specialties: '코딩' })).assignments[0].value, '달리기 / 코딩'));
  test('위치 label 한글/영문/한자 map to name fields', () =>
    assert.deepEqual(planFor([{ id: 'k', label: '한글' }, { id: 'e', label: '영문' }], buildFillSources({ ...profile, nameEn: 'HONG GILDONG' })).assignments.map((a) => a.value), ['홍길동', 'HONG GILDONG']));
  const { storeDocumentDownload, documentDownloadResponse } = load('lib/document-download.ts');
  test('Word attachment download retains Korean filename and is scoped to the job', () => {
    const url = storeDocumentDownload('job-a', '입사지원서-작성본.docx', Buffer.from('document-bytes').toString('base64'));
    const token = new URL(url, 'http://localhost').searchParams.get('token');
    const response = documentDownloadResponse('job-a', token);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /^attachment;/);
    assert.ok(response.headers.get('content-disposition').includes(encodeURIComponent('입사지원서-작성본.docx')));
    assert.equal(response.headers.get('content-length'), '14');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(documentDownloadResponse('job-b', token).status, 410);
    assert.equal(documentDownloadResponse('job-a', 'unknown').status, 410);
  });
  const { createFillSession, verifyFillSession } = load('lib/fill-session.ts');
  test('browser token scoped to a job', () => { const token = createFillSession('job-a'); assert.equal(verifyFillSession(token, 'job-a'), true); assert.equal(verifyFillSession(token, 'job-b'), false); assert.equal(verifyFillSession('wrong', 'job-a'), false); });
  console.log(`${passed} tests passed`);
} finally { process.chdir(oldCwd); fs.rmSync(scratch, { recursive: true, force: true }); }
