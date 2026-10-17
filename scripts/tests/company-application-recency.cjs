const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'findar-company-recency-test-'));
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

const DAY = 86_400_000;
const now = new Date('2026-10-16T12:00:00+09:00').getTime();

// 기간 경계
const recency = load('lib/company-application-recency.ts');
assert.equal(recency.recentApplicationTier(now - 10 * DAY, now), '1개월');
assert.equal(recency.recentApplicationTier(now - 45 * DAY, now), '3개월');
assert.equal(recency.recentApplicationTier(now - 120 * DAY, now), '6개월');
assert.equal(recency.recentApplicationTier(now - 200 * DAY, now), null);
assert.equal(recency.recentApplicationTier(now + DAY, now), null);
const oneMonthAgo = new Date(now);
oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
assert.equal(recency.recentApplicationTier(oneMonthAgo.getTime(), now), '1개월', 'boundary is inclusive');
assert.equal(recency.recentApplicationTier(oneMonthAgo.getTime() - 1, now), '3개월');

// 회사명 정규화로 묶고, 지원 전 상태·6개월 초과·자기 자신은 뺀다.
const index = recency.indexRecentCompanyApplications([
  { seq: 'a1', company: '(주)가상증권', title: 'IB 신입', applicationStatus: '제출완료', appliedAt: now - 70 * DAY },
  { seq: 'a2', company: '가상증권', title: '리서치 신입', applicationStatus: '서류합격', appliedAt: now - 5 * DAY },
  { seq: 'a3', company: '가상 증권 주식회사', title: '오래된 지원', applicationStatus: '불합격', appliedAt: now - 300 * DAY },
  { seq: 'a4', company: '가상증권', title: '작성중 공고', applicationStatus: '작성중', appliedAt: null },
  { seq: 'a5', company: '가상증권', title: '되돌린 공고', applicationStatus: '미지원', appliedAt: now - DAY },
  { seq: 'b1', company: '다른자산운용', title: '운용 경력', applicationStatus: '면접', appliedAt: now - 150 * DAY },
], now);
assert.deepEqual([...index.keys()].sort(), ['가상증권', '다른자산운용']);
assert.deepEqual(index.get('가상증권').map(a => a.seq), ['a2', 'a1'], 'latest first');

const other = recency.recentCompanyApplications(index, { seq: 'new', company: '가상증권㈜' }, now);
assert.equal(other.tier, '1개월');
assert.deepEqual(other.applications.map(a => a.seq), ['a2', 'a1']);

// 자기 자신을 빼면 남은 가장 최근 지원으로 기간이 정해진다.
const self = recency.recentCompanyApplications(index, { seq: 'a2', company: '가상증권' }, now);
assert.equal(self.tier, '3개월');
assert.deepEqual(self.applications.map(a => a.seq), ['a1']);
assert.equal(recency.recentCompanyApplications(index, { seq: 'b1', company: '다른자산운용' }, now), null);
assert.equal(recency.recentCompanyApplications(index, { seq: 'x', company: '다른자산운용' }, now).tier, '6개월');
assert.equal(recency.recentCompanyApplications(index, { seq: 'x', company: '없는회사' }, now), null);

// 지원 시각: submittedAt → 처음 지원 이후 단계가 된 이력 → 마지막 변경 시각. 지원 전이면 null.
const status = load('lib/application-status.ts');
assert.equal(status.applicationAppliedAt({ status: '면접', submittedAt: 100, history: [], updatedAt: 900 }), 100);
assert.equal(status.applicationAppliedAt({
  status: '면접', submittedAt: null,
  history: [{ status: '작성중', at: 10 }, { status: '서류합격', at: 20 }, { status: '면접', at: 30 }],
  updatedAt: 30,
}), 20);
assert.equal(status.applicationAppliedAt({ status: '불합격', submittedAt: null, history: [], updatedAt: 50 }), 50);
assert.equal(status.applicationAppliedAt({ status: '작성중', submittedAt: 100, history: [], updatedAt: 900 }), null);

// 지원 현황 조회가 appliedAt을 싣는다.
process.chdir(scratch);
const db = load('lib/db.ts');
const Database = require('better-sqlite3');
const raw = new Database(path.join(scratch, 'data/findar.db'));
const insertJob = raw.prepare(`INSERT INTO jobs (seq, company, title, date, deadline, summarizedAt, createdAt)
  VALUES (?, '가상증권', ?, '2026-10-01', '2000-01-01', 1, 1)`);
insertJob.run('j1', '제출한 공고');
insertJob.run('j2', '바로 서류합격');
insertJob.run('j3', '작성중 공고');
db.upsertApplicationStatus('j1', '제출완료');
raw.prepare(`INSERT INTO applications (seq, status, history, updatedAt, createdAt) VALUES ('j2', '서류합격', ?, 40, 1)`)
  .run(JSON.stringify([{ status: '검토중', at: 10 }, { status: '서류합격', at: 30 }]));
db.upsertApplicationStatus('j3', '작성중');

const tracked = Object.fromEntries(db.getTrackedApplicationJobs().map(job => [job.seq, job]));
assert.equal(tracked.j1.appliedAt, tracked.j1.submittedAt);
assert.ok(tracked.j1.appliedAt > 0);
assert.equal(tracked.j2.appliedAt, 30);
assert.equal(tracked.j3.appliedAt, null);
assert.equal(tracked.j1.expired, true, 'expired applications still count');

console.log('company-application-recency ok');

// 작성중인 회사: 작성중만, 마감 지난 것·자기 자신은 빼고, 마감 가까운 순.
const drafting = recency.indexDraftingCompanyApplications([
  { seq: 'd1', company: '(주)가상증권', title: '마감 미정', deadline: '', applicationStatus: '작성중' },
  { seq: 'd2', company: '가상증권', title: '곧 마감', deadline: '2026-10-20', applicationStatus: '작성중' },
  { seq: 'd3', company: '가상증권', title: '마감 지남', deadline: '2026-10-01', applicationStatus: '작성중', expired: true },
  { seq: 'd4', company: '가상증권', title: '검토중', deadline: '2026-10-30', applicationStatus: '검토중' },
  { seq: 'd5', company: '가상증권', title: '제출함', deadline: '2026-10-30', applicationStatus: '제출완료' },
]);
assert.deepEqual(recency.draftingCompanyApplications(drafting, { seq: 'x', company: '가상증권 주식회사' }).map(a => a.seq), ['d2', 'd1']);
assert.deepEqual(recency.draftingCompanyApplications(drafting, { seq: 'd2', company: '가상증권' }).map(a => a.seq), ['d1']);
assert.deepEqual(recency.draftingCompanyApplications(drafting, { seq: 'x', company: '없는회사' }), []);
console.log('drafting companies ok');
