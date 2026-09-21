const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const modules = new Map();
const scheduled = [];
const drafts = new Map();
let release;
const gate = new Promise(resolve => release = resolve);
const stubs = {
  'next/server': { after: fn => scheduled.push(fn) },
  '@/lib/db': { getJobBySeq: seq => ({ seq }) },
  '@/lib/application-draft': {
    getCachedApplicationDraft: seq => drafts.get(seq) ?? null,
    generateCustomEssayAnswer: async (_seq, input, signal) => {
      assert.equal(signal, undefined, 'work must not depend on client AbortSignal');
      await gate;
      if (input.question === 'fail') throw new Error('fixture failure');
      return { ...input, answer: 'stored answer', status: 'draft' };
    },
    persistEssay: (seq, answer) => { const draft = { essayAnswers: [...(drafts.get(seq)?.essayAnswers ?? []), answer] }; drafts.set(seq, draft); return draft; },
  },
};
function load(relative) {
  const file = path.resolve(root, relative);
  if (modules.has(file)) return modules.get(file).exports;
  const mod = { exports: {} }; modules.set(file, mod);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const req = id => stubs[id] || (id.startsWith('@/') ? load(id.slice(2) + '.ts') : id.startsWith('.') ? load(path.relative(root, path.resolve(path.dirname(file), id + '.ts'))) : require(id));
  new Function('require', 'module', 'exports', code)(req, mod, mod.exports);
  return mod.exports;
}
(async () => {
  const tasks = load('lib/application-tasks.ts');
  const route = load('app/api/applications/[seq]/draft/question/route.ts');
  const abort = new AbortController();
  const post = (seq, questions, signal) => route.POST(new Request('http://localhost:3000/api/test', { method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify({ questions: questions.map(question => ({ question })) }), signal }), { params: Promise.resolve({ seq }) });
  const response = await post('a', ['first', 'second'], abort.signal);
  assert.equal(response.status, 202);
  const first = (await response.json()).task;
  abort.abort();
  assert.equal((await post('a', ['duplicate'])).status, 400);
  assert.equal((await post('b', ['parallel'])).status, 202);
  const doc = tasks.createApplicationTask('a', 'document');
  const documentWork = tasks.executeApplicationTask(doc.id, async () => { await gate; return { document: { filename: 'result.docx' } }; });
  const running = scheduled.splice(0).map(fn => fn());
  assert.equal(tasks.getApplicationTask('a', first.id).status, 'running');
  assert.equal(tasks.getApplicationTask('a', doc.id).status, 'running');
  assert.equal(tasks.listApplicationTasks('b')[0].status, 'running');
  assert.equal(tasks.getApplicationTask('b', first.id), undefined);
  release(); await Promise.all([...running, documentWork]);
  assert.equal(tasks.getApplicationTask('a', first.id).done, 2);
  assert.equal(tasks.getApplicationTask('a', first.id).status, 'completed');
  assert.deepEqual(drafts.get('a').essayAnswers.map(a => a.question), ['first', 'second']);
  assert.equal(tasks.getApplicationTask('a', doc.id).result.document.filename, 'result.docx');
  assert.equal((await post('a', ['retained', 'fail'])).status, 202);
  await scheduled.shift()();
  const failed = tasks.listApplicationTasks('a').find(t => t.status === 'failed');
  assert.equal(failed.done, 1); assert.equal(failed.error, 'fixture failure');
  assert.equal(drafts.get('a').essayAnswers.at(-1).question, 'retained');
  console.log('PASS client disconnect, sequential batch, same-job duplicate rejection, concurrent companies/document, scoped polling, partial failure retention');
})().catch(error => { console.error(error); process.exitCode = 1; });
