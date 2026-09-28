const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const prompts = [];
let queued = [];
const plan = { question: '성장과정', researchMode: 'perspective', research: [{ sourceId: 'company.overview', quote: '검증 절차를 중시합니다.', purpose: '판단 기준을 검토합니다.', paragraph: 1 }], notes: [], intent: '선택과 변화', message: '판단 기준의 변화', outline: ['선택', '행동', '변화'], materialCriteria: ['판단의 근거'] };
const answer = { status: 'draft', intent: plan.intent, answer: '판단의 이유를 기록했습니다.', evidence: [{ sourceId: 'user.current.0', quote: '판단의 이유를 기록했습니다.', usedFor: '행동' }], missingInfo: [], reviewNotes: [] };
const stubs = {
  './ai-model-settings': { getAIModelId: () => 'claude-sonnet-5' },
  '@anthropic-ai/claude-agent-sdk': { async *query({ prompt }) { prompts.push(prompt); yield { type: 'result', subtype: 'success', result: JSON.stringify(queued.length ? queued.shift() : prompts.length === 1 ? { plans: [plan] } : prompts.length === 2 ? { materials: [{ question: plan.question, selectedMaterials: [{ sourceId: 'user.current.0', quote: answer.answer, reason: '판단 과정이 드러납니다.' }], missingInfo: [] }] } : answer) }; } },
  './db': { getJobBySeq: () => ({ company: '예시 회사', title: '분석', positions: ['분석'], qualifications: ['판단력'] }), getCompanySections: () => [{ sectionType: 'overview', content: '검증 절차를 중시합니다.', sources: [{ title: '공식 자료', url: 'https://example.com/research' }], generatedAt: 1234, status: 'ok' }], getApplicationDraftRow: () => null },
  './profile': { getCachedProfile: () => null },
  './applicant-profile': { readApplicantProfile: () => ({ education: [], projects: [], activities: [], awards: [], workExperiences: [] }) },
  './narrative-profile': { readNarrativeProfile: () => ({ core: '', episodes: [] }) },
  './essay-bank': { ensureEssayBank: async () => ({ entries: [] }) },
  './company-normalize': { normalizeCompanyName: x => x },
};
function compile(file, req) {
  const mod = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('require', 'module', 'exports', code)(req, mod, mod.exports);
  return mod.exports;
}
stubs['./application-skills'] = compile('lib/application-skills.ts', require);
stubs['./essay-plan'] = compile('lib/essay-plan.ts', require);
stubs['./essay-contract'] = compile('lib/essay-contract.ts', require);
const { generateCustomEssayAnswer, prepareEssayBatch } = compile('lib/application-draft.ts', id => stubs[id] || require(id));
(async () => {
  const result = await generateCustomEssayAnswer('test', { question: '성장과정', countSpaces: true, guidance: '판단의 이유를 기록했습니다.' });
  assert.equal(prompts.length, 4);
  assert.ok(!prompts[0].includes('user.current'));
  assert.ok(!prompts[0].includes('판단의 이유를 기록했습니다.'));
  assert.ok(prompts[1].includes('selectedMaterials'));
  assert.ok(prompts[2].includes(plan.message));
  assert.ok(prompts[1].includes('user.current'));
  assert.ok(prompts[3].includes('반말 종결'));
  assert.equal(result.plan.selectedMaterials.length, 1);
  assert.equal(result.researchSources[0].links[0].url, 'https://example.com/research');
  assert.equal(result.researchSources[0].generatedAt, 1234);
  assert.ok(result.plan.skillVersion);
  const validators = stubs['./essay-plan'];
  const sources = result.researchSources;
  assert.throws(() => validators.validatePlans({ plans: [] }, [plan.question], sources, 'test'), /문항 수/);
  assert.throws(() => validators.validatePlans({ plans: [{ ...plan, research: [{ ...plan.research[0], quote: '없는 원문' }] }] }, [plan.question], sources, 'test'), /근거/);
  assert.throws(() => validators.applyMaterials({ materials: [{ question: plan.question, selectedMaterials: [{ sourceId: 'company.overview', quote: sources[0].text, reason: '경험' }], missingInfo: [] }] }, [result.plan], sources), /경험/);
  assert.equal(result.answer, answer.answer);
  const secondPlan = { ...plan, question: '지원동기', researchMode: 'direct' };
  queued = [{ plans: [secondPlan, plan] }, { materials: [
    { question: plan.question, selectedMaterials: [{ sourceId: 'user.current.0', quote: answer.answer, reason: '변화 과정입니다.' }], missingInfo: [] },
    { question: secondPlan.question, selectedMaterials: [{ sourceId: 'user.current.1', quote: '업무 기준을 비교했습니다.', reason: '지원 기준입니다.' }], missingInfo: [] },
  ] }];
  const requests = [
    { question: plan.question, countSpaces: true, guidance: answer.answer },
    { question: secondPlan.question, countSpaces: true, guidance: '업무 기준을 비교했습니다.' },
  ];
  const before = prompts.length;
  const prepared = await prepareEssayBatch('test', requests);
  assert.deepEqual(prepared.plans.map(p => p.question), requests.map(r => r.question));
  assert.equal(prompts.length - before, 2);
  assert.equal(prepared.plans[1].selectedMaterials[0].sourceId, 'user.current.1');
  // A direct research plan cannot silently disappear in the final answer.
  queued = [answer, answer, { ...answer, evidence: [...answer.evidence, { sourceId: 'company.overview', quote: plan.research[0].quote, usedFor: '회사 선택의 이유' }] }];
  const direct = await generateCustomEssayAnswer('test', requests[1], undefined, prepared);
  assert.equal(direct.plan.researchMode, 'direct');
  assert.ok(prompts.at(-1).includes('회사 근거'));
  assert.equal(queued.length, 0);
  const incomplete = { ...prepared, plans: prepared.plans.map(p => ({ ...p, missingInfo: ['본인이 선택한 행동을 알려주세요.'] })) };
  const beforeMissing = prompts.length;
  const missing = await generateCustomEssayAnswer('test', requests[0], undefined, incomplete);
  assert.equal(missing.status, 'needs_info');
  assert.equal(prompts.length, beforeMissing);
  assert.ok(missing.plan);
  console.log('PASS plan before personal history, planned drafting, editorial review, grounded result');
})().catch(error => { console.error(error); process.exitCode = 1; });
