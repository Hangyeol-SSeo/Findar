const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'findar-role-'));
process.chdir(scratch);
const modules = new Map();
let prompt;
let onQuery = () => {};
const stubs = {
  './ai-model-settings': { getAIModelId: () => 'fixture' },
  './applicant-profile': { readApplicantProfile: () => ({ updatedAt: 1, workExperiences: [], education: [], activities: [], awards: [], certifications: [], languageTests: [], foreignLanguageSkills: [], research: [], skillsNote: '', specialties: '', hobbies: '', religion: '', projects: [] }) },
  './profile': { readCareerGoals: () => '' },
  './resume-inventory': { currentResumeHash: () => 'resume', ensureResumeInventory: async () => ({ items: [{ id: 'r1', source: 'resume', section: '경험', title: '분석', period: '', detail: '자료를 비교했습니다.' }] }) },
  '@anthropic-ai/claude-agent-sdk': { async *query(args) { prompt = args.prompt; onQuery(); yield { type: 'result', subtype: 'success', result: JSON.stringify({ focus: '분석', summary: '검토', evaluations: [], sectionOrder: [], watchouts: [] }) }; } },
};
function load(relative) {
  const file = path.resolve(root, relative);
  if (modules.has(file)) return modules.get(file).exports;
  const mod = { exports: {} }; modules.set(file, mod);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  new Function('require', 'module', 'exports', code)(id => stubs[id] || (id.startsWith('@/') ? load(id.slice(2) + '.ts') : id.startsWith('.') ? load(path.relative(root, path.resolve(path.dirname(file), id + '.ts'))) : require(id)), mod, mod.exports);
  return mod.exports;
}
(async () => {
  const db = load('lib/db.ts');
  const Database = require('better-sqlite3');
  const raw = new Database(path.join(scratch, 'data/findar.db'));
  raw.prepare("INSERT INTO jobs(seq,company,title,date,positions,rawContent,createdAt) VALUES ('a','테스트','공채','2026-10-03',?, ?,1)").run(JSON.stringify(['리스크관리', 'IB']), '공통 안내'.repeat(1000) + '리스크관리: 리스크 분석');
  const role = load('lib/application-role.ts');
  assert.throws(() => role.requireApplicationRole('a'), /지원 직무/);
  const first = db.saveApplicationRole('a', '리스크관리', '');
  assert.equal(role.requireApplicationRole('a').role, '리스크관리');
  assert.equal(db.getApplicationRole('b').role, '');
  assert.throws(() => db.saveApplicationRole('a', 'IB', ''), /다른 창/);
  const tailoring = load('lib/resume-tailoring.ts');
  await tailoring.evaluateResumeTailoring('a');
  assert.ok(prompt.includes('"지원직무":"리스크관리"'));
  assert.ok(prompt.includes('리스크관리: 리스크 분석'));
  assert.equal(tailoring.getCachedTailoring('a').stale, false);
  const second = db.saveApplicationRole('a', 'IB', first.revision);
  assert.equal(tailoring.getCachedTailoring('a').stale, true);
  assert.throws(() => role.assertApplicationRole('a', first.revision), /변경/);
  const before = db.getResumeTailoringRow('a').resultJson;
  onQuery = () => db.saveApplicationRole('a', '리스크관리', second.revision);
  await assert.rejects(() => tailoring.evaluateResumeTailoring('a'), /변경/);
  assert.equal(db.getResumeTailoringRow('a').resultJson, before);
  const route = load('app/api/applications/[seq]/role/route.ts');
  const params = { params: Promise.resolve({ seq: 'a' }) };
  const req = (body, origin = 'http://localhost:3000') => new Request('http://localhost:3000/api/applications/a/role', { method: 'PUT', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await route.PUT(req({ role: 'IB', revision: '' }, 'https://evil.test'), params)).status, 403);
  assert.equal((await route.PUT(req({ role: '', revision: '' }), params)).status, 400);
  const current = db.getApplicationRole('a');
  const tasks = load('lib/application-tasks.ts');
  const task = tasks.createApplicationTask('a', 'writing');
  assert.equal((await route.PUT(req({ role: 'IB', revision: current.revision }), params)).status, 409);
  await tasks.executeApplicationTask(task.id, async () => ({}));
  assert.equal((await route.PUT(req({ role: 'IB', revision: current.revision }), params)).status, 200);
  assert.equal((await route.GET(new Request('http://localhost:3000'), params)).status, 200);
  assert.equal((await route.PUT(req({ role: '분석', revision: current.revision }), params)).status, 409);
  raw.close();
  console.log('PASS role persistence/isolation, missing selection, conflict, active-task lock, prompt scope, untruncated role details, cache invalidation, changed-role save guard');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { process.chdir(root); fs.rmSync(scratch, { recursive: true, force: true }); });
