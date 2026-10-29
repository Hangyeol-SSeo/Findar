// 회사명 정규화. KOFIA 공고에는 회원사에 대한 고유 ID가 없고 자유 텍스트뿐이라(lib/crawler.ts
// 참고), "삼성증권"과 "삼성증권(주)"처럼 같은 회사가 다른 문자열로 나타날 수 있다. 이 함수가
// companies 테이블의 유일한 정규화 규칙이므로 서버/클라이언트 어디서든 이 함수만 써야 한다.
export function normalizeCompanyName(raw: string): string {
  return raw
    .replace(/\(주\)|㈜|주식회사/g, "")
    .replace(/\s+/g, "")
    .trim();
}

// 영문 약어 상호는 DART와 KOFIA 공고가 서로 다르게 적는 경우가 많다(DS투자증권 ↔ 디에스투자증권, 케이비자산운용 ↔ KB자산운용).
const LETTER_NAMES: Record<string, string> = {
  A: "에이", B: "비", C: "씨", D: "디", E: "이", F: "에프", G: "지", H: "에이치", I: "아이", J: "제이", K: "케이", L: "엘", M: "엠",
  N: "엔", O: "오", P: "피", Q: "큐", R: "알", S: "에스", T: "티", U: "유", V: "브이", W: "더블유", X: "엑스", Y: "와이", Z: "제트",
};
export function hangulizeLatin(name: string): string {
  return name.replace(/[A-Za-z]+/g, (word) => [...word.toUpperCase()].map((c) => LETTER_NAMES[c] ?? c).join(""));
}
