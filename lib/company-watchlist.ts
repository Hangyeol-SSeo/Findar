import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { normalizeCompanyName } from "./company-normalize";
import type { WatchApiConfig } from "./watch-adapters";

// 금투협 게시판 밖에서 공고를 확인할 회사 목록(감시 목록). 설계: docs/multi-source-jobs.md 2절 D·3절.
// 금투협에 경력·수시 공고를 올리는 회사도 신입 공채·인턴은 자체 채용 사이트에만 올리는 일이 많다(메리츠·NH·키움·DB·LS).
// 회사마다 채용 경로(source) 하나 이상을 적는다. 지금 자동으로 받는 경로는 greeting·saraminAts·recruiterAppsite·pageWatch·
// endpoint·workday이고, 나머지 유형은 설정 화면에 "채용 사이트 바로가기"로만 보인다:
//  - unknown: 목록이 브라우저에서만 보여 데이터 경로를 아직 확인하지 않음(확인 필요)
//  - blocked: robots.txt가 데이터 경로를 금지하거나 자동 요청을 차단함(우회하지 않음). 사용자가 직접 확인한다
//  - saraminApi: 사람인 일반 공고에만 올림. 사람인 오픈API 승인 뒤 받는다
// 사용자 데이터는 data/company-watchlist.json(없으면 아래 초기값). 사용자는 회사별로 끄고 켤 수만 있다.

export type WatchSourceType = "greeting" | "saraminAts" | "recruiterAppsite" | "endpoint" | "pageWatch" | "workday" | "unknown" | "blocked" | "saraminApi";

export const COLLECTABLE_SOURCE_TYPES = ["greeting", "saraminAts", "recruiterAppsite", "pageWatch", "endpoint", "workday"] as const;
export type CollectableSourceType = (typeof COLLECTABLE_SOURCE_TYPES)[number];

export function isCollectable(type: WatchSourceType): type is CollectableSourceType {
  return (COLLECTABLE_SOURCE_TYPES as readonly string[]).includes(type);
}

export const WATCH_SOURCE_LABELS: Record<WatchSourceType, string> = {
  greeting: "그리팅",
  saraminAts: "사람인 채용 사이트",
  recruiterAppsite: "recruiter.co.kr 채용 사이트",
  endpoint: "회사 채용 사이트",
  pageWatch: "회사 채용 게시판",
  workday: "Workday",
  unknown: "확인 필요",
  blocked: "자동 수집 불가",
  saraminApi: "사람인 공고(API 승인 대기)",
};

export interface WatchSource {
  type: WatchSourceType;
  url: string;
  /** 그룹 채용 사이트(NICE)에서 이 회사 공고만 고르는 제목 머리말. 하나라도 들어 있으면 이 회사 공고. */
  titleIncludes?: string[];
  /** pageWatch: 글 링크가 javascript:뿐인 게시판의 상세 주소({id} 자리). lib/watch-adapters.ts WatchListOptions 참고. */
  jsLinkTemplate?: string;
  /** pageWatch: 링크 없이 목록 칸에 내용이 다 있는 게시판의 공고 요소 선택자. */
  itemSelector?: string;
  /** endpoint: 같은 사이트 목록·상세 API 설정. */
  api?: WatchApiConfig;
  note?: string;
}

export interface WatchCompany {
  /** 금투협 공고의 회사명과 같게 적는다(중복 판정·회사 리서치가 이 이름을 쓴다). */
  name: string;
  segment: string;
  sources: WatchSource[];
  enabled: boolean;
  /** 공채 시즌 감지 대상(lib/hiring-season.ts): 공고를 자동으로 받지 못하는데 신입 공채를 하는 회사. */
  season?: boolean;
}

export interface Watchlist {
  version: 1;
  companies: WatchCompany[];
}

const c = (name: string, segment: string, sources: WatchSource[], enabled = true): WatchCompany => ({ name, segment, sources, enabled });

// 2026-10-29 전수 확인 결과(docs/multi-source-jobs.md 2절 D). "금투협만"(별도 채널 없음) 회사는 넣지 않았다.
export const DEFAULT_WATCHLIST: Watchlist = {
  version: 1,
  companies: [
    // 그리팅 — 자동
    c("한국자산신탁", "신탁", [{ type: "greeting", url: "https://careers.kait.com/" }]),
    c("교보자산신탁", "신탁", [{ type: "greeting", url: "https://kyobotrust.career.greetinghr.com/" }]),
    c("신한자산신탁", "신탁", [{ type: "greeting", url: "https://recruiter.shinhantrust.kr/" }]),
    c("KIS자산평가", "채권평가", [{ type: "greeting", url: "https://kispricing.career.greetinghr.com/" }]),
    c("나이스신용평가", "신용평가", [{ type: "greeting", url: "https://nice.career.greetinghr.com/", titleIncludes: ["NICE신용평가", "나이스신용평가"], note: "NICE그룹 통합 채용 사이트" }]),
    c("나이스피앤아이", "채권평가", [{ type: "greeting", url: "https://nice.career.greetinghr.com/", titleIncludes: ["NICE피앤아이", "NICE P&I", "나이스피앤아이"], note: "NICE그룹 통합 채용 사이트" }]),
    c("아이알큐더스", "유관기관", [{ type: "greeting", url: "https://irk.career.greetinghr.com/" }]),
    c("KB증권", "증권", [
      { type: "greeting", url: "https://kbsec.career.greetinghr.com/", note: "수시 채용" },
      { type: "blocked", url: "https://www.kbfg.com/", note: "공채는 recruiter.co.kr 신형(데이터 API를 robots.txt가 금지)" },
    ]),
    c("넥스트증권", "증권", [{ type: "greeting", url: "https://nextsecurities.career.greetinghr.com/" }]),
    c("비엔케이투자증권", "증권", [{ type: "greeting", url: "https://careers.bnkfn.co.kr/" }]),
    c("한양증권", "증권", [{ type: "greeting", url: "https://hygood.career.greetinghr.com/" }]),
    c("타임폴리오자산운용", "자산운용", [{ type: "greeting", url: "https://timefolio.career.greetinghr.com/", note: "2026-10-29 확인 때 404" }], false),
    c("넥스트레이드", "유관기관", [{ type: "greeting", url: "https://nxt.career.greetinghr.com/", note: "2026-10-29 확인 때 404" }], false),

    // 사람인 기업 채용 사이트 — 자동
    c("키움증권", "증권", [{ type: "saraminAts", url: "https://kiwoom.saramin.co.kr/", note: "대졸 공채" }]),
    c("대신자산신탁", "신탁", [{ type: "saraminAts", url: "https://daishin.saramin.co.kr/" }]),
    c("한국거래소", "유관기관", [{ type: "saraminAts", url: "https://krx.saramin.co.kr/" }]),
    c("한국예탁결제원", "유관기관", [{ type: "saraminAts", url: "https://ksd.saramin.co.kr/" }]),
    c("한국증권금융", "유관기관", [{ type: "saraminAts", url: "https://ksfc.saramin.co.kr/" }]),
    c("코스콤", "유관기관", [{ type: "saraminAts", url: "https://koscom.saramin.co.kr/" }]),

    // recruiter.co.kr 구형(/appsite/) — 목록만 자동(본문 페이지 /app/은 robots.txt가 금지)
    c("SK증권", "증권", [{ type: "recruiterAppsite", url: "https://sks.recruiter.co.kr/" }]),
    c("엘에스증권", "증권", [{ type: "recruiterAppsite", url: "https://ls-sec.recruiter.co.kr/", note: "채용전제형 인턴" }]),
    c("코람코자산운용", "자산운용", [{ type: "recruiterAppsite", url: "https://koramco.recruiter.co.kr/", titleIncludes: ["코람코자산운용"], note: "코람코 통합 채용 사이트" }]),
    c("코람코자산신탁", "신탁", [{ type: "recruiterAppsite", url: "https://koramco.recruiter.co.kr/", titleIncludes: ["코람코자산신탁"], note: "코람코 통합 채용 사이트" }]),
    c("한국펀드평가", "데이터", [{ type: "recruiterAppsite", url: "https://kfr.recruiter.co.kr/" }]),

    // 자체 채용 사이트의 같은 사이트 목록 API
    c("IBK투자증권", "증권", [{ type: "endpoint", url: "https://recruit.ibks.com/", api: {
      list: "/rec/api/ibks/announce/list?searchWord=&includeFinAnno=N&page=1", items: "rows", id: "annoId", title: "title", period: "term",
      detail: "/rec/api/ibks/announce?annoId={id}", page: "/cv/announces/ibks/{id}",
    } }]),
    c("미래에셋증권", "증권", [{ type: "unknown", url: "https://recruit.securities.miraeasset.com/", note: "목록 API(Application.do) 확인됨. 2026-10-29부터 시스템 점검 중이라 재확인 필요" }]),
    c("한국투자증권", "증권", [{ type: "blocked", url: "https://career.koreainvestment.com/announcementList", note: "한투금융 채용포탈: 목록 요청 인자를 브라우저에서 암호화함" }]),
    c("한국투자신탁운용", "자산운용", [{ type: "blocked", url: "https://career.koreainvestment.com/announcementList", note: "한투금융 채용포탈: 목록 요청 인자를 브라우저에서 암호화함" }]),
    c("한국투자밸류자산운용", "자산운용", [{ type: "blocked", url: "https://career.koreainvestment.com/announcementList", note: "한투금융 채용포탈: 목록 요청 인자를 브라우저에서 암호화함" }]),

    // 자체 채용 게시판 — 서버 HTML에 글 목록이 있는 곳(2026-10-29 확인)
    c("코리아에셋투자증권", "증권", [{ type: "pageWatch", url: "https://www.kasset.co.kr/recruit_list.do", jsLinkTemplate: "https://www.kasset.co.kr/recruit_view.do?recruitId={id}", note: "본문이 이미지라 제목만 읽힘" }]),
    c("하나자산운용", "자산운용", [{ type: "pageWatch", url: "https://www.hanaam.com/hanaam/recruit" }]),
    c("우리자산운용", "자산운용", [{ type: "pageWatch", url: "https://www.wooriam.kr/company/recruit-list", itemSelector: ".recruit-item", note: "하반기 공개 채용이 금투협에 없음" }]),
    c("마스턴투자운용", "자산운용", [{ type: "pageWatch", url: "https://careers.mastern.co.kr/pages/recruit/job-posting_list.php" }]),
    c("신영자산운용", "자산운용", [{ type: "pageWatch", url: "https://www.syfund.co.kr/board/notice?categorySeq=95", note: "공지 게시판의 채용 분류" }]),
    c("신영부동산신탁", "신탁", [{ type: "pageWatch", url: "http://www.shinyoungret.com/?pages=job&subs=sub01" }]),
    c("하나자산신탁", "신탁", [{ type: "pageWatch", url: "https://hanatrust.com/ko/recruitment/jobNotice", note: "하반기 직원 채용이 금투협에 없음" }]),
    c("이지자산평가", "채권평가", [{ type: "pageWatch", url: "https://www.egap.co.kr/bbs/board.php?bo_table=recruit" }]),
    // 자체 채용 게시판이지만 글 목록을 스크립트로 불러오거나 열리지 않음 — 확인 필요
    c("신한투자증권", "증권", [{ type: "unknown", url: "https://recruit.shinhansec.com/", note: "채용 사이트가 스크립트로만 그려짐" }]),
    c("DS투자증권", "증권", [{ type: "unknown", url: "https://www.ds-sec.co.kr/sub01/sub01_06.php", note: "채용공고가 탭 안에 있음(글 링크 없음)" }]),
    c("마이다스에셋자산운용", "자산운용", [{ type: "unknown", url: "https://midasasset.com/%ea%b3%b5%ec%a7%80-%ea%b3%b5%ec%8b%9c/%ec%b1%84%ec%9a%a9%ea%b3%b5%ea%b3%a0/", note: "글 목록을 스크립트로 불러옴" }]),
    c("트러스톤자산운용", "자산운용", [{ type: "unknown", url: "https://www.trustonasset.com/?cat=61", note: "글 목록을 스크립트로 불러옴" }]),
    c("아이비케이자산운용", "자산운용", [{ type: "unknown", url: "https://www.ibkasset.com/customer-center/notice", note: "공지 게시판에 채용 공지, 목록을 스크립트로 불러옴" }]),
    c("한국투자리얼에셋운용", "자산운용", [{ type: "unknown", url: "https://kira.koreainvestment.com/", note: "https 연결 실패(robots.txt 확인 불가)" }]),

    // Workday(외국계) — 서울 근무 공고만
    c("모간스탠리인터내셔날증권 서울지점", "외국계 IB", [{ type: "workday", url: "https://ms.wd5.myworkdayjobs.com/External", note: "Morgan Stanley" }]),
    c("도이치은행 서울지점", "외국계 IB", [{ type: "workday", url: "https://db.wd3.myworkdayjobs.com/DBWebsite", note: "Deutsche Bank(도이치증권 포함)" }]),
    c("베어링자산운용", "자산운용", [{ type: "workday", url: "https://barings.wd1.myworkdayjobs.com/Barings" }]),
    c("블랙록자산운용", "자산운용", [{ type: "workday", url: "https://blackrock.wd1.myworkdayjobs.com/BlackRock_Professional" }]),

    // 확인 필요 — 목록이 브라우저에서만 보임
    c("메리츠증권", "증권", [
      { type: "unknown", url: "https://recruit-meritz.com/", note: "대졸 공채가 금투협에 없음" },
      { type: "unknown", url: "https://imeritz.careerlink.kr/", note: "CareerLink(InHR)" },
    ]),
    c("케이비자산운용", "자산운용", [{ type: "unknown", url: "https://kbam.careerlink.kr/", note: "CareerLink(InHR)" }]),
    c("부국증권", "증권", [{ type: "unknown", url: "https://bookook.applyin.co.kr/", note: "applyin" }]),
    c("신영증권", "증권", [{ type: "unknown", url: "https://shinrecruit.shinyoung.com/", note: "applyin" }]),
    c("하나대체투자자산운용", "자산운용", [{ type: "unknown", url: "https://hana-aamc.applyin.co.kr/", note: "applyin" }]),
    c("스카이펀드서비스", "사무관리", [{ type: "unknown", url: "https://www.skyfs.co.kr/", note: "applyin" }]),
    c("삼성증권", "증권", [{ type: "unknown", url: "https://www.samsungcareers.com/", note: "삼성 채용" }]),
    c("삼성자산운용", "자산운용", [{ type: "unknown", url: "https://www.samsungcareers.com/", note: "삼성 채용" }]),
    c("삼성선물", "선물", [{ type: "unknown", url: "https://www.samsungcareers.com/", note: "삼성 채용(추정)" }]),
    c("토스증권", "증권", [{ type: "unknown", url: "https://toss.im/career", note: "Greenhouse" }]),
    c("케이비부동산신탁", "신탁", [{ type: "unknown", url: "https://kbret.incruit.com/", note: "인크루트" }]),

    // 자동 수집 불가 — 사용자가 직접 확인
    c("NH투자증권", "증권", [{ type: "blocked", url: "https://nhqv.recruiter.co.kr/", note: "recruiter.co.kr 신형. 대졸·업무직 공채, PB 인턴이 금투협에 없음" }]),
    c("교보증권", "증권", [{ type: "blocked", url: "https://iprovest.recruiter.co.kr/", note: "recruiter.co.kr 신형(공채)" }]),
    c("아이엠증권", "증권", [{ type: "blocked", url: "https://imfnsec.recruiter.co.kr/", note: "recruiter.co.kr 신형" }]),
    c("유진투자증권", "증권", [{ type: "blocked", url: "https://eugene.recruiter.co.kr/", note: "recruiter.co.kr 신형" }]),
    c("하나증권", "증권", [{ type: "blocked", url: "https://hanaw-hr.recruiter.co.kr/", note: "recruiter.co.kr 신형" }]),
    c("DB증권", "증권", [{ type: "blocked", url: "https://www.dbsec.co.kr/", note: "DB그룹 공채(recruiter.co.kr 신형). 공채·인턴이 금투협에 없음" }]),
    c("흥국증권", "증권", [{ type: "blocked", url: "https://www.heungkuksec.co.kr/", note: "태광그룹 채용(recruiter.co.kr 신형)" }]),
    c("이지스자산운용", "자산운용", [{ type: "blocked", url: "https://igisam.recruiter.co.kr/", note: "recruiter.co.kr 신형" }]),
    c("유진투자선물", "선물", [{ type: "blocked", url: "https://eugene.recruiter.co.kr/", note: "recruiter.co.kr 신형" }]),
    c("다올투자증권", "증권", [{ type: "blocked", url: "https://career.daolfn.com/", note: "나인하이어(자동 요청 차단)" }]),
    c("카카오페이증권", "증권", [{ type: "blocked", url: "https://career.kakaopaysec.com/", note: "나인하이어(자동 요청 차단)" }]),
    c("KR투자증권", "증권", [{ type: "blocked", url: "https://qo63jl9a.ninehire.site/", note: "나인하이어(자동 요청 차단)" }]),
    c("엔에이치아문디자산운용", "자산운용", [{ type: "blocked", url: "https://nhamundi.ninehire.site/", note: "나인하이어(자동 요청 차단)" }]),
    c("미래에셋자산운용", "자산운용", [{ type: "blocked", url: "https://career.miraeasset.com/", note: "나인하이어(자동 요청 차단)" }]),
    c("한국펀드파트너스", "사무관리", [{ type: "blocked", url: "https://recruit.korfp.com/", note: "나인하이어(자동 요청 차단)" }]),
    c("현대차증권", "증권", [{ type: "blocked", url: "https://recruit.hmsec.com/", note: "robots.txt가 채용 경로 금지" }]),
    c("유안타증권", "증권", [{ type: "blocked", url: "https://recruit.yuantakorea.com/", note: "robots.txt가 채용 경로 금지" }]),
    c("디비자산운용", "자산운용", [{ type: "blocked", url: "https://www.db-asset.com/", note: "robots.txt가 채용 경로 금지" }]),
    c("한국신용평가", "신용평가", [{ type: "blocked", url: "https://kisrating.career.co.kr/", note: "robots.txt가 채용 경로 금지" }]),
    c("에프앤가이드", "데이터", [{ type: "blocked", url: "https://corp.fnguide.com/", note: "robots.txt가 채용 경로 금지" }]),
    c("한화투자증권", "증권", [{ type: "blocked", url: "https://www.hanwhain.com/", note: "한화인(접속 대기열)" }]),
    c("한화자산운용", "자산운용", [{ type: "blocked", url: "https://www.hanwhain.com/", note: "한화인(접속 대기열)" }]),
    c("우리자산신탁", "신탁", [{ type: "blocked", url: "https://recruit.incruit.com/", note: "인크루트(robots.txt 금지)" }]),
    c("대한토지신탁", "신탁", [{ type: "blocked", url: "https://reitpia.saramin.co.kr/", note: "사람인 채용 사이트지만 이 회사만 robots.txt가 전체 금지" }]),

    // 사람인 일반 공고 — 오픈API 승인 뒤
    c("상상인증권", "증권", [{ type: "saraminApi", url: "https://www.saramin.co.kr/" }]),
    c("에셋플러스자산운용", "자산운용", [{ type: "saraminApi", url: "https://www.saramin.co.kr/", note: "자체 사이트는 robots.txt가 금지" }]),
    c("에프앤자산평가", "채권평가", [{ type: "saraminApi", url: "https://www.saramin.co.kr/" }]),
    c("케이비펀드파트너스", "사무관리", [{ type: "saraminApi", url: "https://www.saramin.co.kr/" }]),
    c("우리펀드서비스", "사무관리", [{ type: "saraminApi", url: "https://www.saramin.co.kr/" }]),
  ],
};

// 공채 시즌 감지 기본 대상: 신입 공채를 하는데 그 공고를 자동으로 받지 못하는 회사(recruiter.co.kr 신형·나인하이어·한화인·
// robots.txt 금지·요청 암호화·확인 필요). 저장된 감시 목록에 season 값이 없으면 이 목록을 따른다.
export const DEFAULT_SEASON_COMPANIES = new Set([
  "NH투자증권", "KB증권", "하나증권", "DB증권", "메리츠증권", "삼성증권", "미래에셋증권", "한국투자증권", "신한투자증권",
  "교보증권", "현대차증권", "유안타증권", "한화투자증권", "아이엠증권", "유진투자증권", "흥국증권", "다올투자증권",
  "미래에셋자산운용", "삼성자산운용", "한화자산운용", "한국투자신탁운용", "케이비자산운용", "엔에이치아문디자산운용",
  "이지스자산운용", "한국신용평가",
]);

export function isSeasonTarget(company: WatchCompany): boolean {
  return company.season ?? DEFAULT_SEASON_COMPANIES.has(company.name);
}

const WATCHLIST_PATH = () => join(process.cwd(), "data", "company-watchlist.json");

export function readWatchlist(): Watchlist {
  const path = WATCHLIST_PATH();
  if (!existsSync(path)) return DEFAULT_WATCHLIST;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Watchlist;
    if (parsed?.version === 1 && Array.isArray(parsed.companies)) return parsed;
  } catch (error) {
    console.error("[watchlist] data/company-watchlist.json을 읽지 못해 초기값을 씁니다:", error);
  }
  return DEFAULT_WATCHLIST;
}

export function writeWatchlist(list: Watchlist): void {
  const path = WATCHLIST_PATH();
  mkdirSync(join(process.cwd(), "data"), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`);
  renameSync(tmp, path);
}

/** 회사 하나를 켜거나 끈다. 없는 회사면 false. */
export function setWatchCompanyEnabled(name: string, enabled: boolean): boolean {
  const list = readWatchlist();
  const key = normalizeCompanyName(name);
  const company = list.companies.find((entry) => normalizeCompanyName(entry.name) === key);
  if (!company) return false;
  writeWatchlist({ ...list, companies: list.companies.map((entry) => (entry === company ? { ...entry, enabled } : entry)) });
  return true;
}
