const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

// 웹의 자기소개서: 저장(AI 없음, 막지 않는 점검) → 직접 수정·제안 반영 때 점검 갱신 → 첨삭 받기 → 최종본 저장(과거 자소서 자료에 바로).
// 과거 자소서 저장소 경로가 process.cwd() 기준이라 임시 폴더에서 불러온다.
const root = path.resolve(__dirname, '../..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'findar-essay-review-'));
process.chdir(work);
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/essay-bank.json', JSON.stringify({ entries: [{ id: 'old', company: '다른증권', question: '지원동기', answer: '예전 글', source: 'imported', createdAt: 1 }], styleNotes: '담백한 합니다체', editSignals: [], files: {} }));
function compile(file, req) {
  const mod = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('require', 'module', 'exports', code)(req, mod, mod.exports);
  return mod.exports;
}
const prompts = [];
let queued = [];
let draftRow = null;
const events = [];
let historyRows = [];
let role = { role: '리스크관리팀 신입', revision: 'r1' };
const job = { company: '가상증권', title: '[가상증권] 리스크관리팀 신입', rawContent: '담당업무: 시장리스크 한도 모니터링, 리스크 보고서 작성', positions: [], qualifications: [] };
const card = { id: 'EXP-01', context: '창업팀에서 결제 오류를 추적한 일', personal_actions: ['결제 기록과 지급 기록을 대조함'], decision: [], observed_details: [],
  team_result: ['미지급 건 0건'], result_limitations: [], evidence: [{ quote: '결제 기록과 지급 기록을 하나씩 대조했습니다' }], origins: [{ company: '다른증권', context: '', question: '', kind: 'cover_letter' }] };
const card2 = { ...card, id: 'EXP-02', context: '다른증권 지원서에 쓴 도서관 근로 경험', personal_actions: ['서가를 돌며 잘못 꽂힌 책을 바로잡음'], team_result: [], evidence: [] };
const stubs = {
  './ai-query': { async *query({ prompt }) {
    prompts.push(prompt);
    assert.ok(queued.length, `unexpected model call: ${prompt.slice(-120)}`);
    const next = queued.shift();
    yield { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: typeof next === 'string' ? next : JSON.stringify(next) };
  } },
  './ai-model-settings': { getAIModelId: () => 'test-model' },
  './ai-usage': { recordAIUsage: () => {} },
  './application-role': { requireApplicationRole: () => { if (!role.role) throw new Error('지원 직무를 선택해주세요'); return role; }, assertApplicationRole: () => {} },
  './db': {
    getJobBySeq: () => job,
    getCompanySections: () => [{ sectionType: 'overview', status: 'ok', content: `IPO 투자자문과 펀드운용을 합니다. ${'회사 설명 '.repeat(600)}` }, { sectionType: 'news', status: 'ok', content: '뉴스' }],
    listEssayEventRows: () => historyRows,
    getApplicationDraftRow: () => (draftRow ? { draftJson: draftRow } : undefined),
    saveApplicationDraft: (_seq, json) => { draftRow = json; },
    getApplicationRole: () => role,
    getMemo: (scope, key) => (scope === 'company' && key === '가상증권' ? { text: '설명회: IPO 인력 충원', updatedAt: 1 } : null),
  },
  './profile': { getCachedProfile: () => ({ projects: [{ name: '북블라', role: '개발', summary: '매칭 앱' }], careerGoals: '' }) },
  './applicant-profile': { readApplicantProfile: () => ({ workExperiences: [], education: [{ schoolName: '가상대학교', schoolLevel: '대학교', major: '소프트웨어', status: '졸업', endDate: '2026-02' }],
    projects: [], activities: [], certifications: [{ name: '투자자산운용사', issuedDate: '2026-05-21' }], languageTests: [] }) },
  './narrative-profile': { readNarrativeProfile: () => ({ core: { coreValues: '오래 할 수 있는 일', workCriteria: '', futureDirection: '', opennessToNewFields: '' },
    episodes: [{ id: 'ep1', title: '투자 손실 뒤 공부', situation: '급등주로 손실을 봤다', reasoning: '알기 전에는 투자하지 않는다', lesson: '', tags: [], createdAt: 1 }] }) },
  './experience-cards': { cardsCoverProfile: () => true, getAllCards: () => [card, card2], getConfirmedCards: () => [card] },
  './essay-log': { logEssayEvent: (e) => events.push(e), logEssayEvents: (list) => events.push(...list), newEssayThread: () => 'thread' },
  './essay-log-analysis': { locateInEssay: () => null },
};
const req = (id) => stubs[id] ?? require(id);
stubs['./ai-operation'] = compile('lib/ai-operation.ts', require);
stubs['./company-normalize'] = compile('lib/company-normalize.ts', require);
stubs['./essay-contract'] = compile('lib/essay-contract.ts', require);
stubs['./essay-diff'] = compile('lib/essay-diff.ts', require);
stubs['./essay-style'] = compile('lib/essay-style.ts', req);
stubs['./essay-sources'] = compile('lib/essay-sources.ts', req);
stubs['./essay-bank'] = compile('lib/essay-bank.ts', req);
stubs['./application-draft'] = compile('lib/application-draft.ts', req);
stubs['./essay-revision'] = compile('lib/essay-revision.ts', req);
const review = compile('lib/essay-review.ts', req);
const revision = stubs['./essay-revision'];
const bank = stubs['./essay-bank'];
const draft = () => JSON.parse(draftRow);
const plain = (v) => JSON.parse(JSON.stringify(v));
const check = (t, r) => review.checkEssay('S', t, r);

(async () => {
  // 1) 첨삭 자료: 확인 전 카드도 표시를 달아 넣고, 다른 회사·학교·프로젝트 이름은 미리 가린다. 회사 자료는 잘라서 보낸다.
  const ctx = review.buildEssayContext('S');
  assert.deepEqual(ctx.materials.map((m) => m.id), ['card.EXP-01', 'card.EXP-02', 'episode.ep1']);
  assert.ok(ctx.materials[1].text.includes('[비공개 명칭]') && !ctx.materials.some((m) => m.text.includes('다른증권')), 'other company names are redacted');
  assert.ok(ctx.materials[1].label.startsWith('(미확인) ') && ctx.materials[1].text.includes('아직 확인하지 않은 카드'));
  assert.ok(!ctx.facts.includes('가상대학교') && ctx.facts.includes('투자자산운용사(2026-05-21 취득)'));
  assert.ok(ctx.companyText.length < 2700 && !ctx.companyText.includes('뉴스'), 'company text is capped and limited to overview/culture');

  // 2) 저장: 지원 직무를 고르기 전에도 저장되고 AI를 부르지 않는다. 점검은 막지 않고 "확인:"으로만 남는다.
  //    지원자가 쓴 수치는 대조하지 않는다(자료에 없어도 지원자의 사실이다).
  role = { role: '', revision: '' };
  const text = '공고상 리스크관리 업무에 지원했습니다. 다른증권에서 30건을 찾았고 99%를 줄였다.';
  revision.importEssay('S', { question: '지원동기', maxChars: 20, answer: text }, null, check);
  let saved = draft().essayAnswers[0];
  assert.equal(saved.answer, text);
  assert.equal(saved.targetRole, undefined);
  assert.equal(prompts.length, 0, 'saving makes no AI call');
  const warnings = saved.reviewNotes.filter((n) => n.startsWith('확인:'));
  assert.ok(warnings.some((n) => n.includes('제한(20자)을 넘습니다')));
  assert.ok(warnings.some((n) => n.includes('“공고상”')), 'meta phrases are warnings, not failures');
  assert.ok(warnings.some((n) => n.includes('반말')));
  assert.ok(warnings.some((n) => n.includes('다른 회사')), 'another company name pasted from an old essay is flagged');
  assert.ok(!warnings.some((n) => n.includes('99') || n.includes('수치')), 'applicant numbers are not flagged');
  assert.ok(events.some((e) => e.type === 'answer_imported'));
  assert.throws(() => review.buildEssayContext('S'), /지원 직무/, 'review still needs a role');
  role = { role: '리스크관리팀 신입', revision: 'r1' };

  // 3) 직접 고치면 점검을 다시 돌려 메모가 늘 지금 글을 본 결과가 된다.
  const edited = revision.recordManualEdit('S', saved, '리스크관리 업무에 지원했습니다.', check);
  assert.ok(!edited.reviewNotes.some((n) => n.startsWith('확인:')) && edited.evidenceStale === false);
  assert.equal(edited.versions.at(-1).kind, 'user_edit');

  // 4) 첨삭 받기: 지원자 본인의 사실은 지우라고 하지 않게 하고, 새 출처 언급·근거 없는 수치를 넣는 제안은 버린다.
  const base = '첫 문단입니다.\n\n둘째 문단입니다.\n\n셋째 문단입니다.';
  draftRow = JSON.stringify({ ...draft(), essayAnswers: [{ ...saved, answer: base, maxChars: undefined }] });
  historyRows = [{ type: 'suggestion_dismissed', detail: JSON.stringify({ original: '첫 문단', replacement: '다른 첫 문단' }) }];
  queued = ['{"summary": 깨진', { summary: '좋습니다', strengths: [], issues: [], suggestions: [
    { original: '첫 문단입니다.', replacement: '공고에서 강조한 역량을 길렀습니다.', category: '표현·문체', reason: '' },
    { original: '셋째 문단입니다.', replacement: '성과가 70% 늘었습니다.', category: '구체성', reason: '' },
    { original: '둘째 문단입니다.', replacement: '둘째 문단을 다듬었습니다.', category: '표현·문체', reason: '' }] }];
  const result = await review.reviewEssay('S', '지원동기', '');
  assert.equal(result.outcome, 'feedback');
  assert.ok(prompts[1].includes('JSON 문법만 바로잡아'), 'a broken JSON response gets one syntax-only retry');
  const feedback = draft().essayAnswers[0].feedback;
  assert.deepEqual(plain(feedback.suggestions.map((s) => s.original)), ['둘째 문단입니다.']);
  assert.ok(prompts[0].includes('[자기소개서 작성 기준]') && prompts[0].includes('지원자가 확인한 사실이다') && prompts[0].includes('공고에 없다는 이유만으로 지적하지 않는다'));
  assert.ok(prompts[0].includes('넘긴 첨삭: “첫 문단”'), 'dismissed suggestions are remembered');
  assert.ok(!prompts[0].includes('(card.EXP-01)'), 'review does not send the material list');

  // 5) 제안 반영은 AI 없이 치환하고 점검을 다시 돈다.
  const suggestionId = feedback.suggestions[0].id;
  revision.applyEssayAnswerAction('S', '지원동기', { action: 'apply-suggestion', suggestionId }, draft().revision ?? null, check);
  saved = draft().essayAnswers[0];
  assert.equal(saved.answer, '첫 문단입니다.\n\n둘째 문단을 다듬었습니다.\n\n셋째 문단입니다.');
  assert.equal(saved.evidenceStale, false);
  assert.equal(saved.versions.at(-1).kind, 'suggestion');
  assert.throws(() => revision.applyEssayAnswerAction('S', '지원동기', { action: 'accept-revision' }, draft().revision ?? null), 'old rewrite actions are gone');

  // 6) 최종본으로 저장: 과거 자소서 자료에 바로 들어가고, 같은 공고·문항을 다시 저장하면 새 글로 바뀐다(쌓이지 않는다).
  revision.saveFinalAnswer('S', '지원동기', draft().revision ?? null);
  let finals = bank.listFinalEssays('S');
  assert.equal(finals.length, 1);
  assert.equal(finals[0].answer, saved.answer);
  assert.equal(finals[0].company, '가상증권');
  assert.equal(finals[0].context, '지원 직무: 리스크관리팀 신입');
  const firstId = finals[0].id;
  revision.recordManualEdit('S', saved, '마지막으로 고친 글입니다.', check);
  draftRow = JSON.stringify({ ...draft(), essayAnswers: [{ ...saved, answer: '마지막으로 고친 글입니다.' }], revision: 'r2' });
  assert.throws(() => revision.saveFinalAnswer('S', '지원동기', 'stale'), /다른 창/);
  revision.saveFinalAnswer('S', '지원동기', 'r2');
  finals = bank.listFinalEssays('S');
  assert.equal(finals.length, 1);
  assert.equal(finals[0].id, firstId);
  assert.equal(finals[0].answer, '마지막으로 고친 글입니다.');
  assert.deepEqual(plain(revision.finalSummaries('S').map((f) => f.question)), ['지원동기']);
  assert.equal(bank.getCachedEssayBank().entries.length, 2, 'imported entries stay; one final per posting and question');
  assert.ok(events.some((e) => e.type === 'saved_to_bank' && e.detail.entryId === firstId));
  bank.deleteFinalEssay(firstId);
  assert.equal(bank.listFinalEssays('S').length, 0);
  assert.throws(() => bank.deleteFinalEssay('old'), /찾을 수 없습니다/, 'uploaded entries cannot be deleted as finals');
  // 7) 대화 세션용 자료: 지원 직무 없이도 나오고, 이름은 가리고, 이 공고에 저장된 글과 저장 방법을 담는다.
  role = { role: '', revision: '' };
  revision.importEssay('S', { question: '입사 후 포부', maxChars: 500, answer: '포부 본문입니다.' }, draft().revision ?? null, check);
  const doc = review.essayContextDocument('S', { baseUrl: 'http://localhost:3000', researchNotice: '회사 리서치가 오래됐습니다.' });
  assert.ok(doc.startsWith('# Findar 자기소개서 자료 — 가상증권'));
  assert.ok(doc.includes('아직 고르지 않음') && doc.includes('주의: 회사 리서치가 오래됐습니다.'));
  assert.ok(doc.includes('### (미확인) ') && !doc.includes('다른증권') && !doc.includes('가상대학교'), 'materials are labeled and names redacted');
  assert.ok(doc.includes('### 입사 후 포부 (500자 이내, 공백 포함)\n포부 본문입니다.'));
  assert.ok(doc.includes('/api/applications/S/draft/import'));
  assert.ok(doc.includes('### 가상증권 회사 메모\n설명회: IPO 인력 충원') && !doc.includes('### 이 공고 메모'), 'user memos are included when present');
  assert.equal(prompts.length, 2, 'the context document makes no AI call');
  // 8) 문항 순서: 위아래 자리만 바꾸고(이전 방식 답변은 제자리), 같은 문항을 다시 저장해도 자리를 지킨다.
  draftRow = JSON.stringify({ ...draft(), essayAnswers: [{ question: '예전 공통 문항', answer: '보존' }, ...draft().essayAnswers] });
  const order = () => draft().essayAnswers.map((a) => a.question);
  assert.deepEqual(order(), ['예전 공통 문항', '지원동기', '입사 후 포부']);
  assert.throws(() => revision.applyEssayAnswerAction('S', '입사 후 포부', { action: 'move', direction: 'up' }, 'stale'), /다른 창/);
  revision.applyEssayAnswerAction('S', '입사 후 포부', { action: 'move', direction: 'up' }, draft().revision ?? null);
  assert.deepEqual(order(), ['예전 공통 문항', '입사 후 포부', '지원동기']);
  assert.throws(() => revision.applyEssayAnswerAction('S', '입사 후 포부', { action: 'move', direction: 'up' }, draft().revision ?? null), /첫 번째/);
  assert.throws(() => revision.applyEssayAnswerAction('S', '지원동기', { action: 'move', direction: 'down' }, draft().revision ?? null), /마지막/);
  assert.ok(events.some((e) => e.type === 'answer_moved' && e.question === '입사 후 포부' && e.detail.from === 2 && e.detail.to === 1));
  revision.importEssay('S', { question: '입사 후 포부', maxChars: 500, answer: '다시 쓴 포부입니다.' }, draft().revision ?? null, check);
  assert.deepEqual(order(), ['예전 공통 문항', '입사 후 포부', '지원동기'], 're-saving a question keeps its place');
  assert.equal(draft().essayAnswers[1].answer, '다시 쓴 포부입니다.');
  role = { role: '리스크관리팀 신입', revision: 'r1' };
  console.log('PASS essay review: redacted context, save without role or AI, warnings only (no applicant-number check), checks refresh on edit and applied suggestion, review filters suggestions with syntax retry, final save upserts into the essay bank, conversation context document, question order');
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => { process.chdir(root); fs.rmSync(work, { recursive: true, force: true }); });
