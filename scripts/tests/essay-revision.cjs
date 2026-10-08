const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

// 첨삭(고쳐쓰기·첨삭 받기)의 하네스: 새 경험의 근거 고정, 독립 맥락 검증, 첨삭 받기의 현재 글 검증.
function compile(file, req) {
  const mod = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('require', 'module', 'exports', code)(req, mod, mod.exports);
  return mod.exports;
}
const prompts = [];
let queued = [];
let draft;
const baseText = '저는 투자동아리에서 손실 원인을 분석했습니다.';
const job = { id: 'job', text: JSON.stringify({ company: '가상은행', title: '리스크관리부 신입', targetRole: '리스크관리', rawContent: '담당 업무: 신용리스크 한도 모니터링, 여신 포트폴리오 집중도 분석', qualifications: ['금융 관련 데이터 분석 경험'] }) };
const sources = [
  job,
  { id: 'card.EXP-01', text: JSON.stringify({ personal_actions: ['드론 통신 모듈 펌웨어 작성'], writtenFor: ['다른 회사(가상방산) · 자기소개서'] }) },
  { id: 'card.EXP-02', text: JSON.stringify({ personal_actions: ['종목별 손실 기여도를 엑셀로 정리'] }) },
];
const stubs = {
  './ai-operation': compile('lib/ai-operation.ts', require),
  './application-role': { APPLICATION_ROLE_RULES: '', assertApplicationRole: () => {}, requireApplicationRole: () => ({ role: '리스크관리', revision: 'r1' }) },
  './ai-model-settings': { getAIModelId: () => 'test-model' },
  './db': { saveApplicationDraft: (_seq, json) => { draft = JSON.parse(json); } },
  './application-draft': {
    WRITING_RULES: '',
    getCachedApplicationDraft: () => draft,
    askModel: async (prompt) => { prompts.push(prompt); assert.ok(queued.length, `unexpected model call: ${prompt.slice(0, 80)}`); const value = queued.shift(); return typeof value === 'string' ? value : JSON.stringify(value); },
    collectContext: async () => ({ sources, forbiddenNames: ['가상방산'], otherCompanies: ['가상방산'], company: '가상은행', editPreferences: '',
      materialOrigins: new Map([['card.EXP-01', ['다른 회사(가상방산) · 자기소개서 · 임베디드 SW 개발']]]) }),
  },
  './application-skills': { loadApplicationSkills: () => ({ plan: '', materials: '', write: '', review: '' }) },
  './essay-bank': { recordEditSignals: () => {} },
  './essay-log': { logEssayEvent: () => {}, logEssayEvents: () => {}, newEssayThread: () => 'thread' },
  './essay-log-analysis': { locateInEssay: () => null },
  './vendor-checks': { jasoseoStyleFindings: () => [], imNotAiFindings: () => [], imNotAiChangeRate: () => 0.1 },
  './vendor-skills': { loadVendorSkills: () => ({ humanize: '' }) },
  './company-normalize': compile('lib/company-normalize.ts', require),
};
stubs['./essay-diff'] = compile('lib/essay-diff.ts', require);
stubs['./essay-style'] = compile('lib/essay-style.ts', (id) => stubs[id] ?? require(id));
stubs['./essay-contract'] = compile('lib/essay-contract.ts', require);
stubs['./essay-plan'] = compile('lib/essay-plan.ts', require);
stubs['./application-harness'] = compile('lib/application-harness.ts', (id) => stubs[id] ?? require(id));
const revision = compile('lib/essay-revision.ts', (id) => stubs[id] ?? require(id));

const question = '본인의 강점을 서술하시오.';
const reset = () => {
  draft = { seq: 'S', revision: 'v1', personalFields: [], notesForUser: [], model: 'm', generatedAt: 1, essayAnswers: [{
    question, countSpaces: true, guidance: '', answer: baseText, intent: '', missingInfo: [], reviewNotes: [], status: 'draft', source: 'user_question', generatedAt: 1,
    evidence: [{ sourceId: 'card.EXP-02', quote: '종목별 손실 기여도를 엑셀로 정리', usedFor: '행동' }],
  }] };
  prompts.length = 0;
};
const proposal = (answer, evidence, extra = {}) => ({ status: 'draft', intent: '수정', answer, changeSummary: ['수정'], evidence, missingInfo: [], reviewNotes: [], ...extra });
const kept = { sourceId: 'user.answer', quote: baseText, usedFor: '기존 사실' };
const drone = { sourceId: 'card.EXP-01', quote: '드론 통신 모듈 펌웨어 작성', usedFor: '기술 역량' };
const droneAnswer = `${baseText} 또한 드론 통신 모듈 펌웨어 작성 경험도 있습니다.`;
const clean = { issues: [] };

(async () => {
  // 1) 이전 답변에 없던 경험(card.EXP-01)을 이유 없이 끌어오면 거부되고, 수정 호출이 그 이유를 받는다.
  //    수정 요청 원문을 anchor로 대면 허용되고, 새로 추가한 경험이 검토 메모에 표시된다.
  reset();
  queued = [proposal(droneAnswer, [kept, drone]), proposal(droneAnswer, [kept, drone], { addedMaterials: [{ sourceId: 'card.EXP-01', anchor: { source: 'request', quote: '펌웨어 경험도 넣어' } }] }), clean];
  await revision.reviseEssay('S', question, '펌웨어 경험도 넣어 주세요');
  assert.equal(queued.length, 0);
  assert.ok(prompts[1].includes('이전 답변에 없던 경험 card.EXP-01'), 'the repair call must receive the containment failure');
  assert.ok(prompts[0].includes('["card.EXP-02"]'), 'prior materials are listed for the reviser');
  let pending = draft.essayAnswers[0].pendingRevision;
  assert.ok(pending.reviewNotes.some((n) => n.startsWith('새로 추가한 경험 확인: card.EXP-01')));

  // 2) anchor가 회사명·직무명이거나 원문에 없으면 고쳐 써도 통과하지 못한다(두 번째도 실패하면 오류).
  reset();
  queued = [proposal(droneAnswer, [kept, drone], { addedMaterials: [{ sourceId: 'card.EXP-01', anchor: { source: 'job', quote: '리스크관리' } }] }),
    proposal(droneAnswer, [kept, drone], { addedMaterials: [{ sourceId: 'card.EXP-01', anchor: { source: 'job', quote: '임베디드 개발 역량' } }] })];
  await assert.rejects(revision.reviseEssay('S', question, '더 강하게 써 주세요'), /이전 답변에 없던 경험/);
  assert.equal(draft.essayAnswers[0].pendingRevision, undefined);

  // 3) 이미 쓰던 경험만 쓰면 근거 고정 없이 통과하고, 독립 검증은 작성자의 수정 이유 없이 공고·답변만 받는다.
  reset();
  queued = [proposal(`${baseText} 손실의 원인을 종목별로 나눴습니다.`, [kept, { sourceId: 'card.EXP-02', quote: '종목별 손실 기여도', usedFor: '행동' }], { changeSummary: ['비밀스러운 수정 이유'] }), clean];
  await revision.reviseEssay('S', question, '행동을 더 구체적으로');
  const auditPrompt = prompts.at(-1);
  assert.ok(auditPrompt.includes('독립된 검토자') && auditPrompt.includes('가상방산') && !auditPrompt.includes('비밀스러운 수정 이유'));
  assert.ok(draft.essayAnswers[0].pendingRevision);

  // 4) 독립 검증이 지적하면 한 번 고쳐 쓰고, 그래도 남으면 수정본은 남기되 지적을 메모 맨 앞에 둔다. 답변에 없는 지적은 버린다.
  reset();
  const sentence = '또한 드론 통신 모듈 펌웨어 작성 경험도 있습니다.';
  const flagged = { issues: [{ sentence, type: 'stretched_link', reason: '리스크관리 업무와 닿지 않는 개발 경험' }, { sentence: '없는 문장', type: 'other_company', reason: '버림' }] };
  const withAnchor = proposal(droneAnswer, [kept, drone], { addedMaterials: [{ sourceId: 'card.EXP-01', anchor: { source: 'request', quote: '펌웨어 경험도 넣어' } }] });
  queued = [withAnchor, flagged, withAnchor, flagged];
  await revision.reviseEssay('S', question, '펌웨어 경험도 넣어 주세요');
  assert.equal(queued.length, 0);
  assert.ok(prompts[2].includes('리스크관리 업무와 닿지 않는 개발 경험'), 'the repair call must receive the audit findings');
  pending = draft.essayAnswers[0].pendingRevision;
  assert.ok(pending.reviewNotes[0].startsWith('직무·회사 맥락 확인(억지 연결)'));
  assert.ok(!pending.reviewNotes.some((n) => n.includes('버림')));

  // 5) 첨삭 받기: 현재 글을 독립 검증해, 섞인 맥락을 보완할 점 맨 앞에 둔다.
  reset();
  draft.essayAnswers[0].answer = '저는 국방 기술 자립에 기여하고 싶습니다. 저는 투자동아리에서 손실 원인을 분석했습니다.';
  queued = [{ summary: '총평', strengths: [], issues: ['구체성 부족'], suggestions: [] },
    { issues: [{ sentence: '저는 국방 기술 자립에 기여하고 싶습니다.', type: 'other_company', reason: '방산 지원서의 동기' }] }];
  await revision.reviewEssay('S', question, '');
  const issues = draft.essayAnswers[0].feedback.issues;
  assert.ok(issues[0].startsWith('직무·회사 맥락 확인(다른 회사 맥락)') && issues[1] === '구체성 부족');

  // 문장 내 따옴표·줄바꿈 오류가 연속 발생해도 문법 복구 뒤 정상 검증을 거친다.
  const malformed = '{"answer":"저는 "확인"했습니다.","intent":"수정"}';
  reset();
  queued = [malformed, '{"answer":"첫 줄\n둘째 줄"}', proposal(`${baseText} 기준을 확인했습니다.`, [kept]), clean];
  await revision.reviseEssay('S', question, '행동을 보강해주세요');
  assert.equal(queued.length, 0);
  assert.ok(draft.essayAnswers[0].pendingRevision);
  assert.ok(prompts[1].includes('JSON 문법만 복구'));

  // 내용 검증 실패는 문법 복구와 별도로 처리된다.
  reset();
  queued = [malformed, proposal(`${baseText} 기준을 확인했습니다.`, [{ ...kept, quote: '원문에 없는 인용' }]), proposal(`${baseText} 기준을 확인했습니다.`, [kept]), clean];
  await revision.reviseEssay('S', question, '행동을 보강해주세요');
  assert.equal(queued.length, 0);
  assert.ok(prompts[2].includes('답변 근거가 저장된 원문과 일치하지 않습니다.'));

  // 첨삭 받기도 문법 복구를 적용하고, 끝내 실패하면 기존 저장 내용을 보존한다.
  reset();
  queued = [malformed, malformed, { summary: '총평', strengths: [], issues: [], suggestions: [] }, clean];
  await revision.reviewEssay('S', question, '');
  assert.ok(draft.essayAnswers[0].feedback);
  reset();
  const before = JSON.stringify(draft);
  queued = [malformed, malformed, malformed];
  await assert.rejects(revision.reviseEssay('S', question, '보강해주세요'), /JSON 형식을 자동으로 복구하지 못했습니다/);
  assert.equal(queued.length, 0);
  assert.equal(JSON.stringify(draft), before);

  reset();
  const unchanged = JSON.stringify(draft);
  queued = [malformed, proposal(`${baseText} 기준을 확인했습니다.`, [{ ...kept, quote: '없는 인용' }]), malformed, malformed];
  await assert.rejects(revision.reviseEssay('S', question, '보강해주세요'), /JSON 형식을 자동으로 복구하지 못했습니다/);
  assert.equal(queued.length, 0, '문법 복구 예산은 내용 재시도에서도 공유해야 한다');
  assert.equal(JSON.stringify(draft), unchanged);

  reset();
  queued = ['[]', { summary: '총평', strengths: [], issues: [], suggestions: [] }, clean];
  await revision.reviewEssay('S', question, '');
  assert.equal(queued.length, 0);
  assert.ok(prompts[1].includes('[형식 오류 결과]'), '유효한 JSON의 스키마 오류는 기존 검증 재시도로 처리한다');
  assert.ok(!prompts[1].includes('[JSON 문법 오류 결과'), '스키마 오류는 문법 복구 예산을 쓰지 않는다');

  console.log('PASS revision harness: new experiences need verbatim request/question/job anchors, independent audit without the reviser\'s reasoning with one repair then notes, 첨삭 받기 audits the current text');
})().catch((error) => { console.error(error); process.exitCode = 1; });
