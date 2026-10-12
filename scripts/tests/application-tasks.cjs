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
  '@/lib/application-role': { requireApplicationRole: () => ({ role: '분석', revision: '1' }) },
  'next/server': { after: fn => scheduled.push(fn) },
  '@/lib/db': { getJobBySeq: seq => ({ seq }) },
  '@/lib/essay-log': { logEssayEvent: () => {}, logEssayEvents: () => {}, newEssayThread: () => 'thread' },
  '@/lib/essay-revision': { findEssayAnswer: (seq, question) => ({ question, answer: 'stored answer' }) },
  // 첨삭 작업: 서버가 소유한 작업으로 돈다. 저장·취소 의미는 작업 저장소가 보장한다.
  '@/lib/essay-review': {
    reviewEssay: async (seq, question, focus, signal) => {
      assert.ok(signal instanceof AbortSignal, 'work has a server-owned AbortSignal');
      assert.equal(signal.aborted, false, 'client disconnect does not cancel server work');
      await gate;
      if (question === 'hold') await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      signal.throwIfAborted();
      if (question === 'fail') throw new Error('fixture failure');
      const draft = { essayAnswers: [...(drafts.get(seq)?.essayAnswers ?? []), { question, answer: 'stored answer', feedback: { focus } }] };
      drafts.set(seq, draft);
      return { draft, outcome: 'feedback' };
    },
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
  const route = load('app/api/applications/[seq]/draft/review/route.ts');
  const abort = new AbortController();
  const post = (seq, question, signal) => route.POST(new Request('http://localhost:3000/api/test', { method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify({ question, focus: '' }), signal }), { params: Promise.resolve({ seq }) });
  const response = await post('a', 'first', abort.signal);
  assert.equal(response.status, 202);
  const first = (await response.json()).task;
  abort.abort();
  assert.equal((await post('a', 'duplicate')).status, 400, 'one review per job at a time');
  assert.equal((await post('b', 'parallel')).status, 202);
  const doc = tasks.createApplicationTask('a', 'document');
  const documentWork = tasks.executeApplicationTask(doc.id, async () => { await gate; return { document: { filename: 'result.docx' } }; });
  const running = scheduled.splice(0).map(fn => fn());
  assert.equal(tasks.getApplicationTask('a', first.id).status, 'running');
  assert.equal(tasks.getApplicationTask('a', doc.id).status, 'running');
  assert.equal(tasks.listApplicationTasks('b')[0].status, 'running');
  assert.equal(tasks.getApplicationTask('b', first.id), undefined);
  release(); await Promise.all([...running, documentWork]);
  assert.equal(tasks.getApplicationTask('a', first.id).status, 'completed');
  assert.equal(tasks.getApplicationTask('a', first.id).result.outcome, 'feedback');
  assert.equal(tasks.getApplicationTask('a', doc.id).result.document.filename, 'result.docx');
  assert.equal((await post('a', 'fail')).status, 202);
  await scheduled.shift()();
  const failed = tasks.listApplicationTasks('a').find(t => t.status === 'failed');
  assert.match(failed.error, /fixture failure/);
  assert.equal(failed.question, 'fail', 'failed review points at its answer');
  const bad = await route.POST(new Request('http://localhost:3000/api/test', { method: 'POST', headers: { origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{}' }), { params: Promise.resolve({ seq: 'a' }) });
  assert.equal(bad.status, 403);
  const cancelRoute = load('app/api/applications/[seq]/tasks/route.ts');
  const cancel = (seq, id, origin = 'http://localhost:3000') => cancelRoute.DELETE(new Request(`http://localhost:3000/api/test?id=${id}`, { method: 'DELETE', headers: { origin } }), { params: Promise.resolve({ seq }) });
  const queuedResponse = await post('c', 'never');
  const queuedTask = (await queuedResponse.json()).task;
  assert.equal((await cancel('other', queuedTask.id)).status, 404);
  assert.equal((await cancel('c', queuedTask.id, 'https://other.example')).status, 403);
  assert.equal((await cancel('c', queuedTask.id)).status, 200);
  await scheduled.shift()();
  assert.equal(tasks.getApplicationTask('c', queuedTask.id).status, 'cancelled');
  assert.equal(drafts.has('c'), false);
  const heldResponse = await post('d', 'hold');
  const held = (await heldResponse.json()).task;
  const heldWork = scheduled.shift()();
  while (tasks.getApplicationTask('d', held.id).status !== 'running') await new Promise(resolve => setImmediate(resolve));
  assert.equal((await cancel('d', held.id)).status, 200);
  await heldWork;
  assert.equal(tasks.getApplicationTask('d', held.id).status, 'cancelled');
  assert.equal(drafts.has('d'), false, 'a cancelled review saves nothing');
  assert.equal((await cancel('d', held.id)).status, 200, 'repeated cancellation is idempotent');
  assert.equal((await post('d', 'new-work')).status, 202, 'cancelled task releases the job lock');
  await scheduled.shift()();
  const { withAIAbortSignal, getAIAbortSignal, createSharedAIWork, waitForAIWork } = load('lib/ai-operation.ts');
  const firstConsumer = new AbortController(), secondConsumer = new AbortController();
  let sharedSignal, finishShared;
  const shared = createSharedAIWork(() => {
    sharedSignal = getAIAbortSignal();
    return new Promise(resolve => finishShared = resolve);
  });
  const firstWait = withAIAbortSignal(firstConsumer.signal, () => waitForAIWork(shared));
  const secondWait = withAIAbortSignal(secondConsumer.signal, () => waitForAIWork(shared));
  const cancelledWait = assert.rejects(firstWait, { name: 'AbortError' });
  await new Promise(resolve => setImmediate(resolve));
  firstConsumer.abort(); await cancelledWait;
  assert.equal(sharedSignal.aborted, false, 'another consumer keeps shared extraction alive');
  finishShared('retained'); assert.equal(await secondWait, 'retained');
  const onlyConsumer = new AbortController();
  const alone = createSharedAIWork(() => { const signal = getAIAbortSignal(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); });
  const aloneWait = withAIAbortSignal(onlyConsumer.signal, () => waitForAIWork(alone));
  const aloneRejected = assert.rejects(aloneWait, { name: 'AbortError' });
  const sourceRejected = assert.rejects(alone.promise, { name: 'AbortError' });
  await new Promise(resolve => setImmediate(resolve));
  onlyConsumer.abort(); await Promise.all([aloneRejected, sourceRejected]);
  assert.equal(alone.controller.signal.aborted, true, 'last cancelled consumer aborts the model');
  const late = tasks.createApplicationTask('late', 'revision');
  let finishLate;
  const lateWork = tasks.executeApplicationTask(late.id, () => new Promise(resolve => finishLate = resolve));
  tasks.cancelApplicationTask('late', late.id);
  assert.equal(tasks.getApplicationTask('late', late.id).status, 'cancelling');
  assert.throws(() => tasks.createApplicationTask('late', 'revision'), /이미 진행 중/, 'hold lock until cleanup completes');
  finishLate({ outcome: 'feedback' }); await lateWork;
  assert.equal(tasks.getApplicationTask('late', late.id).status, 'cancelled');
  assert.equal(tasks.getApplicationTask('late', late.id).result, undefined, 'late provider results are discarded');
  console.log('PASS queued/running cancellation, scope/origin isolation, no later writes, restart; client disconnect, same-job duplicate rejection, concurrent companies/document, scoped polling, failure reporting');
})().catch(error => { console.error(error); process.exitCode = 1; });
