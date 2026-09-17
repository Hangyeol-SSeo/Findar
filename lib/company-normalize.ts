// 회사명 정규화. KOFIA 공고에는 회원사에 대한 고유 ID가 없고 자유 텍스트뿐이라(lib/crawler.ts
// 참고), "삼성증권"과 "삼성증권(주)"처럼 같은 회사가 다른 문자열로 나타날 수 있다. 이 함수가
// companies 테이블의 유일한 정규화 규칙이므로 서버/클라이언트 어디서든 이 함수만 써야 한다.
export function normalizeCompanyName(raw: string): string {
  return raw
    .replace(/\(주\)|㈜|주식회사/g, "")
    .replace(/\s+/g, "")
    .trim();
}
