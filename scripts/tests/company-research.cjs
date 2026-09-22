const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
let calls = 0, saved = [], existing = [], options, errorResult = false;
const modules = {};
function load(name) {
  if (modules[name]) return modules[name];
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(`lib/${name}.ts`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, process: { env: {} }, console: { info() {}, error() {} },
    require(id) {
      if (id === '@anthropic-ai/claude-agent-sdk') return { query: async function* (args) {
        calls++; options = args.options;
        await new Promise(resolve => setTimeout(resolve, 5));
        yield { type: 'result', subtype: errorResult ? 'error_max_turns' : 'success', is_error: errorResult,
          result: '검증된 분석 [공식 자료](https://example.com/report)', modelUsage: {}, num_turns: 5, total_cost_usd: 0 };
      } };
      if (id === './db') return {
        getCompanySections: () => existing,
        saveCompanySection: (...args) => saved.push(args),
      };
      if (id === './dart') return { isDartConfigured: () => false };
      return load(id.slice(2));
    },
  }, { filename: `lib/${name}.ts` });
  return modules[name] = exports;
}
(async () => {
  const { researchSection, listStaleSections } = load('company-research');
  await Promise.all([researchSection('fixture', 'Fixture', 'overview'), researchSection('fixture', 'Fixture', 'overview')]);
  assert.equal(calls, 1); assert.equal(saved.length, 1);
  assert.equal(options.effort, 'medium'); assert.equal(options.maxTurns, 18);
  assert.deepEqual(Array.from(options.tools), ['WebSearch', 'WebFetch']);
  const hook = options.hooks.PreToolUse[0].hooks[0];
  for (let i = 0; i < 3; i++) assert.equal((await hook({ hook_event_name: 'PreToolUse', tool_name: 'WebSearch' })).hookSpecificOutput, undefined);
  assert.equal((await hook({ hook_event_name: 'PreToolUse', tool_name: 'WebSearch' })).hookSpecificOutput.permissionDecision, 'deny');
  for (let i = 0; i < 5; i++) {
    const result = await hook({ hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url: 'https://example.com', prompt: '매출 확인' } });
    assert.equal(result.hookSpecificOutput.updatedInput.url, 'https://example.com');
    assert.match(result.hookSpecificOutput.updatedInput.prompt, /1500자/);
  }
  assert.equal((await hook({ hook_event_name: 'PreToolUse', tool_name: 'WebFetch' })).hookSpecificOutput.permissionDecision, 'deny');
  existing = [{ sectionType: 'overview', status: 'ok', generatedAt: Date.now(), content: '기존 분석' }];
  assert.equal(listStaleSections('fixture', ['overview']).length, 0);
  assert.equal(listStaleSections('fixture', ['overview', 'overview'], true).length, 1);
  errorResult = true;
  await assert.rejects(researchSection('fixture', 'Fixture', 'overview'), /기존 분석/);
  assert.equal(saved.length, 1);
  existing = [];
  assert.equal((await researchSection('fixture', 'Fixture', 'overview')).status, 'failed');
  errorResult = false;
  assert.equal((await researchSection('fixture', 'Fixture', 'overview')).status, 'ok');
  existing = [{ sectionType: 'overview', status: 'partial', generatedAt: Date.now() }];
  assert.equal(listStaleSections('fixture', ['overview']).length, 1);
  console.log('PASS deduplication, tool budgets, compact fetch, TTL, failed refresh preservation, retry after failure');
})().catch(error => { console.error(error); process.exitCode = 1; });
