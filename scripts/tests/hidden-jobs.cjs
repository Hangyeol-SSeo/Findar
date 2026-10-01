const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'findar-hidden-jobs-test-'));
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
  const Database = require('better-sqlite3');
  const raw = new Database(path.join(scratch, 'data/findar.db'));
  const insert = raw.prepare(`INSERT INTO jobs
    (seq, company, title, date, applicationPeriod, deadline, hidden, summarizedAt, createdAt)
    VALUES (?, '가상회사', '검증 공고', '2026-10-01', ?, ?, ?, ?, 1)`);
  const today = new Date();
  const todayYmd = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('-');
  insert.run('hidden-future', '', '2099-12-31', 1, 1);
  insert.run('hidden-today', '', todayYmd, 1, 1);
  insert.run('hidden-period', '20260101~20991231', '', 1, 1);
  insert.run('hidden-undated', '20260101~', '', 1, 1);
  insert.run('hidden-expired', '', '2000-01-01', 1, 1);
  insert.run('hidden-period-expired', '20000101~20000102', '', 1, 1);
  insert.run('hidden-unsummarized', '', '2099-12-31', 1, null);
  insert.run('visible-future', '', '2099-12-31', 0, 1);
  raw.prepare(`INSERT INTO applications (seq, status, updatedAt, createdAt) VALUES ('hidden-future', '제출완료', 1, 1)`).run();

  assert.deepEqual(db.getActiveJobs().map(job => job.seq), ['visible-future']);
  const currentHidden = db.getHiddenJobs();
  assert.deepEqual(currentHidden.map(job => job.seq).sort(), ['hidden-future', 'hidden-period', 'hidden-today', 'hidden-undated']);
  assert.equal(currentHidden.find(job => job.seq === 'hidden-future').applicationStatus, '제출완료');
  assert.equal(db.getHiddenSeqs().length, 7, 'expired and unsummarized flags remain stored');

  const { GET, POST } = load('app/api/jobs/hide/route.ts');
  const response = await GET();
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const payload = await response.json();
  assert.deepEqual(payload.jobs.map(job => job.seq).sort(), currentHidden.map(job => job.seq).sort());
  assert.equal(payload.seqs.length, 7, 'old seqs response stays available');

  const request = (seq, hidden) => new Request('http://localhost:3000/api/jobs/hide', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seq, hidden }),
  });
  assert.equal((await POST(request('visible-future', true))).status, 200);
  assert.equal(db.getActiveJobs().length, 0);
  assert.equal(db.getHiddenJobs().length, 5);
  assert.equal((await POST(request('hidden-future', false))).status, 200);
  assert.deepEqual(db.getActiveJobs().map(job => job.seq), ['hidden-future']);
  assert.equal(db.getHiddenJobs().some(job => job.seq === 'hidden-future'), false);
  assert.equal((await POST(request('visible-future', 'invalid'))).status, 400);
  console.log('PASS active hidden jobs load, expired jobs stay out, status join and deadline rules match active list, hide/unhide persists');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  process.chdir(originalCwd);
  fs.rmSync(scratch, { recursive: true, force: true });
});
