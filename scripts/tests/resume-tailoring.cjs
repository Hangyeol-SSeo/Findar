const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'findar-tailoring-test-'));
process.chdir(scratch);
const cwd = process.cwd();

const scheduled = [];
let evaluateCalls = 0;
let hasResumeFiles = false;
let release;
const gate = new Promise((resolve) => (release = resolve));
const routeStubs = {
  'next/server': { after: (fn) => scheduled.push(fn) },
  '@/lib/db': { getJobBySeq: (seq) => (seq === 'missing' ? undefined : { seq }) },
  '@/lib/resume-files': { listResumeFiles: () => (hasResumeFiles ? [{ name: 'a.pdf' }] : []) },
  '@/lib/applicant-profile': { readApplicantProfile: () => ({}), isApplicantProfileFilled: () => false },
  '@/lib/resume-tailoring': {
    getCachedTailoring: () => ({ result: null, stale: false }),
    evaluateResumeTailoring: async (_seq, progress) => { evaluateCalls++; await gate; progress(1); progress(2); },
  },
};
const sdkStub = { query() { throw new Error('Live model not permitted in unit test'); } };

const modules = new Map();
function load(relative, stubs = {}) {
  const file = path.resolve(root, relative);
  if (modules.has(file)) return modules.get(file).exports;
  const mod = { exports: {} };
  modules.set(file, mod);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const req = (id) => stubs[id] || (id === '@anthropic-ai/claude-agent-sdk' ? sdkStub
    : id.startsWith('@/') ? load(id.slice(2) + '.ts', stubs)
    : id.startsWith('.') ? load(path.relative(root, path.resolve(path.dirname(file), id + '.ts')), stubs)
    : require(id));
  new Function('require', 'module', 'exports', code)(req, mod, mod.exports);
  return mod.exports;
}
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS', name); }
const PDF = (text) => Buffer.from(`%PDF-1.4\n${text}`);

(async () => {
  // ── legacy resume/ migration: 파일 이동 + 해시 리매핑(재분석/재매칭 없음) ──
  load('lib/db.ts'); // 테이블 생성 — profile.ts 마이그레이션보다 먼저
  const Database = require('better-sqlite3');
  fs.mkdirSync(path.join(cwd, 'resume'));
  fs.writeFileSync(path.join(cwd, 'resume', 'cv.pdf'), PDF('legacy cv'));
  const legacyPath = path.join(cwd, 'resume', 'cv.pdf');
  const st = fs.statSync(legacyPath);
  const legacyHash = crypto.createHash('sha256').update(`${legacyPath}:${st.size}:${st.mtimeMs}\n`).digest('hex');
  fs.writeFileSync(path.join(cwd, 'data', 'profile.json'), JSON.stringify({ sourcesHash: legacyHash, name: '테스트', skills: [], domains: [], projects: [], narrative: '', experienceYears: '신입', generatedAt: 1, model: 'x' }));
  const raw = new Database(path.join(cwd, 'data', 'findar.db'));
  raw.prepare(`INSERT INTO jobs (seq, company, title, date, createdAt, matchProfileHash) VALUES ('1', 'c', 't', '2026-01-01', 1, ?)`).run(legacyHash);

  const profile = load('lib/profile.ts');
  const files = load('lib/resume-files.ts');
  await test('legacy resume moved into data/resume', () => {
    assert.equal(fs.existsSync(legacyPath), false);
    assert.ok(fs.existsSync(path.join(cwd, 'data', 'resume', 'cv.pdf')));
  });
  await test('profile cache and match hashes remapped without re-analysis', () => {
    const newHash = files.hashResumeSources(files.listResumePdfs());
    assert.equal(profile.getProfileStatus().status, 'ready');
    assert.equal(raw.prepare(`SELECT matchProfileHash h FROM jobs WHERE seq='1'`).get().h, newHash);
  });

  // ── 업로드 파일 처리 ──
  await test('file names cannot escape the resume dir', () => {
    assert.equal(files.sanitizeResumeFileName('../../etc/passwd.pdf'), 'passwd.pdf');
    assert.equal(files.sanitizeResumeFileName('C:\\Users\\me\\이력서.PDF'), '이력서.pdf');
    assert.equal(files.sanitizeResumeFileName('.hidden.pdf'), 'hidden.pdf');
    assert.equal(files.sanitizeResumeFileName('a<b>:c.pdf'), 'abc.pdf');
    assert.equal(files.sanitizeResumeFileName(''), 'resume.pdf');
  });
  await test('only real PDFs are accepted', () => {
    assert.throws(() => files.saveResumeFile('fake.pdf', Buffer.from('hello')));
    assert.equal(files.saveResumeFile('포트폴리오.pdf', PDF('p1')), '포트폴리오.pdf');
  });
  await test('content hash: same content re-upload is stable, new content changes it', () => {
    const before = files.hashResumeSources(files.listResumePdfs());
    files.saveResumeFile('포트폴리오.pdf', PDF('p1'));
    assert.equal(files.hashResumeSources(files.listResumePdfs()), before);
    files.saveResumeFile('포트폴리오.pdf', PDF('p2'));
    assert.notEqual(files.hashResumeSources(files.listResumePdfs()), before);
    assert.equal(profile.getProfileStatus().status, 'stale');
  });
  await test('delete only listed files', () => {
    assert.equal(files.deleteResumeFile('../profile.json'), false);
    assert.equal(files.deleteResumeFile('포트폴리오.pdf'), true);
    assert.ok(fs.existsSync(path.join(cwd, 'data', 'profile.json')));
    assert.deepEqual(files.listResumeFiles().map((f) => f.name), ['cv.pdf']);
  });

  // ── 평가 결과 정규화 ──
  const c = load('lib/resume-tailoring-contract.ts');
  const items = [
    { id: 'r1', source: 'resume', section: '경력', title: 'A사 데이터 분석', period: '', detail: '' },
    { id: 'r2', source: 'resume', section: '대외활동', title: '고교 방송부', period: '', detail: '' },
    { id: 'a.work.0', source: 'applicant', section: '경력', title: 'A사', period: '', detail: '' },
    { id: 'r3', source: 'resume', section: '인적사항(선택)', title: '종교', period: '', detail: '' },
  ];
  await test('model output is normalized, never silently drops items', () => {
    const out = c.normalizeTailoring({
      focus: '데이터 기반 리스크 분석',
      evaluations: [
        { itemIds: ['r2', 'nope'], decision: '제외', rewrite: '지워져야 함', label: '방송부' },
        { itemIds: ['r1', 'a.work.0'], decision: '강조', rewrite: '권장 문구', label: 'A사' },
        { itemIds: ['r1'], decision: '유지' },
        { itemIds: ['bogus'], decision: '강조' },
      ],
      sectionOrder: ['경력', 3],
    }, items);
    assert.deepEqual(out.evaluations.map((e) => e.decision), ['강조', '제외', '판단 보류']);
    assert.deepEqual(out.evaluations[0].itemIds, ['r1', 'a.work.0']);
    assert.deepEqual(out.evaluations[1].itemIds, ['r2']);
    assert.equal(out.evaluations[1].rewrite, '');
    assert.deepEqual(out.evaluations[2].itemIds, ['r3']);
    assert.deepEqual(out.sectionOrder, ['경력']);
  });
  await test('unknown decision degrades to 판단 보류', () => {
    const out = c.normalizeTailoring({ evaluations: [{ itemIds: ['r1'], decision: '삭제' }] }, items.slice(0, 1));
    assert.equal(out.evaluations[0].decision, '판단 보류');
  });
  await test('JSON is extracted from fenced or chatty model output', () => {
    assert.equal(c.extractJsonObject('설명\n```json\n{"focus":"x"}\n```').focus, 'x');
    assert.equal(c.extractJsonObject('앞말 {"focus":"y"} 뒷말').focus, 'y');
  });
  await test('applicant items: optional personal fields included, required ones and empty entries excluded', () => {
    const { emptyApplicantProfile } = load('lib/applicant-profile.ts');
    const p = { ...emptyApplicantProfile(), birthDate: '1990-01-01', religion: '기독교',
      certifications: [{ name: '', issuer: 'x', registrationNumber: '', issuedDate: '' }, { name: '정보처리기사', issuer: '산업인력공단', registrationNumber: '', issuedDate: '2020-01' }] };
    const out = c.buildApplicantItems(p);
    assert.deepEqual(out.map((i) => i.id), ['a.cert.1', 'a.religion']);
    assert.ok(!JSON.stringify(out).includes('1990'));
  });

  // ── 평가 API: 백그라운드 작업 + 중복 방지 ──
  const tasks = load('lib/application-tasks.ts', routeStubs);
  const route = load('app/api/applications/[seq]/tailoring/route.ts', routeStubs);
  const post = (seq, origin = 'http://localhost:3000') => route.POST(new Request('http://localhost:3000/api/x', { method: 'POST', headers: { origin } }), { params: Promise.resolve({ seq }) });
  await test('tailoring requires same origin, a job, and some resume data', async () => {
    assert.equal((await post('1', 'https://evil.example')).status, 403);
    assert.equal((await post('missing')).status, 404);
    assert.equal((await post('1')).status, 400);
  });
  await test('tailoring runs as a background task and rejects duplicates per job', async () => {
    hasResumeFiles = true;
    const res = await post('1');
    assert.equal(res.status, 202);
    const { task } = await res.json();
    assert.equal(task.kind, 'tailoring');
    assert.equal((await post('1')).status, 409);
    const run = scheduled.shift()();
    assert.equal(tasks.getApplicationTask('1', task.id).status, 'running');
    release(); await run;
    const done = tasks.getApplicationTask('1', task.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.done, 2);
    assert.equal(evaluateCalls, 1);
  });
  raw.close();
  console.log(`${passed} passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  process.chdir(root);
  fs.rmSync(scratch, { recursive: true, force: true });
});
