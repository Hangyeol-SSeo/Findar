const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'findar-ai-model-test-'));
const oldCwd = process.cwd();
const envKeys = ['USE_FREERIDE', 'FREERIDE_MODEL', 'FREERIDE_BASE_URL', 'COMPANY_RESEARCH_MODEL'];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const modules = new Map();
const calls = [];
const gatewayCalls = [];
const originalFetch = global.fetch;
global.fetch = async (url, options) => {
  gatewayCalls.push({ url, options, body: JSON.parse(options.body) });
  return Response.json({ content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn' });
};

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
      calls.push(args.options);
      yield { type: 'result', subtype: 'success', result: '{}', is_error: false };
    } };
    if (id.startsWith('@/')) return load(id.slice(2) + '.ts');
    if (id.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(filename), id + '.ts')));
    return require(id);
  }
  new Function('require', 'module', 'exports', code)(req, mod, mod.exports);
  return mod.exports;
}

(async () => {
  process.chdir(scratch);
  envKeys.forEach(key => delete process.env[key]);
  const { AI_FEATURES } = load('lib/ai-model-types.ts');
  const { readAIModelSettings, writeAIModelSettings, getAIModelId, getJobAIConfiguration } = load('lib/ai-model-settings.ts');
  const file = path.join(scratch, 'data/ai-model-settings.json');
  const initial = readAIModelSettings();
  assert.equal(initial.settings.summarization, 'claude-haiku-4-5-20251001');
  assert.equal(initial.settings.companyResearch, 'claude-sonnet-5');
  assert.equal(fs.existsSync(file), false, 'reading defaults must not create persistent settings');
  process.env.USE_FREERIDE = 'true';
  process.env.FREERIDE_BASE_URL = 'http://127.0.0.1:11343';
  const current = readAIModelSettings();
  assert.equal(current.settings.summarization, 'freeride/coding');
  assert.equal(current.settings.matching, 'freeride/coding');
  for (const { id } of AI_FEATURES) {
    assert.equal(current.options[id].some(option => option.id.startsWith('freeride/')), ['summarization', 'matching'].includes(id));
  }
  assert.deepEqual(getJobAIConfiguration('matching'), { provider: 'freeride', model: 'freeride/coding', baseURL: process.env.FREERIDE_BASE_URL });

  const selected = { ...current.settings, summarization: 'claude-sonnet-5', applicationDraft: 'claude-opus-5-5' };
  writeAIModelSettings(selected);
  assert.equal(getAIModelId('applicationDraft'), 'claude-opus-5-5');
  assert.equal(getJobAIConfiguration('summarization').provider, 'claude', 'Claude selection must bypass the FreeRide gateway');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), selected);
  const saved = fs.readFileSync(file, 'utf8');
  for (const invalid of [null, [], {}, { ...selected, extra: 'x' }, { ...selected, profile: 'freeride/coding' }, { ...selected, companyResearch: 'freeride/coding' }, { ...selected, matching: 'unsupported' }]) {
    assert.throws(() => writeAIModelSettings(invalid));
    assert.equal(fs.readFileSync(file, 'utf8'), saved, 'invalid settings must leave the saved selection intact');
  }
  writeAIModelSettings({ ...selected, applicationDraft: 'claude-sonnet-4-6' });
  assert.equal(getAIModelId('applicationDraft'), 'claude-sonnet-4-6', 'updates must apply without reloading the module');
  const { GET, PUT } = load('app/api/settings/models/route.ts');
  assert.equal((await GET()).headers.get('cache-control'), 'no-store');
  const request = (body, origin = 'http://localhost:3000') => new Request('http://localhost:3000/api/settings/models', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', origin }, body,
  });
  assert.equal((await PUT(request(JSON.stringify(selected), 'https://example.com'))).status, 403);
  assert.equal((await PUT(request('{'))).status, 400);
  assert.equal((await PUT(request(JSON.stringify({ ...selected, profile: 'freeride/coding' })))).status, 400);
  const response = await PUT(request(JSON.stringify(selected)));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).settings, selected);

  const { summarizeJob } = load('lib/summarizer.ts');
  const { matchJob } = load('lib/matcher.ts');
  const job = { seq: 'fixture', company: '예시', title: '분석', content: '공개 채용 조건', positions: [], qualifications: [] };
  const profile = { name: 'fixture', experienceYears: '신입', skills: [], domains: [], projects: [], transferableStrengths: [], narrative: '', careerGoals: '' };
  await summarizeJob(job);
  assert.equal(calls.at(-1).model, 'claude-sonnet-5');
  assert.equal(calls.at(-1).env, undefined);
  await matchJob(profile, job);
  assert.equal(calls.length, 1, 'FreeRide must bypass the Claude Agent SDK');
  assert.equal(gatewayCalls.at(-1).body.model, 'freeride/coding');
  assert.equal(gatewayCalls.at(-1).url, process.env.FREERIDE_BASE_URL + '/v1/messages');

  fs.writeFileSync(file, '{broken');
  assert.equal(readAIModelSettings().settings.matching, 'freeride/coding');
  console.log('PASS environment defaults, persisted live selection, provider routing, feature restrictions, invalid-write preservation, API validation, and summary/matching callers');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  process.chdir(oldCwd);
  global.fetch = originalFetch;
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});
