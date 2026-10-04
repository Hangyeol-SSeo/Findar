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
const { lintEssayStyle, styleReviewNotes, STYLE_RULES } = load('essay-style');

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
console.log('PASS hedge/opinion-ending/anonymized-source/long-sentence detection, no false positives on clean prose, prompt rules');
