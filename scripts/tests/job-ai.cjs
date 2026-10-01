const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'findar-job-ai-test-'));
const oldCwd = process.cwd();
const originalFetch = global.fetch;
const originalTimeout = AbortSignal.timeout;
const envKeys = ['USE_FREERIDE', 'FREERIDE_MODEL', 'FREERIDE_BASE_URL', 'COMPANY_RESEARCH_MODEL'];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const modules = new Map();
const calls = [];
const nativeCalls = [];
const savedJobs = [];
const matches = [];
const job = { seq: 'fixture-1', company: '예시회사', title: '리스크 분석 신입', date: '2026-09-28', applicationPeriod: '2026-09-28~2026-10-31', views: '0', siteUrl: '', attachments: [], content: '리스크 분석 신입. Python 우대. 2026-10-31 마감.' };
const profile = { sourcesHash: 'fixture', generatedAt: 0, model: 'fixture', name: '예시지원자', experienceYears: '신입', skills: ['Python'], domains: ['금융'], projects: [], narrative: '' };
const summaryResult = { seq: job.seq, positionType: '신입', experienceYears: '신입', positions: ['리스크 분석'], jdSummary: '리스크 분석 업무', qualifications: ['Python 우대'], deadline: '2026-10-31' };
const matchResult = { seq: job.seq, matchScore: 85, matchStrengths: ['Python'], matchGaps: [], matchReasoning: '분석 기술 적합' };

function load(relative) {
  const filename = path.resolve(root, relative);
  if (modules.has(filename)) return modules.get(filename).exports;
  const mod = { exports: {} };
  modules.set(filename, mod);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  function req(id) {
    if (id === '@anthropic-ai/claude-agent-sdk') return { async *query(args) {
      nativeCalls.push(args);
      yield { type: 'result', result: '{"native":true}' };
    } };
    if (id === '@/lib/crawler') return { fetchListPage: async () => [job], fetchDetailPage: async () => job };
    if (id === '@/lib/profile') return { ensureProfile: async () => ({ status: 'cached', profile }), getCachedProfile: () => profile };
    if (id === '@/lib/db') return {
      getExistingSeqs: () => new Set(), getActiveJobs: () => savedJobs.map(j => j.summary),
      upsertJob: j => savedJobs.push(j), updateJobMatch: (...args) => matches.push(args),
      getJobsNeedingMatch: () => [], skipLowScoreMatches: () => 0,
    };
    if (id.startsWith('@/')) return load(id.slice(2) + '.ts');
    if (id.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(filename), id + '.ts')));
    return require(id);
  }
  new Function('require', 'module', 'exports', code)(req, mod, mod.exports);
  return mod.exports;
}

function gatewayResponse(text) {
  return Response.json({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });
}

function successfulGateway() {
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    // The installed gateway accepts only user/assistant in messages. No SDK system messages or tools.
    assert.equal(url, 'http://127.0.0.1:11343/v1/messages');
    assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'stream']);
    assert.equal(body.stream, false);
    assert.equal(body.model, 'freeride/coding');
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].role, 'user');
    assert.equal(typeof body.messages[0].content, 'string');
    assert.equal(new Headers(options.headers).has('authorization'), false);
    assert.equal(new Headers(options.headers).has('x-api-key'), false);
    assert.equal(options.signal.aborted, false);
    calls.push(body);
    const prompt = body.messages[0].content;
    const result = prompt.startsWith('지원자') ? matchResult : summaryResult;
    return gatewayResponse(JSON.stringify(prompt.includes('JSON 배열') ? [result] : result));
  };
}

(async () => {
  process.chdir(scratch);
  envKeys.forEach(key => delete process.env[key]);
  process.env.USE_FREERIDE = 'true';
  process.env.FREERIDE_BASE_URL = 'http://127.0.0.1:11343///';
  const { AI_MODEL_IDS } = load('lib/ai-model-types.ts');
  const { readAIModelSettings, writeAIModelSettings } = load('lib/ai-model-settings.ts');
  const { queryJobAI, FreeRideRequestError } = load('lib/job-ai.ts');
  const { summarizeJob, summarizeJobBatch } = load('lib/summarizer.ts');
  const { matchJob, matchJobBatch } = load('lib/matcher.ts');
  successfulGateway();
  const summary = await summarizeJob(job);
  assert.equal(summary.deadline, summaryResult.deadline);
  assert.equal((await summarizeJobBatch([job])).get(job.seq).jdSummary, summaryResult.jdSummary);
  assert.equal((await matchJob(profile, summary)).matchScore, 85);
  assert.equal((await matchJobBatch(profile, [summary])).get(job.seq).matchVerdict, '추천');
  assert.equal(calls.length, 4);
  assert.equal(nativeCalls.length, 0);

  const { GET } = load('app/api/jobs/route.ts');
  const readEvents = async () => {
    const response = await GET(new Request('http://localhost:3000/api/jobs?pages=1&match=true'));
    return (await response.text()).trim().split('\n\n').map(line => JSON.parse(line.slice(6)));
  };
  const events = await readEvents();
  assert.equal(events.some(event => event.type === 'error'), false);
  assert.equal(events.at(-1).type, 'done');
  assert.equal(savedJobs.length, 1);
  assert.equal(savedJobs[0].summarizedOk, true);
  assert.equal(matches[0][1].matchScore, 85);
  assert.equal(nativeCalls.length, 0);

  for (const status of [422, 429, 503]) {
    global.fetch = async () => new Response('fixture provider error', { status });
    await assert.rejects(queryJobAI('summarization', 'fixture'), error => error instanceof FreeRideRequestError && error.message.includes(`HTTP ${status}`));
  }
  const oldError = console.error;
  console.error = () => {};
  try {
    const failureEvents = await readEvents();
    assert.equal(failureEvents.at(-1).type, 'error');
    assert.match(failureEvents.at(-1).message, /FreeRide.*HTTP 503/);
    assert.equal(savedJobs.length, 1, 'failed summaries must not be saved as successful analysis');
  } finally { console.error = oldError; }
  global.fetch = async () => new Response('not JSON');
  await assert.rejects(queryJobAI('summarization', 'fixture'), /응답 형식/);
  for (const body of [null, {}, { content: [{ type: 'tool_use' }] }]) {
    global.fetch = async () => Response.json(body);
    await assert.rejects(queryJobAI('summarization', 'fixture'), /결과를 반환하지/);
  }
  global.fetch = async () => Response.json({ content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens' });
  await assert.rejects(queryJobAI('summarization', 'fixture'), /길이 제한/);
  global.fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(queryJobAI('summarization', 'fixture'), /서버에 연결/);
  AbortSignal.timeout = () => AbortSignal.abort();
  await assert.rejects(queryJobAI('summarization', 'fixture'), /응답 시간이 초과/);
  AbortSignal.timeout = originalTimeout;

  // Changing a web selection must take effect immediately and keep Claude on the native SDK.
  writeAIModelSettings({ ...readAIModelSettings().settings, summarization: AI_MODEL_IDS.SONNET });
  assert.equal(await queryJobAI('summarization', 'fixture'), '{"native":true}');
  assert.equal(nativeCalls.at(-1).options.model, AI_MODEL_IDS.SONNET);
  assert.equal(nativeCalls.at(-1).options.env, undefined);
  successfulGateway();
  await queryJobAI('matching', 'fixture');
  assert.equal(nativeCalls.length, 1);
  console.log('PASS gateway request compatibility, single/batch summary and matching, refresh SSE success/error, failure handling, live model selection, and native Claude routing');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  global.fetch = originalFetch;
  AbortSignal.timeout = originalTimeout;
  process.chdir(oldCwd);
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});
