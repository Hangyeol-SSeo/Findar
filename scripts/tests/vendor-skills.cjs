const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

// 외부 스킬(skills/vendor) 연결: 원문 절 추출과 경험 카드 검증. 자기소개서 작성은 더 이상 외부 스킬 원문을 쓰지 않는다.
function compile(file, req) {
  const mod = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('require', 'module', 'exports', code)(req, mod, mod.exports);
  return mod.exports;
}
const contract = compile('lib/essay-contract.ts', require);
const vendor = compile('lib/vendor-skills.ts', require);
const cards = compile('lib/experience-cards.ts', (id) => ({
  './essay-contract': contract, './vendor-skills': vendor,
  './ai-model-settings': { getAIModelId: () => 'test-model' },
  './essay-bank': { getCachedEssayBank: () => ({ entries: [] }), getEssayBankProgress: () => ({ running: false }) },
  './resume-inventory': { ensureResumeInventory: async () => null, getCachedResumeInventory: () => null },
  './resume-files': { listResumePdfs: () => [] },
  './applicant-profile': { readApplicantProfile: () => ({}) },
  './resume-tailoring-contract': { buildApplicantItems: () => [] },
  './ai-query': { query: () => { throw new Error('no AI in tests'); } },
}[id] ?? require(id)));
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);

// 1) 원문 절 추출: 코드 블록 안의 "## Q-01"은 heading이 아니고, 같은 수준의 다음 heading에서 끝난다.
const md = '# T\n## A\nfirst\n```\n## Q-01 inside fence\n```\nstill A\n### A-1\nsub\n## B\nsecond';
assert.equal(vendor.markdownSection(md, '## A'), '## A\nfirst\n```\n## Q-01 inside fence\n```\nstill A\n### A-1\nsub');
assert.throws(() => vendor.markdownSection(md, '## 없음'), /찾지 못했습니다/);
const skills = vendor.loadVendorSkills();
assert.ok(skills.cards.includes('personal_actions') && skills.cards.includes('유도 질문 금지'), 'card skill must carry the original schema and rules');
same(Object.keys(skills), ['cards'], 'only the card schema is loaded now');

// 2) 경험 카드 검증: 근거 구절은 원문에 있어야 하고, 원문에 없는 수치가 든 항목은 뺀다.
const entries = [
  { id: 'e1', source: 'imported', kind: 'interview', sourceFile: 'interview/a.txt', company: '', question: 'Q1', answer: '동아리에서 인터뷰 8건 중 5건을 직접 진행했습니다. 팀은 발표 평가 2위를 했습니다.', createdAt: 1 },
  { id: 'e2', source: 'imported', kind: 'cover_letter', sourceFile: 'cover_letter/b.txt', company: '', question: 'Q2', answer: '같은 동아리에서 질문지 초안을 썼습니다.', createdAt: 1 },
];
const { cards: valid, rejected } = cards.validateCards({ cards: [
  { event_id: 'club', period: '2025-03 ~ 2025-06', context: '동아리 프로젝트', personal_actions: ['인터뷰 8건 중 5건 직접 진행', '인터뷰 20건 분석'], team_result: ['발표 평가 2위'],
    evidence: [{ entryId: 'e1', quote: '인터뷰 8건 중 5건을 직접 진행했습니다.' }, { entryId: 'e1', quote: '팀은 발표 평가 2위를 했습니다.' }], precision: { interview_count: 'exact', bogus: 'maybe' } },
  { event_id: 'club', context: '같은 동아리', personal_actions: ['질문지 초안 작성'], evidence: [{ entryId: 'e2', quote: '같은 동아리에서 질문지 초안을 썼습니다.' }] },
  { event_id: 'other', context: '지어낸 경험', personal_actions: ['없는 일'], evidence: [{ entryId: 'e1', quote: '원문에 없는 문장' }] },
] }, cards.essaySources(entries));
assert.equal(valid.length, 2);
assert.equal(rejected, 1, 'a card whose quotes are not in the source must be rejected');
same(valid.map((c) => [c.id, c.event_id]), [['EXP-01', 'EVT-01'], ['EXP-02', 'EVT-01']], 'same event keeps one EVT id');
same(valid[0].personal_actions, ['인터뷰 8건 중 5건 직접 진행']);
same(valid[0].droppedItems, ['인터뷰 20건 분석'], 'a number not in the quotes must be dropped');
same(valid[0].precision, { interview_count: 'exact' });
assert.ok(!valid[0].excluded && !('user_confirmed' in valid[0]), 'extracted cards are included by default, with no confirmation gate');
same(valid[1].evidence[0].kind, 'cover_letter');

// 다시 만든 카드는 번호·문장이 달라도 근거 구절이 같으면 뺀 상태를 이어받는다.
const rebuilt = [{ ...valid[1], id: 'EXP-01', context: '다시 쓴 맥락' }, { ...valid[0], id: 'EXP-02', personal_actions: ['다르게 정리한 행동'], evidence: [...valid[0].evidence].reverse() }];
const carried = cards.carryExclusions([{ ...valid[0], excluded: true }, valid[1]], rebuilt);
same(carried.map((c) => [c.id, !!c.excluded]), [['EXP-01', false], ['EXP-02', true]]);

console.log('PASS vendor section extraction (fence-aware), card schema only, card quote/number grounding and event grouping, exclusions carried across rebuilds');
