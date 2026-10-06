const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const modules = {};
function load(name) {
  if (modules[name]) return modules[name];
  const exports = {};
  modules[name] = exports;
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(`lib/${name}.ts`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (id) => load(id.slice(2)) }, { filename: `lib/${name}.ts` });
  return exports;
}
const { analyzeEssayChange, locateInEssay, summarizeEssayEvents } = load('essay-log-analysis');
// vm 안에서 만든 배열·객체는 프로토타입이 달라 deepStrictEqual 대신 JSON으로 비교한다.
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);

const before = [
  '저는 위험 관리에 관심이 많습니다. 투자 실패를 겪었습니다.',
  '다만 수익도 중요하다고 생각합니다. 물론 비용도 봅니다. 다만 저는 위험을 먼저 봅니다.',
  '한 증권사의 사례를 보며 배웠습니다. 입사 후 리스크 체계를 다지겠습니다.',
].join('\n');
const after = [
  '저는 위험 관리에 관심이 많습니다. 투자 실패를 겪었습니다.',
  '수익도 중요합니다. 물론 비용도 봅니다. 저는 위험을 먼저 봅니다.',
  '입사 후 리스크 체계를 다지겠습니다.',
].join('\n');
const analysis = analyzeEssayChange(before, after);
assert.equal(analysis.sentencesBefore, 7);
assert.equal(analysis.unchangedSentences, 4, 'unchanged sentences are matched, not counted as changes');
assert.equal(analysis.changes.length, 3);
const [middle, second, ending] = analysis.changes;
assert.equal(middle.op, 'replace');
assert.equal(middle.paragraph, 2);
assert.equal(middle.zone, '본문');
assert.ok(middle.tags.includes('단서 제거'), `hedge removal must be tagged: ${middle.tags}`);
assert.ok(middle.tags.includes('의견형→단정형'), `opinion→assertive must be tagged: ${middle.tags}`);
assert.equal(second.paragraph, 2);
assert.ok(second.tags.includes('단서 제거'));
// 붙어 있는 수정과 삭제라도 문단이 다르면 문단별로 나눈다: 3문단의 익명 출처 문장은 삭제로 남는다.
assert.equal(ending.op, 'delete');
assert.equal(ending.paragraph, 3);
assert.equal(ending.zone, '마무리');
assert.ok(ending.tags.includes('익명 출처 제거'), `deleted sentence tags: ${ending.tags}`);
assert.ok(analysis.style.resolved.includes('hedge') && analysis.style.resolved.includes('anonymized_source'), `resolved style issues: ${analysis.style.resolved}`);
same(analysis.style.introduced, []);

const endingOnly = analyzeEssayChange('저는 위험을 먼저 봅니다.', '저는 위험을 먼저 확인합니다.');
same(endingOnly.changes[0].tags, ['어미만 변경', '의견형→단정형']);
const fresh = analyzeEssayChange('', '첫 문장입니다. 둘째 문장입니다.');
assert.equal(fresh.changes.length, 1);
assert.equal(fresh.changes[0].op, 'insert');
assert.equal(analyzeEssayChange(before, before).changes.length, 0);

same(locateInEssay(before, '한 증권사의 사례'), { zone: '마무리', paragraph: 3 });
assert.equal(locateInEssay(before, '없는 구절'), null);

// 요청 → 결과 → 반영/버림이 threadId로 이어지고, 첨삭 제안은 카테고리별로, 직접 수정은 위치·성격별로 묶인다.
let t = 0;
const ev = (type, actor, extra = {}) => ({ id: String(++t), seq: '1', question: 'Q', type, actor, threadId: null, textBefore: null, textAfter: null, detail: {}, analysis: null, createdAt: t, ...extra });
const summary = summarizeEssayEvents([
  ev('revision_requested', 'user', { threadId: 'a', detail: { instruction: '더 담백하게' } }),
  ev('revision_proposed', 'ai', { threadId: 'a', analysis }),
  ev('revision_accepted', 'user', { threadId: 'a', analysis }),
  ev('revision_requested', 'user', { threadId: 'b', detail: { instruction: '경험을 더 넣어줘' } }),
  ev('revision_proposed', 'ai', { threadId: 'b', analysis: fresh }),
  ev('revision_discarded', 'user', { threadId: 'b' }),
  ev('review_requested', 'user', { threadId: 'c', detail: { focus: '논리' } }),
  ev('review_received', 'ai', { threadId: 'c', detail: { suggestions: [{ category: '표현·문체' }, { category: '표현·문체' }, { category: '논리 흐름' }] } }),
  ev('suggestion_applied', 'user', { threadId: 'c', detail: { category: '표현·문체' } }),
  ev('suggestion_dismissed', 'user', { threadId: 'c', detail: { category: '논리 흐름', original: 'x', replacement: 'y', reason: 'z' } }),
  ev('manual_edit', 'user', { textBefore: before, textAfter: after, analysis }),
]);
same(summary.revisions, { proposed: 2, accepted: 1, discarded: 1, needsInfo: 0, failed: 0 });
const byThread = Object.fromEntries(summary.requests.map((r) => [r.threadId, r]));
assert.equal(byThread.a.outcome, '반영');
assert.ok(byThread.a.tags.includes('단서 제거'));
assert.equal(byThread.b.outcome, '버림');
assert.equal(byThread.b.text, '경험을 더 넣어줘');
assert.equal(byThread.c.kind, '첨삭 받기');
same(summary.suggestions['표현·문체'], { proposed: 2, applied: 1, dismissed: 0, untouched: 1 });
same(summary.suggestions['논리 흐름'], { proposed: 1, applied: 0, dismissed: 1, untouched: 0 });
assert.equal(summary.dismissedSuggestions[0].reason, 'z');
assert.equal(summary.manualEdits.count, 1);
assert.equal(summary.manualEdits.zones['본문'], 2);
assert.equal(summary.manualEdits.zones['마무리'], 1);
assert.equal(summary.manualEdits.styleResolved.hedge, 1);
assert.equal(summary.questions[0].events, 11);

console.log('PASS sentence-level change analysis (position, tags, style resolved/introduced), phrase location, request→outcome threading, suggestion stats, manual edit aggregation');
