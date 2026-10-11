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
const { lintEssayStyle, styleReviewNotes, STYLE_RULES, metaPhrases, assertNoMetaPhrases, MetaPhraseError, metaPhraseNotes } = load('essay-style');

// 실제로 문제가 됐던 글의 특징: 단서 반복, 의견형 끝맺음 반복, 익명 출처, 긴 문장.
const awkward = [
  '저는 기술 혁신이 증권업을 없애기보다, 어떤 일에 값이 붙는지를 바꾼다고 생각합니다. 수익의 원천은 판단과 신뢰로 옮겨 간다고 봅니다.',
  '국내에서는 2026년 1월 15일 국회 본회의에서 전자증권법·자본시장법 개정안이 통과되어 분산원장 기반 토큰증권 발행이 법적으로 가능해졌고, 시행은 2027년 1월께로 잠정 예정되어 있으며 투자계약증권의 증권사 유통도 허용되었습니다. 다만 세부 제도는 지켜볼 부분이라고 생각합니다.',
  '다만 미국의 움직임은 참고하는 수준에서 보고 있다고 판단합니다. 다만 투자를 공부하며 얻은 생각은 다르다고 봅니다.',
  '한 증권사의 2025년 연결 기준 재무 분석에서는 영업수익의 80% 이상이 트레이딩성 자산에서 발생합니다. 다만 위험도 커진다고 생각합니다. 그래서 운영 역량이 중요하다고 봅니다.',
].join('\n\n');
const notes = lintEssayStyle(awkward);
assert.ok(notes.some((n) => n.includes('다만') && n.includes('4번')), 'hedge overuse must be reported with count');
assert.ok(notes.some((n) => n.includes('생각합니다/봅니다/판단합니다')), 'repeated opinion endings must be reported');
assert.ok(notes.some((n) => n.includes('한 증권사의')), 'anonymized source must be reported');
assert.ok(notes.some((n) => n.includes('긴 문장')), 'overlong sentence must be reported');

// 다듬은 글: 단서 없음, 끝맺음 다양, 수량 표현("한 회사 안에")은 익명 출처로 오인하지 않는다.
const clean = [
  '기술 혁신은 증권업을 없애기보다 증권사가 무엇으로 수익을 내는지를 바꿀 것이라고 생각합니다. 지금까지 증권사는 발행부터 자문까지를 한 회사 안에 묶어 제공했습니다.',
  '기술은 이 묶음을 단계별로 나누고 각 단계의 비용을 드러냅니다. 그러면 거래를 연결하는 일만으로는 수수료를 지키기 어렵습니다.',
  '제가 위험 관리에 관심을 두게 된 데에는 투자 실패가 있습니다. 그 뒤로 기대 수익보다 감당할 위험을 먼저 묻는 습관이 생겼습니다.',
].join('\n\n');
assert.equal(lintEssayStyle(clean).length, 0, `a clean essay must not produce style notes: ${lintEssayStyle(clean).join(' / ')}`);

assert.ok(styleReviewNotes(awkward).every((n) => n.startsWith('문체 점검: ')));
assert.equal(lintEssayStyle('').length, 0);
assert.ok(lintEssayStyle('위험을 먼저 봅니다. 수익은 나중에 봅니다. 근거도 함께 봅니다.').some((n) => n.includes('‘봅니다’로 끝나는 문장이 3개')), 'same final word three times in a row must be reported');
for (const rule of ['한 문단(한 흐름)에 모아', '두 번 이하', '익명으로 흐리지 않는다', '모순되지 않아야'])
  assert.ok(STYLE_RULES.includes(rule), `STYLE_RULES must keep: ${rule}`);
// 출처 언급·변명 표현: 사용자가 실제로 지적한 초안 문장들(마스터자산운용·DS투자증권).
const rejected = [
  '마스터자산운용은 2024년 3월에 설립된 사모운용사로, 임직원이 10명 규모로 늘어 가는 조직으로 알고 있습니다.',
  '한 사람이 맡는 업무의 범위도 넓을 것으로 짐작합니다.',
  '금융투자협회에 게시된 이 회사의 채용공고가 책임감 강하고 꼼꼼한 업무태도를 요구하는 점도 맞닿아 있다고 느꼈습니다.',
  '공고에서 신입에게 안내한 3개월 인턴 기간은 기회라고 생각합니다.',
  '공고상 RA의 업무는 데이터 수집·정리입니다.',
  '제가 조사한 바에 따르면, 마스터자산운용도 인원 규모가 크지 않은 회사인걸로 파악됩니다.',
  '이 경험은 펀드회계 실무와는 다르지만, 결과가 어긋난 지점을 찾아가는 방식에서는 접점이 있다고 생각합니다.',
  '도서관에서 익힌 확인 습관은 회계 실무 경험이 아니라, 자료와 실제 내역을 함께 살피려는 태도로 이어가겠습니다.',
];
for (const sentence of rejected) assert.ok(metaPhrases(sentence).length, `must flag: ${sentence}`);
const notesForRejected = lintEssayStyle(rejected.join(' '));
assert.ok(notesForRejected.some((n) => n.includes('출처로 드러내는')) && notesForRejected.some((n) => n.includes('변명하는')));
assert.ok(!styleReviewNotes(rejected.join(' ')).some((n) => n.includes('출처로 드러내는') || n.includes('변명하는')), 'meta notes are reported by validation, not duplicated as style notes');
// 사용자가 확정한 최종본 문장들은 걸리지 않아야 한다.
const finalEssay = [
  '운용지원팀은 운용역의 판단이 주문과 배분, 결제, 회계를 거쳐 펀드의 숫자로 남고, 그 숫자로 다시 성과가 평가되는 과정 전체를 다루는 자리입니다.',
  '평소 신규 상장 종목과 상장을 앞둔 기업, 규모 있는 비상장 기업을 눈여겨봐 왔기에 IPO를 중심으로 운용하는 마스터자산운용에 자연스럽게 관심이 갔습니다.',
  '인원이 많지 않은 운용사의 운용지원팀이라면 펀드회계부터 운용지시, 각종 보고까지 한 사람이 맡는 업무의 폭이 넓을 것입니다.',
  '이런 조직에는 한 가지 일만 잘하는 사람보다, 팀에 비어 있는 곳을 먼저 보고 손을 보탤 수 있는 사람이 필요하다고 생각합니다.',
  '기록과 실제가 어긋나면 결국 누군가 그 불편을 떠안는다는 것을 그때 배웠습니다.',
  '모르는 부분은 짐작으로 처리하지 않고 확인한 뒤 진행하며, 숫자가 어긋난 것을 발견하면 먼저 공유하겠습니다.',
].join(' ');
assert.equal(metaPhrases(finalEssay).length, 0, `final essay must pass: ${metaPhrases(finalEssay).join(', ')}`);
assert.equal(metaPhrases(clean).length, 0);
// 고쳐쓰기: 현재 글에 이미 있던 표현은 새로 생긴 것으로 보지 않는다.
assert.equal(metaPhrases(`${rejected[4]} 새 문장입니다.`, rejected[4]).length, 0);
assert.throws(() => assertNoMetaPhrases(rejected[2]), (e) => e instanceof MetaPhraseError && e.phrases.includes('협회에 게시된') && /evidence에만/.test(e.message));
assert.doesNotThrow(() => assertNoMetaPhrases(finalEssay));
assert.ok(metaPhraseNotes(['공고상']).every((n) => n.startsWith('표현 확인: “공고상”')));
for (const rule of ['근거는 evidence에만 둔다', '거리를 변명하지 않는다'])
  assert.ok(STYLE_RULES.includes(rule), `STYLE_RULES must keep: ${rule}`);
console.log('PASS hedge/opinion-ending/anonymized-source/long-sentence detection, no false positives on clean prose, prompt rules, meta-source/disclaimer blocking');
