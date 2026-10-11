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
근거는 evidence에만 둔다. 본문에 공고·협회·홈페이지·조사 과정을 출처로 밝히지 않는다("공고에 따르면", "공고상", "게시된 채용공고", "조사한 바에 따르면", "~로 알고 있습니다", "짐작합니다"). 회사·직무에 대한 이해는 지원자 자신의 말로 쓴다.
경험과 직무 사이의 거리를 변명하지 않는다("실무와는 다르지만", "실무 경험은 아니지만", "접점이 있다고 생각합니다"). 연결이 약한 경험은 빼거나, 직무와 실제로 닿는 내용만 남긴다.
"다만", "물론" 같은 단서는 글 전체에서 두 번 이하로 꼭 필요한 곳에만 쓴다. 조건은 해당 문장 안에서 간결하게 밝히고, 주장마다 단서 문장을 따로 덧붙이지 않는다.
"생각합니다", "봅니다", "판단합니다"는 핵심 주장에만 쓰고 사실과 근거는 단정형으로 쓴다. 같은 끝맺음을 연달아 반복하지 않는다.
"값이 붙는다", "반대편에서 압력을 준다"처럼 뜻이 흐린 은유 대신 수익·비용·위험처럼 구체적인 말을 쓴다. 한 문장에는 되도록 한 가지 내용만 담는다.`;

export const HEDGE = /다만|물론/g;
export const OPINION_ENDING = /(?:생각합니다|봅니다|판단합니다|느낍니다)[.!?。]?$/;
// "한 회사 안에"처럼 수량을 뜻하는 경우는 걸리지 않도록, 조사가 바로 붙은 익명 표현만 찾는다.
export const ANONYMIZED_SOURCE = /한 (?:증권사|기업|금융사|금융회사|은행|운용사|자산운용사)(?:의|는|은|가|에서|도)(?=\s)/g;
const LONG_SENTENCE = 110;

// 본문에서 출처·조사 과정을 드러내는 표현. 실제 초안에 "금융투자협회에 게시된 이 회사의 채용공고가 … 요구하는 점도",
// "공고상 RA의 업무는", "~조직으로 알고 있습니다", "~것으로 짐작합니다"가 나와 사용자가 매번 고쳤다. 근거는 evidence에만 둔다.
export const META_SOURCE = /(?:채용\s?)?공고(?:에\s?따르면|상(?=\s)|가\s?요구하는|(?:에서|에는)\s?[^.\n]{0,20}?(?:요구|밝힌|제시한|명시한|강조한|안내한|언급한)|에\s?(?:나온|명시된|적힌))|(?:협회|홈페이지|사이트)에\s?게시된|게시된\s?(?:이\s?회사의\s?)?(?:채용\s?)?공고|조사한\s?바(?:에\s?따르면|로는)?|(?:으?로|걸로)\s?(?:알고\s?있습니다|파악됩니다|파악하고\s?있습니다)|짐작(?:합니다|됩니다)/g;
// 경험과 직무의 거리를 변명하는 문장. 맥락 감사가 억지 연결을 지적하면 모델이 소재를 빼는 대신 이런 단서를 붙여 통과했다.
export const DISCLAIMER = /(?:실무|업무|직무)(?:와|과)는\s?(?:다르지만|거리가\s?있지만|무관하지만|성격이\s?다르지만)|(?:실무|직무)\s?경험(?:은|이)\s?아니(?:지만|라)|직접(?:적인)?\s?(?:관련|연관)(?:은|이)\s?(?:없지만|적지만)|접점이\s?있다고\s?(?:생각합니다|봅니다)/g;

export type StyleIssueCode = "hedge" | "opinion_ending" | "repeated_ending" | "anonymized_source" | "long_sentence" | "meta_source" | "disclaimer";
export interface StyleIssue { code: StyleIssueCode; note: string }

const unique = (matches: RegExpMatchArray | null) => [...new Set(matches ?? [])];

// 본문의 출처 언급·변명 표현. 같은 구절이 이미 있던 글(allowedIn, 예: 고쳐쓰기의 현재 글)에 있으면 새로 생긴 것이 아니라 뺀다.
export function metaPhrases(text: string, allowedIn = ""): string[] {
  return [...unique(text.match(META_SOURCE)), ...unique(text.match(DISCLAIMER))].filter((p) => !allowedIn.includes(p));
}

// 작성·고쳐쓰기의 검증에서 던져 한 번의 수정 호출로 넘긴다. 수정 뒤에도 남으면 답변은 버리지 않고 검토 메모 맨 앞에 둔다.
export class MetaPhraseError extends Error {
  constructor(readonly phrases: string[]) {
    super(`본문에 출처·조사 과정을 드러내거나 직무와의 거리를 변명하는 표현이 있습니다: ${phrases.map((p) => `“${p}”`).join(", ")}. 근거는 evidence에만 두고 본문은 지원자 자신의 말로 쓰세요. 변명이 필요한 경험은 빼거나 직무와 실제로 닿는 내용만 남기세요.`);
  }
}

export function assertNoMetaPhrases(text: string, allowedIn = ""): void {
  const phrases = metaPhrases(text, allowedIn);
  if (phrases.length) throw new MetaPhraseError(phrases);
}

export function metaPhraseNotes(phrases: string[]): string[] {
  return phrases.map((p) => `표현 확인: “${p}” — 출처·조사 과정이나 직무와의 거리를 드러내는 표현입니다. 지우거나 자신의 말로 바꿔주세요.`);
}

// AI 호출 없이 문체 문제를 찾는다. 결과는 편집 단계 프롬프트에 넣거나(추가 호출 없음) 사용자 검토 메모로 보여준다.
// code는 작성 기록(essay-log)이 수정 전후로 어떤 문제가 사라지고 생겼는지 비교하는 데 쓴다.
export function inspectEssayStyle(text: string): StyleIssue[] {
  const issues: StyleIssue[] = [];
  const sentences = splitSentences(text).map((s) => s.trim()).filter(Boolean);
  if (!sentences.length) return issues;

  const hedges = text.match(HEDGE)?.length ?? 0;
  if (hedges > 2) issues.push({ code: "hedge", note: `‘다만’·‘물론’ 같은 단서가 ${hedges}번 나옵니다. 꼭 필요한 곳만 남기면 주장이 더 분명해집니다.` });

  const opinions = sentences.filter((s) => OPINION_ENDING.test(s)).length;
  if (opinions >= 5 && opinions / sentences.length > 0.25)
    issues.push({ code: "opinion_ending", note: `‘생각합니다/봅니다/판단합니다’로 끝나는 문장이 ${opinions}개입니다. 사실과 근거는 단정형으로 쓰고 핵심 주장에만 남겨주세요.` });

  // 존댓말은 거의 모두 "~습니다"로 끝나므로 마지막 어절(예: "봅니다", "있습니다")끼리 비교한다.
  const endings = sentences.map((s) => s.replace(/[.!?。！？\s]+$/, "").split(/\s+/).at(-1) ?? "");
  let run = 1, longestRun = 1, runEnding = "";
  for (let i = 1; i < endings.length; i++) {
    run = endings[i] === endings[i - 1] ? run + 1 : 1;
    if (run > longestRun) { longestRun = run; runEnding = endings[i]; }
  }
  if (longestRun >= 3) issues.push({ code: "repeated_ending", note: `‘${runEnding}’로 끝나는 문장이 ${longestRun}개 연달아 나옵니다. 끝맺음을 바꿔 리듬을 살려주세요.` });

  const anonymized = [...new Set(text.match(ANONYMIZED_SOURCE) ?? [])];
  if (anonymized.length)
    issues.push({ code: "anonymized_source", note: `‘${anonymized.join("’, ‘")}’처럼 출처를 익명으로 흐린 표현이 있습니다. 지원 회사의 사실이면 회사명을 밝히고, 아니라면 빼는 편이 자연스럽습니다.` });

  const long = sentences.filter((s) => Array.from(s).length > LONG_SENTENCE).length;
  if (long) issues.push({ code: "long_sentence", note: `${LONG_SENTENCE}자가 넘는 긴 문장이 ${long}개 있습니다. 한 문장에 한 가지 내용만 담도록 나눠주세요.` });

  const meta = unique(text.match(META_SOURCE));
  if (meta.length)
    issues.push({ code: "meta_source", note: `‘${meta.join("’, ‘")}’처럼 공고·조사 과정을 출처로 드러내는 표현이 있습니다. 근거를 밝히는 말은 빼고 지원자 자신의 말로 써주세요.` });
  const disclaimers = unique(text.match(DISCLAIMER));
  if (disclaimers.length)
    issues.push({ code: "disclaimer", note: `‘${disclaimers.join("’, ‘")}’처럼 경험과 직무의 거리를 변명하는 표현이 있습니다. 연결이 약한 경험은 빼거나 직무와 실제로 닿는 내용만 남겨주세요.` });

  return issues;
}

export function lintEssayStyle(text: string): string[] {
  return inspectEssayStyle(text).map((issue) => issue.note);
}

// 사용자에게 보여줄 검토 메모 형태. 출처 언급·변명 표현은 검증(MetaPhraseError)이 따로 다뤄 여기서는 겹쳐 보이지 않게 뺀다.
export function styleReviewNotes(text: string): string[] {
  return inspectEssayStyle(text).filter((i) => i.code !== "meta_source" && i.code !== "disclaimer").map((i) => `문체 점검: ${i.note}`);
}
