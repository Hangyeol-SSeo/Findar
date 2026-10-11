const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
let selectedModel;
let calls = 0, saved = [], existing = [], options, prompt, errorResult = false;
let homepage = null, resultText = '검증된 분석 [공식 자료](https://example.com/report)', homepageFetches = 0;
const modules = {};
function load(name) {
  if (modules[name]) return modules[name];
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(`lib/${name}.ts`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, process: { env: {} }, console: { info() {}, error() {} },
    require(id) {
      if (id === './ai-query') return { query: async function* (args) {
        calls++; options = args.options; prompt = args.prompt;
        await new Promise(resolve => setTimeout(resolve, 5));
        yield { type: 'result', subtype: errorResult ? 'error_max_turns' : 'success', is_error: errorResult,
          result: resultText, modelUsage: {}, num_turns: 5, total_cost_usd: 0 };
      } };
      if (id === './db') return {
        getCompanySections: () => existing,
        getCompanySiteUrls: () => (homepage ? [homepage.url] : []),
        saveCompanySection: (...args) => saved.push(args),
      };
      if (id === './company-homepage') return {
        HOMEPAGE_UNVERIFIED: '※ 회사 홈페이지를 확인하지 못했습니다',
        pickHomepageUrl: (urls) => urls[0] ?? null,
        fetchHomepage: async () => { homepageFetches++; return homepage; },
      };
      if (id === './ai-model-settings') return { getAIModelId: () => selectedModel };
      if (id === './dart') return { isDartConfigured: () => false };
      return load(id.slice(2));
    },
  }, { filename: `lib/${name}.ts` });
  return modules[name] = exports;
}
(async () => {
  const { AI_MODEL_IDS } = load('ai-model-types');
  selectedModel = AI_MODEL_IDS.SONNET;
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
  existing = [];
  selectedModel = AI_MODEL_IDS.HAIKU;
  const pending = researchSection('model-fixture', 'Fixture', 'overview');
  selectedModel = AI_MODEL_IDS.SONNET;
  const result = await pending;
  assert.equal(result.model, AI_MODEL_IDS.HAIKU, 'an operation must retain its selected model');
  assert.equal(options.effort, undefined, 'Haiku does not support effort');
  assert.equal(saved.at(-1)[2].model, result.model);
  existing = [{ ...result, generatedAt: Date.now() }];
  assert.equal(listStaleSections('model-fixture', ['overview']).length, 1, 'a new model must permit refreshing fresh cached research');
  selectedModel = result.model;
  assert.equal(listStaleSections('model-fixture', ['overview']).length, 0);
  selectedModel = AI_MODEL_IDS.SONNET_4_6;
  const updated = await researchSection('other-fixture', 'Fixture', 'overview');
  assert.equal(updated.model, selectedModel);
  assert.equal(options.effort, 'medium');
  // 회사 홈페이지: 서버가 읽은 원문을 1차 근거로 넣고 출처 맨 앞에 둔다.
  existing = [];
  homepage = { status: 'ok', url: 'https://www.example-am.co.kr/', title: '예시자산운용', text: 'IPO 투자자문 · 펀드운용 · 투자일임 공모주 펀드를 운용합니다.' };
  const withSite = await researchSection('homepage-fixture', 'Fixture', 'overview');
  assert.match(prompt, /회사 홈페이지 원문 — https:\/\/www\.example-am\.co\.kr\//);
  assert.ok(prompt.includes('공모주 펀드를 운용합니다'), 'the homepage text must reach the research prompt');
  assert.match(prompt, /공고 제목과 게시일을 함께/, 'quoted job postings must carry their title and date');
  assert.deepEqual(JSON.parse(JSON.stringify(withSite.sources[0])), { title: '예시자산운용 홈페이지', url: 'https://www.example-am.co.kr/' });
  assert.equal(withSite.status, 'ok');
  // 홈페이지를 못 읽었고 모델도 확인하지 못했다고 표시하면 partial로 낮춘다.
  homepage = { status: 'unavailable', url: 'https://www.example-am.co.kr/', reason: 'HTTP 503' };
  resultText = '※ 회사 홈페이지를 확인하지 못했습니다\n추정 분석 [협회 공시](https://example.com/disclosure)';
  const unverified = await researchSection('unverified-fixture', 'Fixture', 'culture');
  assert.match(prompt, /회사 홈페이지 미확인.*HTTP 503/);
  assert.equal(unverified.status, 'partial');
  // 뉴스 섹션은 홈페이지를 읽지 않는다.
  const fetchesBefore = homepageFetches;
  resultText = '뉴스 분석 [기사](https://example.com/news)';
  await researchSection('news-fixture', 'Fixture', 'news');
  assert.equal(homepageFetches, fetchesBefore);
  assert.ok(!prompt.includes('회사 홈페이지'), 'news research must not include the homepage block');
  console.log('PASS deduplication, tool budgets, TTL, failed refresh preservation, live model selection, model snapshot, Haiku effort compatibility, homepage grounding');
})().catch(error => { console.error(error); process.exitCode = 1; });
