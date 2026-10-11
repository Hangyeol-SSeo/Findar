const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
let selectedModel;
let calls = 0, saved = [], existing = [], options, prompt, errorResult = false;
let homepage = null, resultText = '검증된 분석 [공식 자료](https://example.com/report)', homepageFetches = 0, candidates = [];
let siteUrls = [], postings = [], dartOn = false, dartConfidence = 'exact';
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
        getCompanySiteUrls: () => siteUrls,
        getCompanyRecentJobs: (name, limit) => postings.slice(0, limit),
        getCompany: () => undefined, upsertCompanySeen: () => {}, setCompanyDartMatch: () => {},
        saveCompanySection: (...args) => saved.push(args),
      };
      if (id === './company-homepage') return {
        HOMEPAGE_UNVERIFIED: '※ 회사 홈페이지를 확인하지 못했습니다',
        emailDomainUrls: (texts) => texts.flatMap((t) => (t.match(/@([\w.-]+)/) ? [`https://www.${t.match(/@([\w.-]+)/)[1]}/`] : [])),
        findHomepage: async (list) => { homepageFetches++; candidates = list; return homepage; },
      };
      if (id === './ai-model-settings') return { getAIModelId: () => selectedModel };
      if (id === './dart') return {
        isDartConfigured: () => dartOn,
        findCorpCode: async () => ({ corpCode: '0001', confidence: dartConfidence }),
        fetchCompanyOverview: async () => ({ ceoName: '홍길동', address: '서울특별시 영등포구 국제금융로2길 32', homepageUrl: 'www.example-sec.co.kr', establishedDate: '20001107', industryCode: '66' }),
      };
      return load(id.slice(2));
    },
  }, { filename: `lib/${name}.ts` });
  return modules[name] = exports;
}
(async () => {
  const { AI_MODEL_IDS } = load('ai-model-types');
  selectedModel = AI_MODEL_IDS.SONNET;
  const { researchSection, listStaleSections, companyResearchNotice } = load('company-research');
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
  const grounded = { basis: { homepage: 'https://example.com/', dart: false, postings: 1 } };
  existing = [{ sectionType: 'overview', status: 'ok', generatedAt: Date.now(), content: '기존 분석', contentJson: grounded }];
  assert.equal(listStaleSections('fixture', ['overview']).length, 0);
  // 홈페이지·공시·공고 없이 만든 이전 방식의 개요·인재상은 TTL과 상관없이 다시 만든다. 다른 섹션은 그대로다.
  existing = [{ sectionType: 'overview', status: 'ok', generatedAt: Date.now(), content: '옛 분석' }, { sectionType: 'news', status: 'ok', generatedAt: Date.now(), content: '뉴스' }];
  assert.equal(listStaleSections('fixture', ['overview', 'news']).join(), 'overview');
  existing = [{ sectionType: 'overview', status: 'ok', generatedAt: Date.now(), content: '기존 분석', contentJson: grounded }];
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
  // 기본 자료: 홈페이지 후보는 공고 사이트바로가기 → DART 홈페이지 → 지원 이메일 도메인 순. DART(정확 일치)와 최근 공고를 날짜 있는 1차 자료로 넣는다.
  existing = [];
  dartOn = true;
  siteUrls = ['https://www.example-am.co.kr'];
  postings = [{ seq: '42556', title: '[예시증권] 준법감시팀 경력', date: '2026-10-07 09:28:37', applicationPeriod: '', rawContent: '당사는 예시그룹의 일원입니다. 근무지 : 서울특별시 영등포구 국제금융로2길 32 지원: hr@example-sec.co.kr' }];
  homepage = { status: 'ok', url: 'https://www.example-am.co.kr/', title: '예시자산운용', text: '[첫 화면] IPO 투자자문 · 펀드운용 · 투자일임 공모주 펀드를 운용합니다.',
    pages: [{ title: '예시자산운용', url: 'https://www.example-am.co.kr/' }, { title: '회사개요', url: 'https://www.example-am.co.kr/about' }] };
  resultText = '검증된 분석 [공식 자료](https://example.com/report) [홈](https://www.example-am.co.kr/)';
  const withSite = await researchSection('homepage-fixture', 'Fixture', 'overview');
  assert.deepEqual(Array.from(candidates), ['https://www.example-am.co.kr', 'www.example-sec.co.kr', 'https://www.example-sec.co.kr/']);
  assert.ok(prompt.includes('공모주 펀드를 운용합니다'), 'the homepage text must reach the research prompt');
  assert.ok(prompt.includes('[DART 기업개황') && prompt.includes('국제금융로2길 32') && prompt.includes('홍길동'));
  assert.ok(prompt.includes('게시일 2026-10-07') && prompt.includes('view.do?seq=42556'), 'recent postings are dated sources');
  assert.match(prompt, /DART 공시·최근 채용공고\(날짜 있음\) > 회사 홈페이지/);
  assert.match(prompt, /저작권 표기 연도는 갱신 여부의 근거가 아니다/);
  assert.match(prompt, /공고 제목과 게시일을 함께/);
  assert.deepEqual(JSON.parse(JSON.stringify(withSite.sources.slice(0, 4))), [
    { title: '예시자산운용 홈페이지', url: 'https://www.example-am.co.kr/' },
    { title: '홈페이지 — 회사개요', url: 'https://www.example-am.co.kr/about' },
    { title: 'DART 기업개황', url: 'https://dart.fss.or.kr' },
    { title: '공식 자료', url: 'https://example.com/report' },
  ]);
  assert.equal(withSite.status, 'ok');
  // 이름만 비슷한(fuzzy) DART 회사의 주소·홈페이지는 쓰지 않는다.
  dartConfidence = 'fuzzy';
  await researchSection('fuzzy-fixture', 'Fixture', 'overview');
  assert.ok(!prompt.includes('[DART 기업개황') && !Array.from(candidates).includes('www.example-sec.co.kr'));
  dartConfidence = 'exact'; dartOn = false;
  // 홈페이지를 못 읽었고 모델도 확인하지 못했다고 표시하면 partial로 낮춘다.
  homepage = { status: 'unavailable', url: 'https://www.example-am.co.kr/', reason: 'HTTP 503' };
  resultText = '※ 회사 홈페이지를 확인하지 못했습니다\n추정 분석 [협회 공시](https://example.com/disclosure)';
  const unverified = await researchSection('unverified-fixture', 'Fixture', 'culture');
  assert.match(prompt, /회사 홈페이지 미확인.*HTTP 503/);
  assert.equal(unverified.status, 'partial');
  assert.equal(JSON.parse(JSON.stringify(unverified.contentJson)).basis.homepage, null);
  // 이전 방식의 분석은 홈페이지만 못 읽은 새 분석(partial)으로도 바꾼다. 실패(failed)로는 바꾸지 않는다.
  existing = [{ sectionType: 'overview', status: 'ok', generatedAt: Date.now(), content: '옛 분석' }];
  const replaced = await researchSection('ungrounded-fixture', 'Fixture', 'overview');
  assert.equal(replaced.status, 'partial');
  assert.equal(saved.at(-1)[0], 'ungrounded-fixture');
  // 지원 도우미 안내: 없음 / 이전 방식 / 홈페이지 미확인 / 정상
  existing = [];
  assert.match(companyResearchNotice('n'), /아직 없습니다/);
  existing = [{ sectionType: 'overview', status: 'ok', content: '옛 분석' }];
  assert.match(companyResearchNotice('n'), /이전 방식/);
  existing = [{ sectionType: 'overview', status: 'partial', content: '분석', contentJson: { basis: { homepage: null, dart: true, postings: 2 } } }];
  assert.match(companyResearchNotice('n'), /홈페이지를 확인하지 못한/);
  existing = [{ sectionType: 'overview', status: 'ok', content: '분석', contentJson: grounded }, { sectionType: 'news', status: 'ok', content: '뉴스' }];
  assert.equal(companyResearchNotice('n'), null);
  // basis를 남기기 전에 같은 방식으로 만든 분석은 코드가 붙인 출처로 알아본다. 모델이 단 "공식 홈페이지" 출처만으로는 인정하지 않는다.
  existing = [{ sectionType: 'overview', status: 'ok', content: '분석', sources: [{ title: '예시 | 소개 홈페이지', url: 'https://ex.co.kr/' }, { title: 'DART 기업개황', url: 'https://dart.fss.or.kr' }] }];
  assert.equal(companyResearchNotice('n'), null);
  assert.equal(listStaleSections('n', ['overview']).length, 0);
  existing = [{ sectionType: 'overview', status: 'ok', content: '분석', sources: [{ title: '예시증권 공식 홈페이지', url: 'https://ex.co.kr/' }, { title: '딜사이트', url: 'https://d.co.kr' }] }];
  assert.match(companyResearchNotice('n'), /이전 방식/);
  existing = [];
  // 뉴스 섹션은 홈페이지·공고 기본 자료를 쓰지 않는다.
  const fetchesBefore = homepageFetches;
  resultText = '뉴스 분석 [기사](https://example.com/news)';
  await researchSection('news-fixture', 'Fixture', 'news');
  assert.equal(homepageFetches, fetchesBefore);
  assert.ok(!prompt.includes('회사 홈페이지') && !prompt.includes('채용공고 —'), 'news research must not include the basics block');
  console.log('PASS deduplication, tool budgets, TTL, failed refresh preservation, live model selection, model snapshot, Haiku effort compatibility, homepage/DART/posting grounding, old-method sections refreshed, research notice');
})().catch(error => { console.error(error); process.exitCode = 1; });
