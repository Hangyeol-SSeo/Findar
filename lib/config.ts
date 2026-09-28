export const CRAWL_PAGES = 5; // 크롤링할 페이지 수 (1페이지 = 10건)
export const REMATCH_SKIP_THRESHOLD = 35; // 이 점수 이하인 공고는 이력서 변경 시 재매칭 스킵
export const REMATCH_BATCH_SIZE = 10; // 재매칭 시 한 번에 처리할 공고 수
export const SUMMARIZE_BATCH_SIZE = 5; // 신규 공고 AI 요약 시 한 번에 처리할 공고 수

export const DART_CORP_CODE_REFRESH_DAYS = 30; // DART 법인코드 전체 목록 재다운로드 주기

// 기업 리서치 섹션별 재생성 주기(일). 정적인 정보일수록 길게, 뉴스처럼 빨리 바뀌는
// 정보는 짧게 잡는다 — 짧다고 자동으로 재생성되는 건 아니고(항상 수동 트리거),
// "새로고침" 버튼을 눌렀을 때 이 기간이 안 지났으면 재호출 없이 캐시를 그대로 보여준다.
export const COMPANY_SECTION_TTL_DAYS: Record<string, number> = {
  overview: 180,
  culture: 180,
  governance_structure: 90,
  financials: 100,
  news: 3,
};
