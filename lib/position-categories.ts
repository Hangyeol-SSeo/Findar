const CATEGORY_RULES: [string, string[]][] = [
  ["IT/개발", ["IT", "개발", "전산", "시스템", "인프라", "플랫폼", "데이터"]],
  ["운용", ["운용", "펀드", "자산운용", "채권", "주식"]],
  ["리서치/분석", ["리서치", "분석", "애널리스트", "RA", "Research"]],
  ["투자/IB", ["투자", "IB", "인수", "M&A", "IPO", "기업금융"]],
  ["경영/기획", ["경영", "기획", "전략"]],
  ["영업/RM", ["영업", "RM", "세일즈", "컨설팅", "컨설턴트", "마케팅", "브랜드", "리테일"]],
  ["디자인/UX", ["UI", "UX", "디자인", "콘텐츠"]],
  ["법무/컴플라이언스", ["법무", "법률", "변호사", "준법", "컴플라이언스", "Counsel"]],
  ["리스크", ["리스크", "위험관리", "리스크관리"]],
  ["재무/회계", ["재무", "회계", "자금", "결제"]],
  ["인사/지원", ["인사", "총무", "HR", "지원", "인턴"]],
  ["퇴직연금", ["퇴직연금"]],
  ["부동산", ["부동산"]],
  ["트레이딩", ["트레이더", "트레이딩", "매매", "딜링"]],
];

export function categorizePosition(position: string): string {
  for (const [category, keywords] of CATEGORY_RULES) {
    if (keywords.some((kw) => position.includes(kw))) {
      return category;
    }
  }
  return "기타";
}

export function categorizePositions(positions: string[]): string[] {
  const categories = new Set<string>();
  for (const pos of positions) {
    categories.add(categorizePosition(pos));
  }
  return Array.from(categories);
}
