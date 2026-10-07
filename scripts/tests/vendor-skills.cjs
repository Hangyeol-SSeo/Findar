const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

// 외부 스킬(skills/vendor) 연결: 원문 절 추출, 원본 검사 스크립트 실행, 경험 카드 검증, 소재 배치의 요구-근거 규칙.
function compile(file, req) {
  const mod = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('require', 'module', 'exports', code)(req, mod, mod.exports);
  return mod.exports;
}
const contract = compile('lib/essay-contract.ts', require);
const vendor = compile('lib/vendor-skills.ts', require);
const checks = compile('lib/vendor-checks.ts', require);
const plan = compile('lib/essay-plan.ts', require);
const cards = compile('lib/experience-cards.ts', (id) => ({
  './essay-contract': contract, './vendor-skills': vendor,
  './ai-model-settings': { getAIModelId: () => 'test-model' },
  './essay-bank': { getCachedEssayBank: () => ({ entries: [] }), getEssayBankProgress: () => ({ running: false }) },
  '@anthropic-ai/claude-agent-sdk': { query: () => { throw new Error('no AI in tests'); } },
}[id] ?? require(id)));
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);

// 1) 원문 절 추출: 코드 블록 안의 "## Q-01"은 heading이 아니고, 같은 수준의 다음 heading에서 끝난다.
const md = '# T\n## A\nfirst\n```\n## Q-01 inside fence\n```\nstill A\n### A-1\nsub\n## B\nsecond';
assert.equal(vendor.markdownSection(md, '## A'), '## A\nfirst\n```\n## Q-01 inside fence\n```\nstill A\n### A-1\nsub');
assert.throws(() => vendor.markdownSection(md, '## 없음'), /찾지 못했습니다/);
const skills = vendor.loadVendorSkills();
assert.ok(skills.cards.includes('personal_actions') && skills.cards.includes('유도 질문 금지'), 'card skill must carry the original schema and rules');
assert.ok(skills.materials.includes('WEAKLY_SUPPORTED') && skills.materials.includes('문항 유형과 소재 배분'));
assert.ok(skills.write.includes('## 사실·의사·해석') && !skills.write.includes('## claim 계약'), 'write skill excludes the claim-map file contract');
assert.ok(skills.review.includes('THIN') && skills.review.includes('[외부 스킬 원문을 Findar에서 읽는 법]'));

// 2) 원본 검사 스크립트를 그대로 실행한다.
const style = checks.jasoseoStyleFindings('저는 끊임없이 노력했고 많은 것을 배웠습니다. 그 결과 팀이 성장할 수 있었습니다.');
assert.ok(style.some((n) => n.startsWith('[상투어]')), `jasoseo style_check must flag clichés: ${style}`);
assert.equal(checks.jasoseoStyleFindings('').length, 0);
const dup = checks.duplicateSentences([
  { question: '지원 동기', answer: '저는 투자동아리에서 모의 포트폴리오를 운용하며 손실 한도를 넘긴 경험이 있습니다. 그래서 지원했습니다.' },
  { question: '갈등 경험', answer: '저는 투자동아리에서 모의 포트폴리오를 운용하며 손실 한도를 넘긴 경험이 있습니다. 갈등은 비교로 풀었습니다.' },
  { question: '포부', answer: '입사 후 위험 한도 설정 업무부터 배우겠습니다.' },
]);
assert.equal(dup.length, 1);
same([dup[0].questionA, dup[0].questionB], ['지원 동기', '갈등 경험']);
assert.equal(checks.duplicateSentences([{ question: 'a', answer: 'x' }]).length, 0);
same(checks.parseStyleCheck('문항1: 금지 ❌ 1건\n  [번역투] …에 의해…\n  [범위] 문장 길이\n\n금지 1건'), ['[번역투] …에 의해…', '[범위] 문장 길이']);

// 3) 경험 카드 검증: 근거 구절은 원문에 있어야 하고, 원문에 없는 수치가 든 항목은 뺀다.
const entries = [
  { id: 'e1', source: 'imported', kind: 'interview', sourceFile: 'interview/a.txt', company: '', question: 'Q1', answer: '동아리에서 인터뷰 8건 중 5건을 직접 진행했습니다. 팀은 발표 평가 2위를 했습니다.', createdAt: 1 },
  { id: 'e2', source: 'imported', kind: 'cover_letter', sourceFile: 'cover_letter/b.txt', company: '', question: 'Q2', answer: '같은 동아리에서 질문지 초안을 썼습니다.', createdAt: 1 },
];
const { cards: valid, rejected } = cards.validateCards({ cards: [
  { event_id: 'club', period: '2025-03 ~ 2025-06', context: '동아리 프로젝트', personal_actions: ['인터뷰 8건 중 5건 직접 진행', '인터뷰 20건 분석'], team_result: ['발표 평가 2위'],
    evidence: [{ entryId: 'e1', quote: '인터뷰 8건 중 5건을 직접 진행했습니다.' }, { entryId: 'e1', quote: '팀은 발표 평가 2위를 했습니다.' }], precision: { interview_count: 'exact', bogus: 'maybe' } },
  { event_id: 'club', context: '같은 동아리', personal_actions: ['질문지 초안 작성'], evidence: [{ entryId: 'e2', quote: '같은 동아리에서 질문지 초안을 썼습니다.' }] },
  { event_id: 'other', context: '지어낸 경험', personal_actions: ['없는 일'], evidence: [{ entryId: 'e1', quote: '원문에 없는 문장' }] },
] }, entries);
assert.equal(valid.length, 2);
assert.equal(rejected, 1, 'a card whose quotes are not in the source must be rejected');
same(valid.map((c) => [c.id, c.event_id]), [['EXP-01', 'EVT-01'], ['EXP-02', 'EVT-01']], 'same event keeps one EVT id');
same(valid[0].personal_actions, ['인터뷰 8건 중 5건 직접 진행']);
same(valid[0].droppedItems, ['인터뷰 20건 분석'], 'a number not in the quotes must be dropped');
same(valid[0].precision, { interview_count: 'exact' });
assert.equal(valid[0].user_confirmed, false, 'extracted cards start unconfirmed');
same(valid[1].evidence[0].kind, 'cover_letter');

// 확인 해시는 확인 여부와 무관하고 내용이 바뀌면 달라진다.
const hash = cards.cardContentHash(valid[0]);
assert.equal(cards.cardContentHash({ ...valid[0], user_confirmed: true, approval: { content_hash: 'x' } }), hash);
assert.notEqual(cards.cardContentHash({ ...valid[0], personal_actions: ['다른 행동'] }), hash);
const content = cards.cardSourceContent(valid[0]);
assert.equal('user_confirmed' in content || 'approval' in content || 'droppedItems' in content, false);
assert.equal(content.sourceQuotes[0].kind, '과거 면접 답변');

// 4) 소재 배치: 소재는 SUFFICIENT/WEAKLY_SUPPORTED 판정의 근거여야 하고, 판정 상태는 정해진 값만 허용한다.
const sources = [{ id: 'card.EXP-01', text: JSON.stringify(content) }, { id: 'company.overview', text: '회사 소개' }];
const basePlan = { question: 'Q', personalEvidence: 'required', questionTypes: ['experience'] };
const quote = '인터뷰 8건 중 5건 직접 진행';
const ok = plan.applyMaterials({ materials: [{ question: 'Q', coverage: [{ requirement: '직접 행동', status: 'SUFFICIENT', sourceIds: ['card.EXP-01'], rationale: '직접 진행한 인터뷰가 있습니다.' }], selectedMaterials: [{ sourceId: 'card.EXP-01', quote, reason: '직접 행동' }], missingInfo: [] }] }, [basePlan], sources);
assert.equal(ok[0].coverage[0].status, 'SUFFICIENT');
assert.throws(() => plan.applyMaterials({ materials: [{ question: 'Q', coverage: [{ requirement: '리더십', status: 'MISSING', sourceIds: [], rationale: '리더 경험이 없습니다.' }], selectedMaterials: [{ sourceId: 'card.EXP-01', quote, reason: '그냥 넣음' }], missingInfo: [] }] }, [basePlan], sources), /어떤 요구를 충족하는지/, 'a material tied to no requirement must be rejected');
assert.throws(() => plan.applyMaterials({ materials: [{ question: 'Q', coverage: [{ requirement: 'x', status: 'GOOD', sourceIds: [], rationale: 'y' }], selectedMaterials: [], missingInfo: ['경험을 알려주세요'] }] }, [basePlan], sources), /상태는/);
assert.throws(() => plan.applyMaterials({ materials: [{ question: 'Q', selectedMaterials: [], missingInfo: ['경험을 알려주세요'] }] }, [basePlan], sources), /coverage/);
assert.throws(() => plan.applyMaterials({ materials: [{ question: 'Q', coverage: [{ requirement: 'x', status: 'SUFFICIENT', sourceIds: ['company.overview'], rationale: 'y' }], selectedMaterials: [], missingInfo: ['q'] }] }, [basePlan], sources), /개인 자료/);
const none = plan.applyMaterials({ materials: [{ question: 'Q', coverage: [{ requirement: '실패 경험', status: 'NO_ACTUAL_EXPERIENCE', sourceIds: [], rationale: '자료에 실패 경험이 없습니다.' }], selectedMaterials: [], missingInfo: ['실제 실패 경험을 알려주세요.'] }] }, [basePlan], sources);
assert.equal(none[0].selectedMaterials.length, 0, 'no fitting material → nothing forced in');

console.log('PASS vendor section extraction (fence-aware), original jasoseo style_check / cover-letter-team dedup_check run as-is, card quote/number grounding and event grouping, confirmation hash, coverage-gated material selection');
