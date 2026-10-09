const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// 공고 하나의 작업 대화: 기억은 Findar 기록(history)이 원본이고, Claude는 네이티브 세션을 이어 써서 이전 턴을 다시 보내지 않는다.
// 머리말이 바뀌거나 세션이 실패·과대해지면 같은 기록으로 새 세션을 열고, Codex는 매번 머리말+기록+이번 작업의 앞선 턴을 보낸다.
const root = path.resolve(__dirname, '../..');
function compile(file, req) {
  const mod = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('require', 'module', 'exports', code)(req, mod, mod.exports);
  return mod.exports;
}

const calls = [];
let failResume = false;
let sessionCounter = 0;
const rows = new Map();
const usage = [];
const stubs = {
  './ai-query': {
    async *query({ prompt, options }) {
      calls.push({ prompt, options });
      if (failResume && options.resume) throw new Error('session file missing');
      const sessionId = options.resume ?? `S${++sessionCounter}`;
      const uuid = `A${calls.length}`;
      yield { type: 'system', subtype: 'init', session_id: sessionId };
      yield { type: 'assistant', uuid, session_id: sessionId, message: {} };
      const result = `응답${calls.length}`;
      if (options.model.startsWith('gpt-')) { yield { type: 'result', subtype: 'success', is_error: false, result, codexUsage: { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50 } }; return; }
      yield { type: 'result', subtype: 'success', is_error: false, result, session_id: sessionId, total_cost_usd: 0.01,
        ...(options.model === 'claude-small' ? { modelUsage: { 'claude-small': { contextWindow: 30000, maxOutputTokens: 4000 } } } : {}),
        usage: { input_tokens: options.model === 'claude-small' ? 15000 : options.resume ? 100 : 5000, cache_read_input_tokens: options.resume ? 9000 : 0, cache_creation_input_tokens: options.resume ? 100 : 9000, output_tokens: 40 } };
    },
  },
  './ai-model-types': { isCodexModel: (m) => m.startsWith('gpt-') },
  './ai-operation': { throwIfAIAborted: () => {} },
  './db': {
    getAIConversationRow: (key, provider) => rows.get(`${key}/${provider}`),
    saveAIConversationRow: (row) => rows.set(`${row.key}/${row.provider}`, { ...row }),
    deleteAIConversationRow: (key, provider) => rows.delete(`${key}/${provider}`),
    insertAIUsage: (row) => usage.push(row),
    listAIUsage: () => usage,
    listEssayEventRowsAfter: (_seq, after) => dbEvents.filter((e) => e.rowid > after),
  },
};
const dbEvents = [];
stubs['./ai-usage'] = compile('lib/ai-usage.ts', (id) => stubs[id] ?? require(id));
const { openConversation } = compile('lib/ai-conversation.ts', (id) => stubs[id] ?? require(id));
const { renderEssayEvent, renderEssayTranscript, essayHistory } = compile('lib/essay-transcript.ts', (id) => stubs[id] ?? require(id));

const events = [];
const history = {
  render(after) {
    const picked = events.filter((e) => e.rowid > (after ?? 0));
    return { text: picked.map((e) => e.text).join('\n\n'), lastRowid: picked.at(-1)?.rowid ?? after ?? 0 };
  },
};
const add = (text) => events.push({ rowid: events.length + 1, text });
const HEADER = '[사실 자료] 공통 자료 머리말';
const open = (model = 'claude-sonnet-5-5', header = HEADER, extra = {}) => openConversation({ key: 'seq1', feature: 'applicationDraft', model, header, history, ...extra });

(async () => {
  add('「지원동기」 사용자: 새로 작성 요청');
  add('「지원동기」 AI 작성 결과:\n초안 본문');

  // 1) 첫 작업: 머리말 + 전체 기록 + 지시로 새 세션을 연다. 같은 작업의 다음 턴은 세션을 이어 지시만 보낸다.
  let conv = open();
  assert.equal(await conv.ask('[작업: 초안 작성]'), '응답1');
  assert.ok(calls[0].prompt.startsWith(HEADER) && calls[0].prompt.includes('초안 본문') && calls[0].prompt.endsWith('[작업: 초안 작성]'));
  assert.equal(calls[0].options.persistSession, true);
  assert.equal(calls[0].options.resume, undefined);
  assert.ok(calls[0].options.cwd.endsWith(path.join('data', 'ai-sessions')), 'sessions are kept out of the user\'s own Claude Code history');
  await conv.ask('[작업: 편집]');
  assert.equal(calls[1].prompt, '[작업: 편집]', 'a resumed turn sends only the new instruction');
  assert.equal(calls[1].options.resume, 'S1');
  assert.equal(calls[1].options.resumeSessionAt, 'A1', 'resume at the last good assistant message');
  assert.equal(rows.get('seq1/claude').syncedRowid, 2);

  // 2) 몇 시간 뒤 첨삭: 새 작업도 같은 세션을 이어 쓰고, 그 사이 쌓인 기록(사용자가 버린 수정본 등)만 덧붙인다.
  add('「지원동기」 사용자가 수정본을 버렸다(원하지 않음).');
  conv = open();
  await conv.ask('[작업: 첨삭 받기]');
  assert.equal(calls[2].options.resume, 'S1');
  assert.ok(!calls[2].prompt.includes(HEADER), 'the header is not re-sent');
  assert.ok(calls[2].prompt.startsWith('[직전 작업 이후의 작업 기록]\n「지원동기」 사용자가 수정본을 버렸다'));
  assert.ok(!calls[2].prompt.includes('초안 본문'), 'already-synced history is not re-sent');

  // 3) 공통 자료가 바뀌면(새 카드 확인 등) 같은 기록으로 새 세션을 연다 — 기억은 그대로다.
  conv = open('claude-sonnet-5-5', `${HEADER} + 새 카드`);
  await conv.ask('[작업: 고쳐쓰기]');
  assert.equal(calls[3].options.resume, undefined);
  assert.ok(calls[3].prompt.includes('초안 본문') && calls[3].prompt.includes('수정본을 버렸다'));
  assert.equal(rows.get('seq1/claude').sessionId, 'S2');

  // 4) 세션 이어 쓰기가 실패하면 같은 기록과 이번 작업의 앞선 턴으로 새 세션을 열어 한 번 더 시도한다.
  conv = open('claude-sonnet-5-5', `${HEADER} + 새 카드`);
  failResume = true;
  const before = calls.length;
  await conv.ask('[작업: 첨삭 받기 2]');
  failResume = false;
  assert.equal(calls.length - before, 2);
  assert.equal(calls.at(-1).options.resume, undefined);
  assert.ok(calls.at(-1).prompt.includes('초안 본문'));
  assert.equal(rows.get('seq1/claude').sessionId, 'S3');
  await conv.ask('[작업: 이어서]');
  assert.equal(calls.at(-1).options.resume, 'S3');

  // 5) Codex(세션 없음): 매번 머리말+기록+이번 작업의 앞선 턴을 같은 순서로 보낸다. Claude 세션 위치는 건드리지 않는다.
  conv = open('gpt-6-luna', `${HEADER} + 새 카드`);
  await conv.ask('[작업: 초안 작성 by codex]');
  await conv.ask('[작업: 편집 by codex]');
  const codex = calls.slice(-2);
  assert.ok(codex.every((c) => c.options.persistSession === false && !c.options.resume && c.prompt.startsWith(`${HEADER} + 새 카드`)));
  assert.ok(codex[1].prompt.includes('[이번 작업에서 이미 주고받은 내용]\n[지시]\n[작업: 초안 작성 by codex]'), 'stateless turns carry the earlier turns of the operation');
  assert.equal(rows.get('seq1/claude').sessionId, 'S3');

  // 6) Codex가 만든 결과(기록)는 Claude로 돌아올 때 새 기록으로 이어받는다.
  add('「지원동기」 AI 작성 결과:\nCodex가 쓴 본문');
  conv = open('claude-sonnet-5-5', `${HEADER} + 새 카드`);
  await conv.ask('[작업: 첨삭 받기 by claude]');
  assert.equal(calls.at(-1).options.resume, 'S3');
  assert.ok(calls.at(-1).prompt.includes('Codex가 쓴 본문'));

  // 7) 문맥이 한도를 넘을 것 같으면(작업 시작 때뿐 아니라 매 턴 전에 확인) 정리한 기록으로 새로 시작한다.
  conv = open('claude-sonnet-5-5', `${HEADER} + 새 카드`, { maxContextTokens: 10 });
  await conv.ask('[작업: 긴 세션]');
  assert.equal(calls.at(-1).options.resume, undefined);
  // 한 작업 안에서: 첫 턴(새 세션, 문맥 14,040토큰) 뒤 다음 턴이 한도를 넘으면 이어 쓰지 않고 새로 연다(매 턴 전에 확인).
  // 새 세션에는 이번 작업의 앞선 턴을 상한 안에서 함께 보낸다.
  conv = open('claude-sonnet-5-5', `${HEADER} + 한도 시험`, { maxContextTokens: 14_050 });
  await conv.ask('[작업: 문항 1 작성]');
  assert.equal(calls.at(-1).options.resume, undefined);
  await conv.ask('[작업: 문항 2 작성]');
  assert.equal(calls.at(-1).options.resume, undefined, 'over the limit mid-operation it starts a new session');
  assert.ok(calls.at(-1).prompt.includes('[이번 작업에서 이미 주고받은 내용') && calls.at(-1).prompt.includes('[작업: 문항 1 작성]'));
  // 같은 흐름이라도 기본 한도(20만 - 3.2만 - 8천)에서는 이어 쓴다.
  conv = open('claude-sonnet-5-5', `${HEADER} + 기본 한도`);
  await conv.ask('[기본 1]');
  const sid = rows.get('seq1/claude').sessionId;
  await conv.ask('[기본 2]');
  assert.equal(calls.at(-1).options.resume, sid);
  // 모델이 알려 준 문맥 크기(3만 - 출력 4천 - 여유 8천 = 1.8만)로 한도를 정한다: 같은 사용량이어도 작은 모델은 새로 연다.
  conv = open('claude-small', `${HEADER} + 작은 모델`);
  await conv.ask('[작은 모델 1]');
  await conv.ask('[작은 모델 2]');
  assert.equal(calls.at(-1).options.resume, undefined, 'the learned window decides when to start over');

  // 8) 사용량: 새 세션/이어 쓰기/세션 없음 구분과 캐시 적중이 남는다.
  const modes = usage.map((u) => u.mode);
  assert.ok(modes.includes('fresh') && modes.includes('resumed') && modes.includes('stateless'));
  const resumed = usage.find((u) => u.mode === 'resumed');
  assert.equal(resumed.cacheReadTokens, 9000);
  assert.equal(resumed.inputTokens, 100);
  const codexUsage = usage.find((u) => u.provider === 'codex');
  assert.equal(codexUsage.inputTokens, 200, 'codex input excludes cached tokens');
  assert.equal(codexUsage.cacheReadTokens, 800);
  const summary = stubs['./ai-usage'].summarizeAIUsage(usage);
  assert.ok(summary.cacheHitRatio > 0 && summary.calls === usage.length);

  // 9) 같은 공고의 턴은 순서대로 하나씩 처리된다.
  conv = open();
  const order = [];
  await Promise.all([conv.ask('[동시 1]').then(() => order.push(1)), conv.ask('[동시 2]').then(() => order.push(2))]);
  assert.deepEqual(order, [1, 2]);

  // 10a) 대화에 넣는 기록도 공통 자료와 같이 가린다(직접 쓴 글·버린 수정본의 학교·다른 회사 이름).
  dbEvents.push({ rowid: 1, question: '지원동기', type: 'answer_imported', textBefore: null, textAfter: '가상대학교에서 배운 것을 가상방산에서 썼습니다.', detail: '{}', analysis: null });
  const redacted = essayHistory('seq1', (t) => t.replaceAll('가상대학교', '[비공개 명칭]').replaceAll('가상방산', '[비공개 명칭]')).render(null, 40000).text;
  assert.ok(redacted.includes('[비공개 명칭]에서 배운 것을 [비공개 명칭]에서') && !redacted.includes('가상방산'));
  const delta = essayHistory('seq1', (t) => t.replaceAll('가상방산', '[비공개 명칭]')).render(0).text;
  assert.ok(!delta.includes('가상방산'), 'resumed deltas are redacted too');

  // 10) 기록 표현: 사용자 판단(버림·넘김)을 남기고, 길면 문항별 최신 본문만 남긴다. 앞부분은 기록이 늘어도 바뀌지 않는다.
  const ev = (rowid, type, extra = {}) => ({ rowid, question: '지원동기', type, textBefore: null, textAfter: null, detail: {}, analysis: null, ...extra });
  const log = [
    ev(1, 'draft_generated', { textAfter: '첫 초안 '.repeat(50) }),
    ev(2, 'revision_requested', { detail: { instruction: '두 번째 문단을 줄여줘' } }),
    ev(3, 'revision_proposed', { textAfter: 'x', detail: { changeSummary: ['문단 축약'] }, analysis: { changes: [{ op: 'replace', before: '긴 문장', after: '짧은 문장', zone: '본문' }] } }),
    ev(4, 'revision_discarded'),
    ev(5, 'suggestion_dismissed', { detail: { category: '표현·문체', original: '열정', replacement: '관심', reason: '상투어' } }),
    ev(6, 'draft_generated', { textAfter: '새 초안 본문' }),
  ];
  assert.ok(renderEssayEvent(log[2]).includes('“긴 문장” → “짧은 문장”'));
  assert.ok(renderEssayEvent(log[4]).includes('넘겼다(원하지 않음)') && renderEssayEvent(log[4]).includes('“열정” → “관심”'));
  const fullText = renderEssayTranscript(log);
  assert.ok(renderEssayTranscript(log.slice(0, 3)) === fullText.slice(0, renderEssayTranscript(log.slice(0, 3)).length), 'appending events keeps the earlier rendering as a prefix');
  const compact = renderEssayTranscript(log, 300);
  assert.ok(compact.includes('이후 새 글로 대체되어 본문 생략') && compact.includes('새 초안 본문') && !compact.includes('첫 초안 첫 초안'));
  assert.ok(compact.includes('두 번째 문단을 줄여줘') && compact.includes('수정본을 버렸다') && compact.includes('“열정” → “관심”'), 'user decisions survive compaction');
  const tiny = renderEssayTranscript(log, 60);
  assert.ok(tiny.length <= 60 + 40 && tiny.startsWith('(오래된 기록') && tiny.includes('새 초안 본문'), 'over budget it drops the oldest events and says so');

  console.log('PASS conversation: fresh session with header+history, resumed turns send only new history+instruction, header change/resume failure/oversize start a new session from the same history, Codex stateless with earlier turns, cross-model handoff via history, usage with cache hits, serialized turns, per-turn token limit from the model-reported window, capped earlier turns, redacted history, stable/compacted/trimmed transcript');
})().catch((error) => { console.error(error); process.exitCode = 1; });
