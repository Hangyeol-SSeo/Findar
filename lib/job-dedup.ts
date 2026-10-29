import { hangulizeLatin, normalizeCompanyName } from "./company-normalize";

// 같은 공고가 금투협 게시판과 회사 채용 사이트(그리팅·사람인)에 함께 올라온 경우를 찾는다. AI 없음, 요약 전에 판정한다.
// 실제로 겹친 예: KIS자산평가 "[KIS자산평가] 금융컨설팅본부 솔루션실 신입/경력(1년 이상) 채용 공고"(금투협) ↔
// "… 신입/경력 채용 공고"(그리팅), NICE신용평가 "신용평가 애널리스트"(둘 다 마감 11/9).
// 판정: 회사 키가 같고, 공고 링크가 같거나, 제목 2-gram Dice가 마감일이 ±1일 안이면 0.7 이상(또는 한쪽 제목이 다른 쪽에 통째로
// 들어 있음), 마감일을 모르면 0.85 이상.
// 마감일이 둘 다 있는데 이틀 이상 다르면 다른 공고(재공고·기간 연장 공고)로 본다. 같은 채용 사이트의 서로 다른 공고 주소도
// 다른 공고다 — BNK투자증권 "CM부 백오피스"와 "주식운용 백오피스"(마감 하루 차이)가 제목만으로는 0.6이 나왔다.

export interface DedupPosting {
  seq: string;
  company: string;
  title: string;
  deadline: string; // YYYY-MM-DD 또는 ""
  url: string;
}

const SIMILAR_WITH_DEADLINE = 0.7;
const SIMILAR_WITHOUT_DEADLINE = 0.85;

/** 회사 비교 키: "(구. …)" 제거 → normalizeCompanyName → 영문 약어를 한글로(KB자산운용 ↔ 케이비자산운용). */
export function companyKey(name: string): string {
  return hangulizeLatin(normalizeCompanyName(name.replace(/\(\s*구[.\s][^)]*\)/g, ""))).toLowerCase();
}

const BOILERPLATE = /채용\s*공고|채용|공고|모집|안내|공개|수시|상시/g;

/** 제목 비교 키: [회사명] 머리말, 마감 표기("(~10/31)", "기간연장"), 상투어, 기호를 뺀다. */
export function titleKey(title: string, company: string): string {
  const companyWords = [normalizeCompanyName(company), company.trim()].filter(Boolean);
  let text = title
    .replace(/[[【［(（<〈「]\s*[^\]】］)）>〉」]*?(?:~|마감|연장|D-\d)[^\]】］)）>〉」]*[\]】］)）>〉」]/g, " ")
    .replace(/^\s*[[【［]\s*[^\]】］]+[\]】］]\s*/, " ")
    .replace(/기간\s*연장/g, " ");
  for (const word of companyWords) text = text.split(word).join(" ");
  return text.replace(BOILERPLATE, " ").replace(/[^0-9a-zA-Z가-힣]+/g, "").toLowerCase();
}

function bigrams(text: string): Map<string, number> {
  const grams = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i++) {
    const gram = text.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

/** 2-gram Dice 계수(0~1). 한 글자 이하 키는 완전히 같을 때만 1. */
export function titleSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let total = 0;
  for (const n of ga.values()) total += n;
  for (const n of gb.values()) total += n;
  if (total === 0) return 0;
  let shared = 0;
  for (const [gram, n] of ga) shared += Math.min(n, gb.get(gram) ?? 0);
  return (2 * shared) / total;
}

function dayDiff(a: string, b: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return null;
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

// 공고 한 건을 가리키는 주소(공고 번호가 들어 있음)만 비교 키로 쓴다. 채용 사이트 첫 화면(…/ko/home)은 회사마다 하나라
// 같은 공고라는 근거도, 다른 공고라는 근거도 못 된다(KIS자산평가 금투협 공고의 사이트바로가기가 …/ko/home이었다).
// 그리팅 공고 주소는 언어 경로가 있기도 없기도 하다(금투협 "…/o/241147", 목록 "…/ko/o/241147").
function postingUrlKey(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "").replace(/^\/(?:ko|en|ja)(?=\/o\/)/, "");
    if (!/\d{3,}/.test(`${path}${u.search}`)) return "";
    return `${u.hostname.replace(/^www\./, "")}${path}${u.search}`.toLowerCase();
  } catch {
    return "";
  }
}

export type DuplicateReason = "url" | "title+deadline" | "title";

export function duplicateReason(a: DedupPosting, b: DedupPosting): DuplicateReason | null {
  if (a.seq === b.seq) return null;
  if (companyKey(a.company) !== companyKey(b.company)) return null;
  const urlA = postingUrlKey(a.url);
  const urlB = postingUrlKey(b.url);
  if (urlA && urlA === urlB) return "url";
  if (urlA && urlB && urlA.split("/")[0] === urlB.split("/")[0]) return null;
  const keyA = titleKey(a.title, a.company);
  const keyB = titleKey(b.title, b.company);
  const similarity = titleSimilarity(keyA, keyB);
  const diff = dayDiff(a.deadline, b.deadline);
  // 마감일이 같으면 한쪽 제목이 다른 쪽을 그대로 품는 것도 같은 공고로 본다: IBK 채용 사이트
  // "투자분석부(경제, 시황/투자전략 애널리스트) 채용 공고" ↔ 금투협 "[IBK투자증권] 투자분석부 채용 공고"(둘 다 10/30 마감).
  const [shorter, longer] = keyA.length <= keyB.length ? [keyA, keyB] : [keyB, keyA];
  const contained = shorter.length >= 4 && longer.includes(shorter);
  if (diff !== null) return diff <= 1 && (similarity >= SIMILAR_WITH_DEADLINE || contained) ? "title+deadline" : null;
  return similarity >= SIMILAR_WITHOUT_DEADLINE ? "title" : null;
}

/** candidates 중 posting과 같은 공고(처음 찾은 것). */
export function findDuplicate(posting: DedupPosting, candidates: DedupPosting[]): { match: DedupPosting; reason: DuplicateReason } | null {
  const key = companyKey(posting.company);
  for (const candidate of candidates) {
    if (companyKey(candidate.company) !== key) continue;
    const reason = duplicateReason(posting, candidate);
    if (reason) return { match: candidate, reason };
  }
  return null;
}
