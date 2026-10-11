const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

// 자기소개서 작성 흐름: 구성 제안 → (사용자가 고침) → 작성 → 문단 다시 쓰기 / 첨삭 받기.
// 검사는 막지 않고 경고로만 남고, 응답 일부가 빠져도 나머지는 저장되는지 본다.
function compile(file, req) {
  const mod = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('require', 'module', 'exports', code)(req, mod, mod.exports);
  return mod.exports;
}
const prompts = [];
let queued = [];
let draftRow = null;
const events = [];
let historyRows = [];
let noRole = false;
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
  './application-role': { requireApplicationRole: () => { if (noRole) throw new Error('지원 직무를 선택해주세요'); return { role: '리스크관리팀 신입', revision: 'r1' }; }, assertApplicationRole: () => {} },
  './db': {
    getJobBySeq: () => job,
    getCompanySections: () => [{ sectionType: 'overview', status: 'ok', content: `IPO 투자자문과 펀드운용을 합니다. ${'회사 설명 '.repeat(600)}` }, { sectionType: 'news', status: 'ok', content: '뉴스' }],
    listEssayEventRows: () => historyRows,
    getApplicationDraftRow: () => (draftRow ? { draftJson: draftRow } : undefined),
    saveApplicationDraft: (_seq, json) => { draftRow = json; },
    getApplicationRole: () => ({ role: '', revision: '' }),
  },
  './profile': { getCachedProfile: () => ({ projects: [{ name: '북블라', role: '개발', summary: '매칭 앱' }], careerGoals: '' }) },
  './applicant-profile': { readApplicantProfile: () => ({ workExperiences: [], education: [{ schoolName: '가상대학교', schoolLevel: '대학교', major: '소프트웨어', status: '졸업', endDate: '2026-02' }],
    projects: [], activities: [], certifications: [{ name: '투자자산운용사', issuedDate: '2026-05-21' }], languageTests: [] }) },
  './narrative-profile': { readNarrativeProfile: () => ({ core: { coreValues: '오래 할 수 있는 일', workCriteria: '', futureDirection: '', opennessToNewFields: '' },
    episodes: [{ id: 'ep1', title: '투자 손실 뒤 공부', situation: '급등주로 손실을 봤다', reasoning: '알기 전에는 투자하지 않는다', lesson: '', tags: [], createdAt: 1 }] }) },
  './essay-bank': { getCachedEssayBank: () => ({ entries: [{ company: '다른증권' }], styleNotes: '담백한 합니다체', editSignals: [] }), summarizeEditPreferences: () => '', recordEditSignals: () => {} },
  './experience-cards': { cardsCoverProfile: () => true, getAllCards: () => [card, card2], getConfirmedCards: () => [card] },
  './essay-log': { logEssayEvent: (e) => events.push(e), logEssayEvents: (list) => events.push(...list), newEssayThread: () => 'thread' },
  './essay-log-analysis': { locateInEssay: () => null },
};
stubs['./ai-operation'] = compile('lib/ai-operation.ts', require);
stubs['./company-normalize'] = compile('lib/company-normalize.ts', require);
stubs['./essay-contract'] = compile('lib/essay-contract.ts', require);
stubs['./essay-diff'] = compile('lib/essay-diff.ts', require);
stubs['./essay-style'] = compile('lib/essay-style.ts', (id) => stubs[id] ?? require(id));
stubs['./application-draft'] = compile('lib/application-draft.ts', (id) => stubs[id] ?? require(id));
stubs['./essay-revision'] = compile('lib/essay-revision.ts', (id) => stubs[id] ?? require(id));
const writer = compile('lib/essay-writer.ts', (id) => stubs[id] ?? require(id));
const draft = () => JSON.parse(draftRow);
const plain = (v) => JSON.parse(JSON.stringify(v));

(async () => {
  // 1) 작성 자료: 확인한 카드와 가치관 서사가 경험 목록이 되고, 다른 회사·학교·프로젝트 이름은 미리 가린다. 회사 자료는 잘라서 보낸다.
  const ctx = writer.buildEssayContext('S');
  assert.deepEqual(ctx.materials.map((m) => m.id), ['card.EXP-01', 'card.EXP-02', 'episode.ep1']);
  assert.ok(ctx.materials[1].text.includes('[비공개 명칭]') && !ctx.materials.some((m) => m.text.includes('다른증권')), 'other company names are redacted');
  // 확인 전 카드도 고를 수 있게 넣되, 미확인으로 표시한다(카드를 다시 만들면 확인 표시가 사라져 경험 없이 쓰인 적이 있다).
  assert.ok(ctx.materials[1].label.startsWith('(미확인) ') && ctx.materials[1].text.includes('아직 확인하지 않은 카드'));
  assert.ok(!ctx.materials[0].label.startsWith('(미확인)'));
  assert.ok(!ctx.facts.includes('가상대학교') && ctx.facts.includes('투자자산운용사(2026-05-21 취득)'));
  assert.ok(ctx.companyText.length < 2700 && !ctx.companyText.includes('뉴스'), 'company text is capped and limited to overview/culture');
  assert.deepEqual(plain(writer.listEssayMaterials('S').map((m) => m.kind)), ['card', 'card', 'episode']);
  // 지원 직무를 고르기 전에도 경험 목록은 보인다(구성 제안·작성은 직무가 있어야 한다).
  noRole = true;
  assert.equal(writer.listEssayMaterials('S').length, 3);
  assert.throws(() => writer.buildEssayContext('S'), /지원 직무/);
  noRole = false;

  // 2) 구성 제안: 문항 전체를 한 번에. JSON 문법만 깨지면 한 번 더 묻고, 모르는 경험 id는 빼고, 빠진 문항은 빈 구성으로 둔다.
  const requests = [{ question: '지원동기', countSpaces: true, guidance: '' }, { question: '성장과정', maxChars: 500, countSpaces: true, guidance: '투자 이야기는 짧게' }];
  queued = ['{"outlines": [ 깨진', { outlines: [{ index: 0, message: '기록을 맞추는 일이 맞다', paragraphs: [{ role: '지원동기', materials: ['card.EXP-01', 'card.없는것'], note: '대조 경험' }],
    companyFacts: ['IPO 투자자문을 합니다'], questions: ['결제 오류는 몇 건이었나요?'] }] }];
  await writer.proposeOutlines('S', requests);
  assert.equal(queued.length, 0);
  assert.ok(prompts[0].includes('[자기소개서 작성 기준]') && prompts[0].includes('(card.EXP-01)') && prompts[0].includes('"request":"투자 이야기는 짧게"'));
  assert.ok(prompts[1].includes('JSON 문법만 바로잡아'), 'a broken JSON response gets one syntax-only retry');
  let outlines = draft().outlines;
  assert.equal(outlines.length, 2);
  assert.deepEqual(outlines[0].paragraphs[0].materials, ['card.EXP-01'], 'unknown material ids are dropped');
  assert.equal(outlines[0].companyFacts[0].use, true);
  assert.equal(outlines[1].message, '', 'a missing outline becomes an empty one instead of failing');
  assert.ok(events.some((e) => e.type === 'outline_generated'));

  // 3) 화면에서 고친 구성 받기: 조건은 parseEssayRequest 규칙으로, 경험 id는 목록에 있는 것만.
  const ids = new Set(ctx.materials.map((m) => m.id));
  const edited = writer.parseOutlineInput({ ...outlines[0], message: '  고친 메시지 ', paragraphs: [{ role: '지원동기', materials: ['card.EXP-01', 'bogus'], note: '' }, { role: '', materials: [], note: '' }],
    questions: [{ question: '결제 오류는 몇 건이었나요?', answer: '30건 정도' }] }, ids);
  assert.equal(edited.message, '고친 메시지');
  assert.equal(edited.paragraphs.length, 1, 'empty paragraphs are dropped');
  assert.deepEqual(plain(edited.paragraphs[0].materials), ['card.EXP-01']);
  assert.throws(() => writer.parseOutlineInput({ question: '  ' }, ids));

  // 4) 작성: 고른 경험만 보내고, 결과는 경고만 붙여 저장한다. 답변이 빠진 문항은 구성을 남기고 실패로 알린다.
  const second = { ...outlines[1], message: '원칙을 세운 과정', paragraphs: [{ role: '성장', materials: ['episode.ep1'], note: '' }] };
  queued = [{ answers: [{ index: 0, answer: `공고상 리스크관리 업무에 지원했습니다. 결제 기록과 지급 기록을 대조해 30건을 찾았고 99%를 줄였다.\n\n${'가'.repeat(10)}` }] }];
  const before = prompts.length;
  await assert.rejects(writer.writeFromOutlines('S', [edited, second]), /2개 중 1개를 저장했습니다/);
  const writePrompt = prompts[before];
  assert.ok(writePrompt.includes('(card.EXP-01)') && writePrompt.includes('(episode.ep1)') && !writePrompt.includes('(card.EXP-02)'), 'only chosen materials are sent');
  assert.ok(writePrompt.includes('"answersFromApplicant":[{"question":"결제 오류는 몇 건이었나요?","answer":"30건 정도"}]'));
  const saved = draft().essayAnswers.find((a) => a.question === '지원동기');
  assert.equal(saved.status, 'draft');
  assert.equal(saved.outline.message, '고친 메시지');
  const warnings = saved.reviewNotes.filter((n) => n.startsWith('확인:'));
  assert.ok(warnings.some((n) => n.includes('“공고상”')), 'meta phrases are warnings, not failures');
  assert.ok(warnings.some((n) => n.includes('반말')));
  assert.ok(warnings.some((n) => n.includes('99')) && !warnings.some((n) => n.includes('30,') || n.includes(' 30 ')), 'numbers from the applicant answers are known; others are flagged');
  assert.deepEqual(plain(draft().outlines.map((o) => o.question)), ['성장과정'], 'the written outline is removed; the missing one stays for retry');
  assert.ok(events.some((e) => e.type === 'draft_failed' && e.question === '성장과정'));
  assert.ok(events.some((e) => e.type === 'draft_generated' && e.question === '지원동기'));

  // 5) 글자 수 초과도 경고로만 남는다.
  assert.ok(writer.essayWarnings('가'.repeat(20), { maxChars: 10, countSpaces: true, forbiddenNames: [], sourceText: '' })[0].includes('제한(10자)을 넘습니다'));
  assert.equal(writer.essayWarnings('', { countSpaces: true, forbiddenNames: [], sourceText: '' }).length, 0);

  // 6) 문단 다시 쓰기: 고른 문단만 받아서 끼워 넣는다. 고르지 않은 문단을 바꿔 보내도 무시한다.
  const base = '첫 문단입니다.\n\n둘째 문단입니다.\n\n셋째 문단입니다.';
  draftRow = JSON.stringify({ ...draft(), essayAnswers: [{ ...saved, answer: base }] });
  historyRows = [{ type: 'revision_requested', detail: JSON.stringify({ instruction: '지원동기를 앞으로' }) }, { type: 'revision_discarded', detail: '{}' }];
  queued = [{ paragraphs: [{ paragraph: 2, text: '새 둘째 문단입니다.' }, { paragraph: 1, text: '바꾸면 안 되는 첫 문단' }], summary: ['둘째 문단을 구체화'] }];
  const r = await writer.rewriteParagraphs('S', '지원동기', [1], '더 구체적으로');
  assert.equal(r.outcome, 'pending-revision');
  const pending = draft().essayAnswers[0].pendingRevision;
  assert.equal(pending.answer, '첫 문단입니다.\n\n새 둘째 문단입니다.\n\n셋째 문단입니다.');
  assert.equal(draft().essayAnswers[0].answer, base, 'the answer itself is unchanged until accepted');
  assert.ok(prompts.at(-1).includes('2번 문단만') && prompts.at(-1).includes('(2) 둘째 문단입니다.'));
  assert.ok(prompts.at(-1).includes('- 요청: 지원동기를 앞으로') && prompts.at(-1).includes('버렸다'), 'recent requests and discarded directions are remembered');
  // 자료에 없는 사실이 필요하면 질문으로 돌아온다(글은 그대로).
  queued = [{ paragraphs: [], summary: [], needsInfo: ['어느 회사의 사례인가요?'] }];
  assert.equal((await writer.rewriteParagraphs('S', '지원동기', [], '업계 사례를 넣어주세요')).outcome, 'needs-info');
  assert.equal(draft().essayAnswers[0].revisionNeedsInfo.questions[0], '어느 회사의 사례인가요?');
  // 아무것도 오지 않으면 실패로 알리고 글은 그대로 둔다.
  queued = [{ paragraphs: [] }];
  await assert.rejects(writer.rewriteParagraphs('S', '지원동기', [0], '고쳐주세요'), /받지 못했습니다/);
  assert.equal(writer.splitParagraphs ?? null, null, 'paragraph splitting lives in essay-contract');
  assert.deepEqual(plain(stubs['./essay-contract'].splitParagraphs('한 줄\n두 줄').paragraphs), ['한 줄', '두 줄']);

  // 7) 첨삭 받기: 지원자 본인의 사실은 지우라고 하지 않게 하고, 새 출처 언급·근거 없는 수치를 넣는 제안은 버린다.
  queued = [{ summary: '좋습니다', strengths: [], issues: [], suggestions: [
    { original: '첫 문단입니다.', replacement: '공고에서 강조한 역량을 길렀습니다.', category: '표현·문체', reason: '' },
    { original: '셋째 문단입니다.', replacement: '성과가 70% 늘었습니다.', category: '구체성', reason: '' },
    { original: '둘째 문단입니다.', replacement: '둘째 문단을 다듬었습니다.', category: '표현·문체', reason: '' }] }];
  await writer.reviewEssay('S', '지원동기', '');
  const feedback = draft().essayAnswers[0].feedback;
  assert.deepEqual(plain(feedback.suggestions.map((s) => s.original)), ['둘째 문단입니다.']);
  assert.ok(prompts.at(-1).includes('지원자가 확인한 사실이다') && prompts.at(-1).includes('공고에 없다는 이유만으로 지적하지 않는다'));

  // 8) 받아들이면 수정본이 본문이 되고 버전이 쌓인다(저장된 답변을 다루는 동작은 AI 없이 처리).
  draftRow = JSON.stringify({ ...draft(), essayAnswers: [{ ...draft().essayAnswers[0], pendingRevision: pending }] });
  stubs['./essay-revision'].applyEssayAnswerAction('S', '지원동기', { action: 'accept-revision' }, draft().revision ?? null);
  assert.equal(draft().essayAnswers[0].answer, pending.answer);
  console.log('PASS essay writer: compact redacted context, one-call outlines with syntax retry and lenient parsing, edited outline parsing, write sends chosen materials and only warns, missing answers keep their outline, paragraph-only rewrite, needs-info, review keeps the user\'s facts, accept');
})().catch((error) => { console.error(error); process.exitCode = 1; });
