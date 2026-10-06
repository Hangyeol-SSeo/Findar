const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const prompts = [];
let queued = [];
const plan = { questionTypes: ['experience'], personalEvidence: 'required', question: '성장과정', researchMode: 'perspective', research: [{ sourceId: 'company.overview', quote: '검증 절차를 중시합니다.', purpose: '판단 기준을 검토합니다.', paragraph: 1 }], notes: [], intent: '선택과 변화', message: '판단 기준의 변화', outline: ['선택', '행동', '변화'], materialCriteria: ['판단의 근거'] };
const answer = { status: 'draft', intent: plan.intent, answer: '판단의 이유를 기록했습니다.', evidence: [{ sourceId: 'user.current.0', quote: '판단의 이유를 기록했습니다.', usedFor: '행동' }], missingInfo: [], reviewNotes: [] };
const stubs = {
  './application-role': { requireApplicationRole: () => ({ role: '리스크관리', revision: 'role-v1' }), assertApplicationRole: () => {}, APPLICATION_ROLE_RULES: '지원 직무를 기준으로 작성' },
  './ai-model-settings': { getAIModelId: () => 'fixture-model' },
  '@anthropic-ai/claude-agent-sdk': { async *query({ prompt, options }) { assert.equal(options.maxTurns, 3); assert.deepEqual(options.tools, []); assert.deepEqual(options.allowedTools, []); prompts.push(prompt); yield { type: 'result', subtype: 'success', result: JSON.stringify(queued.length ? queued.shift() : prompts.length === 1 ? { plans: [plan] } : prompts.length === 2 ? { materials: [{ question: plan.question, selectedMaterials: [{ sourceId: 'user.current.0', quote: answer.answer, reason: '판단 과정이 드러납니다.' }], missingInfo: [] }] } : answer) }; } },
  './db': { getJobBySeq: () => ({ company: '예시 회사', title: '분석', positions: ['분석'], qualifications: ['판단력'] }), getCompanySections: () => [{ sectionType: 'overview', content: '검증 절차를 중시합니다.', sources: [{ title: '공식 자료', url: 'https://example.com/research' }], generatedAt: 1234, status: 'ok' }], getApplicationDraftRow: () => null },
  './profile': { getCachedProfile: () => null },
  './applicant-profile': { readApplicantProfile: () => ({ education: [], projects: [], activities: [], awards: [], workExperiences: [] }) },
  './narrative-profile': { readNarrativeProfile: () => ({ core: '', episodes: [] }) },
  './essay-bank': { ensureEssayBank: async () => ({ entries: [] }), summarizeEditPreferences: () => '' },
  './company-normalize': { normalizeCompanyName: x => x },
  './essay-log': { logEssayEvent: () => {}, logEssayEvents: () => {}, newEssayThread: () => 'thread' },
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
stubs['./essay-diff'] = compile('lib/essay-diff.ts', require);
stubs['./essay-style'] = compile('lib/essay-style.ts', id => stubs[id] || require(id));
const { generateCustomEssayAnswer, prepareEssayBatch } = compile('lib/application-draft.ts', id => stubs[id] || require(id));
(async () => {
  const result = await generateCustomEssayAnswer('test', { question: '성장과정', countSpaces: true, guidance: '판단의 이유를 기록했습니다.' });
  assert.equal(prompts.length, 4);
  assert.ok(prompts[0].includes('리스크관리'));
  assert.equal(result.targetRole, '리스크관리');
  assert.equal(result.roleRevision, 'role-v1');
  assert.ok(!prompts[0].includes('user.current'));
  assert.ok(!prompts[0].includes('판단의 이유를 기록했습니다.'));
  assert.ok(prompts[1].includes('selectedMaterials'));
  assert.ok(prompts[1].includes('[지원 직무] 리스크관리'));
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
  for (const types of [['opinion'], ['freeform'], ['motivation'], ['experience', 'opinion']]) {
    const required = types.includes('experience') || types.includes('motivation');
    const candidate = { ...plan, questionTypes: types, personalEvidence: required ? 'required' : 'optional', researchMode: 'none', research: [], notes: ['회사 사실을 직접 쓰지 않습니다.'] };
    const [validated] = validators.validatePlans({ plans: [candidate] }, [plan.question], [], 'test');
    const empty = { materials: [{ question: plan.question, selectedMaterials: [], missingInfo: [] }] };
    if (required) assert.throws(() => validators.applyMaterials(empty, [validated], []), /경험/);
    else assert.equal(validators.applyMaterials(empty, [validated], [])[0].missingInfo.length, 0);
  }
  const opinion = { ...plan, question: '금융 기술 혁신에 대한 견해', questionTypes: ['opinion'], personalEvidence: 'optional', researchMode: 'none', research: [], notes: ['구체적 최신 사실 없이 논증합니다.'] };
  const reasoning = { ...answer, evidence: [], answer: '자동화 이후에도 판단의 책임을 명확히 해야 한다고 생각합니다.' };
  queued = [{ plans: [opinion] }, { materials: [{ question: opinion.question, selectedMaterials: [], missingInfo: [] }] }, reasoning, reasoning, { verdict: 'pass', issues: ['조건부 분석이므로 허용됩니다.'], suggestions: ['다른 관점과의 비교도 검토할 수 있습니다.'] }];
  const opinionAnswer = await generateCustomEssayAnswer('test', { question: opinion.question, countSpaces: true, guidance: '' });
  assert.equal(opinionAnswer.status, 'draft');
  assert.ok(prompts.at(-1).includes('독립된 엄격한 사실·논증 검토자'));
  assert.deepEqual(opinionAnswer.evidence, []);
  assert.ok(opinionAnswer.reviewNotes.includes('조건부 분석이므로 허용됩니다.'));
  assert.ok(opinionAnswer.reviewNotes.includes('다른 관점과의 비교도 검토할 수 있습니다.'));
  assert.equal(queued.length, 0);
  queued = [reasoning, reasoning, { verdict: 'revise', issues: ['근거 없이 현황을 단정했습니다.'] }, reasoning, { verdict: 'revise', issues: ['수정 후에도 근거가 없습니다.'] }];
  const opinionBatch = { ...prepared, plans: [{ ...opinion, selectedMaterials: [], missingInfo: [] }], contexts: [prepared.contexts[0]] };
  const ungrounded = await generateCustomEssayAnswer('test', { question: opinion.question, countSpaces: true, guidance: '' }, undefined, opinionBatch);
  assert.equal(ungrounded.status, 'needs_info');
  assert.equal(ungrounded.answer, '');
  assert.ok(ungrounded.missingInfo[0].includes('근거 자료'));
  assert.ok(ungrounded.reviewNotes.some(n => n.includes('수정 후에도 근거가 없습니다.')));
  assert.equal(queued.length, 0);
  assert.throws(() => stubs['./essay-contract'].validateEssay(reasoning, requests[0], [], []), /근거/);
  assert.throws(() => stubs['./essay-contract'].validateEssay({ ...reasoning, answer: '수익이 30% 증가했습니다.' }, requests[0], [], [], true), /수치/);
  assert.throws(() => validators.validatePlans({ plans: [{ ...plan, research: [{ ...plan.research[0], paragraph: '1' }] }] }, [plan.question], sources, 'test'), /문단 번호/);
  console.log('PASS plan before personal history, planned drafting, editorial review, grounded result');
})().catch(error => { console.error(error); process.exitCode = 1; });
