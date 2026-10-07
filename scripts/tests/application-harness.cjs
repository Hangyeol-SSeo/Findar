const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

// 맥락 오염(다른 회사 내용, 다른 직무 경험 억지 연결)을 막는 코드 관문.
function compile(file, req) {
  const mod = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('require', 'module', 'exports', code)(req, mod, mod.exports);
  return mod.exports;
}
const normalize = compile('lib/company-normalize.ts', require);
const contract = compile('lib/essay-contract.ts', require);
const plan = compile('lib/essay-plan.ts', require);
const harness = compile('lib/application-harness.ts', (id) => ({ './company-normalize': normalize, './essay-contract': contract, './essay-plan': plan }[id] ?? require(id)));
const cards = compile('lib/experience-cards.ts', (id) => ({
  './essay-contract': contract, './vendor-skills': compile('lib/vendor-skills.ts', require),
  './ai-model-settings': { getAIModelId: () => 'test-model' },
  './essay-bank': { getCachedEssayBank: () => ({ entries: [] }), getEssayBankProgress: () => ({ running: false }) },
  '@anthropic-ai/claude-agent-sdk': { query: () => { throw new Error('no AI in tests'); } },
}[id] ?? require(id)));
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);

// 1) 입력 차단: 이번 지원 회사가 아닌 과거 지원 회사 이름. 같은 회사·포함 관계(이번 회사 이름까지 가려짐)는 뺀다.
same(harness.otherCompanyNames(['(주)가상방산', '테스트증권', '테스트증권 주식회사', '삼성', '', '한국가상은행'], '테스트증권'),
  ['(주)가상방산', '한국가상은행', '가상방산', '삼성'], 'longest first so a longer name is masked before its substring');
same(harness.otherCompanyNames(['삼성'], '삼성증권'), [], 'a recorded name contained in the target must not redact the target');
// 금지 명칭이 되면 기존 검증이 답변에서 거부한다.
assert.ok(contract.containsForbiddenName('가상방산의 국방 사업에 기여하겠습니다.', ['가상방산']));

// 2) 봉쇄: 소재 배치에서 고르지 않은 경험을 근거로 쓰면 거부한다. 공고·회사·요청 자료는 대상이 아니다.
assert.doesNotThrow(() => harness.assertEvidenceContained([{ sourceId: 'card.EXP-01' }, { sourceId: 'job' }, { sourceId: 'company.overview' }, { sourceId: 'user.current.0' }], ['card.EXP-01']));
assert.throws(() => harness.assertEvidenceContained([{ sourceId: 'card.EXP-02' }], ['card.EXP-01']), /고르지 않은 경험\(card\.EXP-02\)/);
assert.throws(() => harness.assertEvidenceContained([{ sourceId: 'resume.experience.0' }], []), /resume\.experience\.0/, 'resume experiences are gated too');
assert.ok(harness.isExperienceSource('memory.episode.abc') && !harness.isExperienceSource('memory.values'));

// 3) 근거 고정: 소재마다 문항·공고 업무/자격요건·요청의 원문 구절(5자 이상)을 대야 한다. 회사명·직무명만으로는 안 된다.
const job = { id: 'job', text: JSON.stringify({ company: '테스트증권', title: '리스크관리 신입', targetRole: '리스크관리', rawContent: '담당 업무: 시장리스크 한도 관리, VaR 산출 보조', qualifications: ['데이터 분석 경험'], positions: ['리스크관리'] }) };
const card = { id: 'card.EXP-01', text: '{"personal_actions":["백엔드 API 성능 개선"]}' };
const request = { id: 'user.current.0', text: '투자 동아리 경험을 넣어 주세요' };
const base = { question: '본인의 강점과 이를 보여주는 경험을 서술하시오.', personalEvidence: 'required', questionTypes: ['experience'] };
const row = (anchor, fit = 'transferable') => ({ materials: [{ question: base.question,
  coverage: [{ requirement: '강점', mandatory: true, status: 'SUFFICIENT', sourceIds: ['card.EXP-01'], rationale: '성능 개선 경험' }],
  selectedMaterials: [{ sourceId: 'card.EXP-01', quote: '백엔드 API 성능 개선', reason: '분석 경험', anchor, fit }], missingInfo: [] }] });
const sources = [job, card, request];
assert.equal(plan.applyMaterials(row({ source: 'job', quote: '시장리스크 한도 관리' }), [base], sources)[0].selectedMaterials[0].fit, 'transferable');
assert.equal(plan.applyMaterials(row({ source: 'question', quote: '본인의 강점' }, 'direct'), [base], sources)[0].selectedMaterials[0].anchor.source, 'question');
assert.equal(plan.applyMaterials(row({ source: 'request', quote: '투자 동아리 경험' }), [base], sources).length, 1);
assert.throws(() => plan.applyMaterials(row({ source: 'job', quote: '리스크관리' }), [base], [job, card]), /원문 구절/, 'role name alone is not an anchor (title/targetRole excluded, positions too short)');
assert.throws(() => plan.applyMaterials(row({ source: 'job', quote: '데이터 기반 의사결정 역량' }), [base], sources), /원문 구절/, 'an invented requirement must be rejected');
assert.throws(() => plan.applyMaterials(row({ source: 'job', quote: '테스트증권' }), [base], [job, card]), /원문 구절/, 'company name is not a duty');
assert.throws(() => plan.applyMaterials(row(undefined), [base], sources), /anchor/);
assert.throws(() => plan.applyMaterials(row({ source: 'job', quote: '시장리스크 한도 관리' }, 'distant'), [base], sources), /direct 또는 transferable/);

// 3-1) 필수 요소가 막힌 경우에만 보완 질문이 작성을 멈춘다. 근거가 다 있으면 질문은 보강 제안으로 돌린다.
const withQuestions = (status, mandatory) => ({ materials: [{ question: base.question,
  coverage: [{ requirement: '강점', mandatory: true, status: 'SUFFICIENT', sourceIds: ['card.EXP-01'], rationale: '근거 있음' }, { requirement: '검증 절차', mandatory, status, sourceIds: [], rationale: '자료에 없음' }],
  selectedMaterials: [{ sourceId: 'card.EXP-01', quote: '백엔드 API 성능 개선', reason: '분석', anchor: { source: 'question', quote: '본인의 강점' }, fit: 'direct' }], missingInfo: ['검증은 어떻게 했나요?'] }] });
const optionalGap = plan.applyMaterials(withQuestions('MISSING', false), [base], sources)[0];
same([optionalGap.missingInfo, optionalGap.followUps], [[], ['검증은 어떻게 했나요?']], 'an optional gap must not block drafting');
const mandatoryGap = plan.applyMaterials(withQuestions('MISSING', true), [base], sources)[0];
same([mandatoryGap.missingInfo, mandatoryGap.followUps], [['검증은 어떻게 했나요?'], []]);
assert.throws(() => plan.applyMaterials({ materials: [{ ...withQuestions('MISSING', true).materials[0], missingInfo: [] }] }, [base], sources), /필수 요소/);
assert.throws(() => plan.applyMaterials(withQuestions('NOT_APPLICABLE', true), [base], sources), /숨기지/);
assert.throws(() => plan.applyMaterials({ materials: [{ ...withQuestions('MISSING', false).materials[0], coverage: [{ requirement: 'x', status: 'SUFFICIENT', sourceIds: ['card.EXP-01'], rationale: 'y' }] }] }, [base], sources), /mandatory/);

// 4) 출처: 카드가 원래 어느 회사·직무 지원서에서 나왔는지 코드가 근거 항목에서 붙인다(모델 출력을 믿지 않는다).
const entries = [
  { id: 'e1', source: 'imported', kind: 'cover_letter', sourceFile: 'cover_letter/a.txt', company: '가상방산', context: '임베디드 SW 개발 직무', question: '지원 동기', answer: '방산 장비의 통신 모듈을 개발했습니다.', createdAt: 1 },
  { id: 'e2', source: 'saved', company: '테스트증권', question: '강점', answer: '동아리에서 손실 원인을 분석했습니다.', createdAt: 2 },
];
const { cards: built } = cards.validateCards({ cards: [
  { event_id: 'a', context: '통신 모듈 개발', personal_actions: ['통신 모듈 개발'], evidence: [{ entryId: 'e1', quote: '방산 장비의 통신 모듈을 개발했습니다.' }], origins: [{ company: '모델이 지어낸 회사' }] },
  { event_id: 'b', context: '동아리', personal_actions: ['손실 원인 분석'], evidence: [{ entryId: 'e2', quote: '동아리에서 손실 원인을 분석했습니다.' }] },
] }, entries);
same(built[0].origins, [{ company: '가상방산', context: '임베디드 SW 개발 직무', question: '지원 동기', kind: 'cover_letter' }], 'origins come from source entries, not the model');
same(built[1].evidence[0].kind, 'final', '"자료로 저장"한 답변도 카드의 근거가 된다');
const sameAsTarget = (c) => normalize.normalizeCompanyName(c) === normalize.normalizeCompanyName('테스트증권');
assert.ok(cards.describeOrigins(built[0], sameAsTarget)[0].startsWith('다른 회사(가상방산) · 자기소개서 · 임베디드 SW 개발 직무'));
assert.ok(cards.describeOrigins(built[1], sameAsTarget)[0].startsWith('같은 회사(테스트증권) · Findar에서 확정한 답변'));
assert.ok(cards.cardSourceContent(built[0], sameAsTarget).writtenFor[0].includes('다른 회사'));

// 5) 독립 검증 결과: 답변에 그대로 있는 문장만 인정하고, 정해진 종류만 받는다.
const answer = '저는 통신 모듈을 개발하며 국방 보안의 중요성을 배웠습니다. 그래서 시장리스크 한도 관리를 맡고 싶습니다.';
const issues = harness.parseContextAudit({ issues: [
  { sentence: '통신 모듈을 개발하며 국방 보안의 중요성을 배웠습니다.', type: 'other_company', reason: '방산 지원서의 맥락' },
  { sentence: '답변에 없는 문장입니다.', type: 'other_role', reason: '지어낸 지적' },
  { sentence: '그래서 시장리스크 한도 관리를 맡고 싶습니다.', type: 'nonsense', reason: '종류 오류' },
  { sentence: '통신 모듈을 개발하며 국방 보안의 중요성을 배웠습니다.', type: 'other_company', reason: '중복' },
] }, answer);
same(issues.map((i) => i.type), ['other_company']);
assert.ok(harness.contextIssueNotes(issues)[0].startsWith('직무·회사 맥락 확인(다른 회사 맥락)'));
const prompt = harness.contextAuditPrompt({ company: '테스트증권', role: '리스크관리', jobText: job.text, question: base.question, answer, otherCompanies: ['가상방산'], materialOrigins: ['다른 회사(가상방산) · 자기소개서'] });
assert.ok(prompt.includes('독립된 검토자') && prompt.includes('가상방산') && prompt.includes('stretched_link'));
const err = new harness.ContextAuditError(issues, { answer });
assert.equal(err.answer.answer, answer);

console.log('PASS other-company blocking, evidence containment, verbatim job/question/request anchors (role/company names rejected), code-attached card provenance incl. saved answers, independent audit findings must quote the answer');
