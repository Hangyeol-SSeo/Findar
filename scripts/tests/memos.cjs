const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'findar-memos-test-'));
const originalCwd = process.cwd();
const modules = new Map();

function load(relative) {
  const filename = path.resolve(root, relative);
  if (modules.has(filename)) return modules.get(filename).exports;
  const mod = { exports: {} };
  modules.set(filename, mod);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  function req(id) {
    if (id.startsWith('@/')) return load(id.slice(2) + '.ts');
    if (id.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(filename), id + '.ts')));
    return require(id);
  }
  new Function('require', 'module', 'exports', code)(req, mod, mod.exports);
  return mod.exports;
}

(async () => {
  process.chdir(scratch);
  const db = load('lib/db.ts');
  const summary = (seq, company) => ({
    seq, company, title: '검증 공고', date: '2026-10-01', applicationPeriod: '', siteUrl: '', attachments: [],
    positionType: '신입', experienceYears: '신입', positions: ['리스크관리'], qualifications: [], jdSummary: '요약', deadline: '2099-12-31',
  });
  db.upsertJob({ summary: summary('100', '(주)가상증권'), rawContent: '본문', summarizedOk: true });
  db.upsertJob({ summary: summary('200', '가상증권 주식회사'), rawContent: '본문', summarizedOk: true });

  const { GET, PUT } = load('app/api/memos/route.ts');
  const put = (body, origin) => PUT(new Request('http://localhost:3000/api/memos', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body),
  }));

  // 공고 메모는 seq별, 회사 메모는 정규화한 회사명으로 같은 회사의 공고끼리 공유된다.
  let res = await put({ scope: 'job', seq: '100', text: '마감 전 졸업증명서 준비' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).memo.text, '마감 전 졸업증명서 준비');
  res = await put({ scope: 'company', company: '(주)가상증권', text: '설명회: 리스크팀 증원' });
  const saved = await res.json();
  assert.equal(saved.key, '가상증권');

  let index = await (await GET()).json();
  assert.deepEqual(Object.keys(index.job), ['100']);
  assert.equal(index.company['가상증권'].displayName, '(주)가상증권');
  assert.equal(db.getMemo('company', '가상증권').text, '설명회: 리스크팀 증원');

  // 다른 표기로 저장해도 같은 회사 메모가 바뀌고, 표시 이름은 마지막 표기를 따른다.
  await put({ scope: 'company', company: '가상증권 주식회사', text: '설명회: 리스크팀 증원\n[2026-10-22] 지인 통화' });
  index = db.getAllMemos();
  assert.equal(Object.keys(index.company).length, 1);
  assert.match(index.company['가상증권'].text, /지인 통화/);

  // 재크롤링(upsertJob)이 메모를 덮지 않는다.
  db.upsertJob({ summary: summary('100', '(주)가상증권'), rawContent: '새 본문', summarizedOk: true });
  assert.equal(db.getMemo('job', '100').text, '마감 전 졸업증명서 준비');

  // 공백뿐인 메모는 지운다.
  res = await put({ scope: 'job', seq: '100', text: '   \n ' });
  assert.equal((await res.json()).memo, null);
  assert.equal(db.getMemo('job', '100'), null);

  // 잘못된 요청은 막는다.
  assert.equal((await put({ scope: 'job', seq: 'missing', text: 'x' })).status, 400, 'unknown seq');
  assert.equal((await put({ scope: 'other', seq: '100', text: 'x' })).status, 400, 'unknown scope');
  assert.equal((await put({ scope: 'company', company: '  ', text: 'x' })).status, 400, 'empty company');
  assert.equal((await put({ scope: 'job', seq: '100', text: 'x'.repeat(20_001) })).status, 400, 'too long');
  assert.equal((await put({ scope: 'job', seq: '100', text: 'x' }, 'https://evil.example')).status, 403, 'cross origin');
  assert.equal(db.getMemo('job', '100'), null);

  console.log('PASS job memos per seq, company memos shared by normalized name, survive recrawl, blank deletes, invalid/cross-origin rejected');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  process.chdir(originalCwd);
  fs.rmSync(scratch, { recursive: true, force: true });
});
