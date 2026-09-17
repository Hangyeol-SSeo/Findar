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

// 공고 요약/매칭(lib/summarizer.ts, lib/matcher.ts)에 한해 FreeRide(https://github.com/Shaivpidadi/FreeRideV3)
// 무료 티어 게이트웨이로 라우팅할지 여부. 이력서 분석(lib/profile.ts)은 개인정보가 포함돼 있어
// 이 스위치와 무관하게 항상 Anthropic API를 그대로 사용한다.
const USE_FREERIDE = process.env.USE_FREERIDE === "true";
const FREERIDE_BASE_URL = process.env.FREERIDE_BASE_URL || "http://localhost:11343";
const FREERIDE_MODEL = process.env.FREERIDE_MODEL || "freeride/coding";
const ANTHROPIC_SUMMARIZE_MODEL = "claude-haiku-4-5-20251001";

// summarizeJob(Batch)/matchJob(Batch)의 query() options에 스프레드해서 쓰는 model/env 조각.
// model을 claude-* 그대로 두면 FreeRide가 실제 Anthropic API로 그냥 패스스루하므로,
// 절감 효과를 보려면 반드시 freeride/* 별칭으로 바꿔야 한다.
export function getSummaryModelOptions(): {
  model: string;
  env?: Record<string, string | undefined>;
} {
  if (USE_FREERIDE) {
    return {
      model: FREERIDE_MODEL,
      env: { ...process.env, ANTHROPIC_BASE_URL: FREERIDE_BASE_URL },
    };
  }
  return { model: ANTHROPIC_SUMMARIZE_MODEL };
}
