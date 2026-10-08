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
  '@/lib/application-draft': {
    getCachedApplicationDraft: seq => drafts.get(seq) ?? null,
    materialsLogDetail: () => ({}),
    draftRepairReason: () => null,
    prepareEssayBatch: async (_seq, inputs) => ({ plans: inputs }),
    generateCustomEssayAnswer: async (_seq, input, signal) => {
      assert.ok(signal instanceof AbortSignal, 'work has a server-owned AbortSignal');
      assert.equal(signal.aborted, false, 'client disconnect does not cancel server work');
      await gate;
      if (input.question === 'hold') await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      signal.throwIfAborted();
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
  assert.equal((await post('a', ['retained', 'fail', 'after-failure'])).status, 202);
  await scheduled.shift()();
  const failed = tasks.listApplicationTasks('a').find(t => t.status === 'failed');
  assert.equal(failed.done, 2); assert.match(failed.error, /3개 중 2개/); assert.match(failed.error, /문항 2: fixture failure/);
  assert.equal(drafts.get('a').essayAnswers.at(-1).question, 'after-failure');
  assert.equal((await post('a', ['same', 'same'])).status, 400);
  const cancelRoute = load('app/api/applications/[seq]/tasks/route.ts');
  const cancel = (seq, id, origin = 'http://localhost:3000') => cancelRoute.DELETE(new Request(`http://localhost:3000/api/test?id=${id}`, { method: 'DELETE', headers: { origin } }), { params: Promise.resolve({ seq }) });
  const queuedResponse = await post('c', ['never']);
  const queuedTask = (await queuedResponse.json()).task;
  assert.equal((await cancel('other', queuedTask.id)).status, 404);
  assert.equal((await cancel('c', queuedTask.id, 'https://other.example')).status, 403);
  assert.equal((await cancel('c', queuedTask.id)).status, 200);
  await scheduled.shift()();
  assert.equal(tasks.getApplicationTask('c', queuedTask.id).status, 'cancelled');
  assert.equal(drafts.has('c'), false);
  const batchResponse = await post('d', ['saved-first', 'hold', 'never-after']);
  const batch = (await batchResponse.json()).task;
  const batchWork = scheduled.shift()();
  while (tasks.getApplicationTask('d', batch.id).done !== 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await cancel('d', batch.id)).status, 200);
  await batchWork;
  assert.equal(tasks.getApplicationTask('d', batch.id).status, 'cancelled');
  assert.deepEqual(drafts.get('d').essayAnswers.map(a => a.question), ['saved-first']);
  assert.equal((await cancel('d', batch.id)).status, 200, 'repeated cancellation is idempotent');
  assert.equal((await post('d', ['new-work'])).status, 202, 'cancelled task releases the job lock');
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
  const late = tasks.createApplicationTask('late', 'writing');
  let finishLate;
  const lateWork = tasks.executeApplicationTask(late.id, () => new Promise(resolve => finishLate = resolve));
  tasks.cancelApplicationTask('late', late.id);
  assert.equal(tasks.getApplicationTask('late', late.id).status, 'cancelling');
  assert.throws(() => tasks.createApplicationTask('late', 'writing'), /이미 진행 중/, 'hold lock until cleanup completes');
  finishLate({ needsInfo: 9 }); await lateWork;
  assert.equal(tasks.getApplicationTask('late', late.id).status, 'cancelled');
  assert.equal(tasks.getApplicationTask('late', late.id).result, undefined, 'late provider results are discarded');
  console.log('PASS queued/running cancellation, scope/origin isolation, partial answer retention, no later writes, restart; client disconnect, sequential batch, same-job duplicate rejection, concurrent companies/document, scoped polling, partial failure retention');
})().catch(error => { console.error(error); process.exitCode = 1; });
