import { splitSentences } from "./essay-diff";

// 자기소개서 문장과 구성에 관한 공통 규칙. 실제로 생성·첨삭된 글에서 반복된 문제를 막기 위해 만들었다:
// 개인 경험이 주장마다 한 줄씩 끼워져 억지스럽고, 조사 사실을 몰아넣고, "다만"과 "생각합니다/봅니다"가
// 반복되며, "한 증권사"처럼 출처를 흐리는 표현이 나왔다. 작성(WRITING_RULES)과 첨삭 프롬프트가 함께 쓴다.
export const STYLE_RULES = `[문장과 구성]
한 문단에는 하나의 생각만 담고, 각 문단이 앞 문단의 결론을 이어받아 하나의 논지로 흐르게 한다.
개인 경험과 성향은 논지를 실제로 뒷받침할 때만 쓰고, 한 문단(한 흐름)에 모아 상황·판단·행동·변화로 서술한다. 주장마다 경험을 한 줄씩 덧붙이지 않고, 이미 한 말을 되풀이해 확인하는 데 그치는 경험은 넣지 않는다.
개인 경험을 회사나 산업의 문제에 그대로 빗대지 않는다. 경험은 이 일에 관심을 두게 된 이유나 그 경험으로 생긴 습관으로 연결한다.
성향·태도에 대한 서술은 함께 쓴 경험과 모순되지 않아야 한다.
조사 자료는 논지에 꼭 필요한 것만 쓴다. "참고하는 수준"이라는 단서를 달아야 하는 사실은 넣지 않는다. 한 문장에 날짜·수치·기관을 여러 개 몰아넣지 않는다.
"한 증권사", "한 기업"처럼 출처를 익명으로 흐리지 않는다. 지원 회사의 사실이면 회사명을 밝히고, 지원 회사의 약점을 평가하듯 쓰지 않는다. 다른 회사의 사례는 꼭 필요할 때만 이름을 밝혀 쓴다.
"다만", "물론" 같은 단서는 글 전체에서 두 번 이하로 꼭 필요한 곳에만 쓴다. 조건은 해당 문장 안에서 간결하게 밝히고, 주장마다 단서 문장을 따로 덧붙이지 않는다.
"생각합니다", "봅니다", "판단합니다"는 핵심 주장에만 쓰고 사실과 근거는 단정형으로 쓴다. 같은 끝맺음을 연달아 반복하지 않는다.
"값이 붙는다", "반대편에서 압력을 준다"처럼 뜻이 흐린 은유 대신 수익·비용·위험처럼 구체적인 말을 쓴다. 한 문장에는 되도록 한 가지 내용만 담는다.`;

const HEDGE = /다만|물론/g;
const OPINION_ENDING = /(?:생각합니다|봅니다|판단합니다|느낍니다)[.!?。]?$/;
// "한 회사 안에"처럼 수량을 뜻하는 경우는 걸리지 않도록, 조사가 바로 붙은 익명 표현만 찾는다.
const ANONYMIZED_SOURCE = /한 (?:증권사|기업|금융사|금융회사|은행|운용사|자산운용사)(?:의|는|은|가|에서|도)(?=\s)/g;
const LONG_SENTENCE = 110;

// AI 호출 없이 문체 문제를 찾는다. 결과는 편집 단계 프롬프트에 넣거나(추가 호출 없음) 사용자 검토 메모로 보여준다.
export function lintEssayStyle(text: string): string[] {
  const notes: string[] = [];
  const sentences = splitSentences(text).map((s) => s.trim()).filter(Boolean);
  if (!sentences.length) return notes;

  const hedges = text.match(HEDGE)?.length ?? 0;
  if (hedges > 2) notes.push(`‘다만’·‘물론’ 같은 단서가 ${hedges}번 나옵니다. 꼭 필요한 곳만 남기면 주장이 더 분명해집니다.`);

  const opinions = sentences.filter((s) => OPINION_ENDING.test(s)).length;
  if (opinions >= 5 && opinions / sentences.length > 0.25)
    notes.push(`‘생각합니다/봅니다/판단합니다’로 끝나는 문장이 ${opinions}개입니다. 사실과 근거는 단정형으로 쓰고 핵심 주장에만 남겨주세요.`);

  // 존댓말은 거의 모두 "~습니다"로 끝나므로 마지막 어절(예: "봅니다", "있습니다")끼리 비교한다.
  const endings = sentences.map((s) => s.replace(/[.!?。！？\s]+$/, "").split(/\s+/).at(-1) ?? "");
  let run = 1, longestRun = 1, runEnding = "";
  for (let i = 1; i < endings.length; i++) {
    run = endings[i] === endings[i - 1] ? run + 1 : 1;
    if (run > longestRun) { longestRun = run; runEnding = endings[i]; }
  }
  if (longestRun >= 3) notes.push(`‘${runEnding}’로 끝나는 문장이 ${longestRun}개 연달아 나옵니다. 끝맺음을 바꿔 리듬을 살려주세요.`);

  const anonymized = [...new Set(text.match(ANONYMIZED_SOURCE) ?? [])];
  if (anonymized.length)
    notes.push(`‘${anonymized.join("’, ‘")}’처럼 출처를 익명으로 흐린 표현이 있습니다. 지원 회사의 사실이면 회사명을 밝히고, 아니라면 빼는 편이 자연스럽습니다.`);

  const long = sentences.filter((s) => Array.from(s).length > LONG_SENTENCE).length;
  if (long) notes.push(`${LONG_SENTENCE}자가 넘는 긴 문장이 ${long}개 있습니다. 한 문장에 한 가지 내용만 담도록 나눠주세요.`);

  return notes;
}

// 사용자에게 보여줄 검토 메모 형태.
export function styleReviewNotes(text: string): string[] {
  return lintEssayStyle(text).map((note) => `문체 점검: ${note}`);
}
