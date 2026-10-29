// GET /api/season-alerts 응답(보드 위 공채 소식 알림). 클라이언트도 쓰므로 서버 모듈을 들이지 않는다.

export interface SeasonAlertView {
  id: number;
  company: string;
  title: string;
  deadline: string;
  recruitUrl: string;
  articleUrl: string;
  evidence: string;
  foundAt: number;
}

export interface SeasonAlertsResponse {
  inSeason: boolean;
  season: string;
  running: boolean;
  targetCount: number;
  checkedCount: number;
  lastCheckedAt: number | null;
  alerts: SeasonAlertView[];
}
