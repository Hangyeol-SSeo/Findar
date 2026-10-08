const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'findar-codex-test-'));
const envKeys = ['FINDAR_CODEX_PATH', 'FINDAR_CODEX_TEST_MODE', 'FINDAR_CODEX_TEST_TRACE', 'OPENAI_API_KEY', 'CODEX_API_KEY'];
const original = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const oldCwd = process.cwd();
const cache = new Map();
let claudeCalls = 0;
let claudeReady;
function load(relative) {
  const file = path.resolve(root, relative);
  if (cache.has(file)) return cache.get(file).exports;
  const mod = { exports: {} }; cache.set(file, mod);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  const req = id => id === '@anthropic-ai/claude-agent-sdk' ? { async *query(input) {
    claudeCalls++;
    if (input.prompt === 'cancel-fixture') {
      claudeReady(input.options.abortController.signal);
      await new Promise((_, reject) => input.options.abortController.signal.addEventListener('abort', () => reject(input.options.abortController.signal.reason), { once: true }));
    }
    assert.ok(!Object.hasOwn(input, 'inputFiles'), 'provider-specific inputs must not reach Claude');
    yield { type: 'result', subtype: 'success', is_error: false, result: 'claude-result' };
  } } : id.startsWith('@/') ? load(id.slice(2) + '.ts')
    : id.startsWith('.') ? load(path.relative(root, path.resolve(path.dirname(file), id + '.ts'))) : require(id);
  new Function('require', 'module', 'exports', code)(req, mod, mod.exports);
  return mod.exports;
}

// Exercise the real subprocess/JSONL transport; the fake executable never performs inference.
const binary = path.join(scratch, 'codex');
const tracePath = path.join(scratch, 'trace.json');
fs.writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), mode = process.env.FINDAR_CODEX_TEST_MODE;
if (args[0] === 'login') {
  console.error(mode === 'api' ? 'Logged in using an API key' : 'Logged in using ChatGPT');
  process.exit(0);
}
let input = '';
process.stdin.on('data', part => input += part);
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.FINDAR_CODEX_TEST_TRACE, JSON.stringify({args, input, cwd: process.cwd(),
    api: process.env.OPENAI_API_KEY, codexApi: process.env.CODEX_API_KEY}));
  const emit = value => console.log(JSON.stringify(value));
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode === 'malformed') { console.log('broken JSON'); return; }
  if (mode === 'shell') emit({type:'item.started',item:{type:'command_execution'}});
  if (mode === 'web' || mode === 'budget') {
    emit({type:'item.started',item:{type:'web_search'}});
    emit({type:'item.completed',item:{type:'web_search'}});
    if (mode === 'budget') emit({type:'item.started',item:{type:'web_search'}});
  }
  const message = JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}});
  process.stdout.write(message.slice(0, 10));
  process.stdout.write(message.slice(10) + '\\n');
  if (mode === 'failure') emit({type:'turn.failed',error:{message:'secret-provider-data'}});
  else if (mode !== 'incomplete') emit({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});
});
`, { mode: 0o700 });

function pdfFile(name, text) {
  const stream = text ? `BT /F1 12 Tf 10 100 Td (${text}) Tj ET` : '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const file = path.join(scratch, name); fs.writeFileSync(file, pdf); return file;
}

(async () => {
  process.env.FINDAR_CODEX_PATH = binary;
  process.env.FINDAR_CODEX_TEST_TRACE = tracePath;
  process.env.OPENAI_API_KEY = 'must-not-be-forwarded';
  process.env.CODEX_API_KEY = 'must-not-be-forwarded';
  const { getCodexConnectionStatus, runCodex } = load('lib/codex-ai.ts');
  const { AI_MODEL_IDS, AI_FEATURES } = load('lib/ai-model-types.ts');
  const { query } = load('lib/ai-query.ts');
  const request = { model: AI_MODEL_IDS.GPT_6_LUNA, prompt: 'a harmless fixture', timeoutMs: 5000 };
  assert.equal((await getCodexConnectionStatus()).authenticated, true);
  assert.equal(await runCodex(request), '{"ok":true}');
  const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
  assert.equal(trace.api, undefined); assert.equal(trace.codexApi, undefined);
  assert.equal(fs.existsSync(trace.cwd), false, 'temporary working directory must be removed');
  assert.ok(trace.args.includes('--ephemeral') && trace.args.includes('read-only') && trace.args.includes('features.shell_tool=false'));
  assert.ok(trace.args.includes('forced_login_method="chatgpt"') && trace.args.includes('web_search="disabled"'));
  process.env.FINDAR_CODEX_TEST_MODE = 'api';
  assert.equal((await getCodexConnectionStatus()).authenticated, false);
  await assert.rejects(runCodex(request), /codex login/);
  for (const [mode, pattern, extra] of [
    ['failure', /실패/, {}], ['incomplete', /완료되지/, {}], ['malformed', /응답 형식/, {}],
    ['shell', /허용되지 않은/, {}], ['web', /웹 도구가 허용되지/, {}],
    ['budget', /조사 예산/, { webSearch: true, webToolLimit: 1 }], ['hang', /초과/, { timeoutMs: 250 }],
  ]) {
    process.env.FINDAR_CODEX_TEST_MODE = mode;
    await assert.rejects(runCodex({ ...request, ...extra }), pattern);
  }
  delete process.env.FINDAR_CODEX_TEST_MODE;
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runCodex({ ...request, signal: controller.signal }), { name: 'AbortError' });
  const file = pdfFile('fixture.pdf', 'All source pages must be read.');
  await runCodex({ ...request, inputFiles: [file] });
  assert.ok(JSON.parse(fs.readFileSync(tracePath, 'utf8')).input.includes('All source pages must be read.'));
  await assert.rejects(runCodex({ ...request, inputFiles: [pdfFile('blank.pdf', '')] }), /텍스트/);
  for (const model of [AI_MODEL_IDS.GPT_6_LUNA, AI_MODEL_IDS.GPT_6_1_SOL, AI_MODEL_IDS.SONNET]) {
    const messages = [];
    for await (const message of query({ prompt: 'fixture', inputFiles: [], options: { model, allowedTools: [] } })) messages.push(message);
    assert.equal(messages.at(-1).result, model === AI_MODEL_IDS.SONNET ? 'claude-result' : '{"ok":true}');
  }
  assert.equal(claudeCalls, 1, 'Codex requests must bypass the Claude SDK');
  const { withAIAbortSignal } = load('lib/ai-operation.ts');
  const claudeAbort = new AbortController();
  const ready = new Promise(resolve => claudeReady = resolve);
  const claudeWork = withAIAbortSignal(claudeAbort.signal, async () => {
    for await (const _message of query({ prompt: 'cancel-fixture', options: { model: AI_MODEL_IDS.SONNET } })) assert.fail('cancelled Claude query must not return output');
  });
  const claudeRejected = assert.rejects(claudeWork, { name: 'AbortError' });
  const modelSignal = await ready;
  claudeAbort.abort(); await claudeRejected;
  assert.equal(modelSignal.aborted, true);
  process.env.FINDAR_CODEX_TEST_MODE = 'hang';
  const codexAbort = new AbortController();
  const codexWork = withAIAbortSignal(codexAbort.signal, async () => {
    for await (const _message of query({ prompt: 'cancel-codex-fixture', options: { model: AI_MODEL_IDS.GPT_6_LUNA } })) assert.fail('cancelled Codex query must not return output');
  });
  const codexRejected = assert.rejects(codexWork, { name: 'AbortError' });
  const deadline = Date.now() + 5000;
  while (!fs.readFileSync(tracePath, 'utf8').includes('cancel-codex-fixture')) {
    assert.ok(Date.now() < deadline, 'Codex subprocess must start');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  codexAbort.abort(); await codexRejected;
  delete process.env.FINDAR_CODEX_TEST_MODE;
  process.chdir(scratch);
  const { readAIModelSettings, writeAIModelSettings, getJobAIConfiguration } = load('lib/ai-model-settings.ts');
  const initial = readAIModelSettings();
  for (const { id } of AI_FEATURES) assert.ok(!initial.options[id].some(option => option.id === AI_MODEL_IDS.LEGACY_GPT_6_SOL));
  const legacySettings = { ...initial.settings, companyResearch: AI_MODEL_IDS.LEGACY_GPT_6_SOL, applicationDraft: AI_MODEL_IDS.LEGACY_GPT_6_SOL };
  fs.mkdirSync(path.join(scratch, 'data'), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'data/ai-model-settings.json'), JSON.stringify(legacySettings));
  assert.deepEqual(readAIModelSettings().settings, { ...legacySettings, companyResearch: AI_MODEL_IDS.GPT_6_1_SOL, applicationDraft: AI_MODEL_IDS.GPT_6_1_SOL });
  for (const model of [AI_MODEL_IDS.GPT_6_LUNA, AI_MODEL_IDS.GPT_6_1_SOL]) {
    for (const { id } of AI_FEATURES) assert.ok(initial.options[id].some(option => option.id === model));
    const selected = { ...initial.settings, ...Object.fromEntries(AI_FEATURES.filter(({ id }) => !['summarization', 'matching'].includes(id)).map(({ id }) => [id, model])) };
    writeAIModelSettings(selected);
    assert.deepEqual(readAIModelSettings().settings, selected);
    writeAIModelSettings({ ...selected, matching: model });
    assert.deepEqual(getJobAIConfiguration('matching'), { provider: 'codex', model });
    assert.equal(await load('lib/job-ai.ts').queryJobAI('matching', 'fixture'), '{"ok":true}');
  }
  const { GET } = load('app/api/settings/codex/route.ts');
  const response = await GET();
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).authenticated, true);
  process.env.FINDAR_CODEX_PATH = path.join(scratch, 'missing');
  assert.equal((await getCodexConnectionStatus()).available, false);
  console.log('PASS subscription-only auth, both model routes, persistent settings, PDF pages, completed-only output, cancellation, timeout, tool restrictions, budget, cleanup, status endpoint, and Claude preservation');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  process.chdir(oldCwd);
  for (const key of envKeys) {
    if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});
