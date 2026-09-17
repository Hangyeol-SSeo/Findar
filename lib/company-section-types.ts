// company-research.ts는 @anthropic-ai/claude-agent-sdk(Node 전용)를 임포트하므로 클라이언트
// 컴포넌트에서 직접 쓸 수 없다. 섹션 타입/라벨처럼 서버·클라이언트 양쪽이 공유해야 하는
// 순수 값만 이 파일에 따로 둔다 (lib/application-status.ts와 동일한 패턴).
export const COMPANY_SECTION_TYPES = [
  "overview",
  "culture",
  "governance_structure",
  "financials",
  "news",
] as const;

export type CompanySectionType = (typeof COMPANY_SECTION_TYPES)[number];

export const COMPANY_SECTION_LABELS: Record<CompanySectionType, string> = {
  overview: "사업 개요",
  culture: "인재상·조직문화",
  governance_structure: "경영진·지배구조",
  financials: "재무 상태",
  news: "최근 뉴스·행보",
};
