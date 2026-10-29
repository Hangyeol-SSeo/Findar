// GET /api/watchlist 응답(설정 → 수집 범위). 클라이언트도 쓰므로 서버 모듈을 들이지 않는다.

export type WatchRunStatus = "ok" | "empty" | "failed" | "blocked";

export interface WatchlistSourceView {
  type: string;
  label: string;
  url: string;
  note: string;
  /** 지금 자동으로 공고를 받는 유형(그리팅·사람인 채용 사이트). 나머지는 바로가기로만 보인다. */
  collectable: boolean;
  lastRun: { status: WatchRunStatus; message: string; found: number; added: number; ranAt: number } | null;
}

export interface WatchlistCompanyView {
  name: string;
  segment: string;
  enabled: boolean;
  sources: WatchlistSourceView[];
}

export interface WatchlistResponse {
  companies: WatchlistCompanyView[];
}
