import { isManualSeq } from "./manual-jobs";

// 공고가 어디서 왔는지는 seq의 형태로 정해진다(별도 열을 두지 않는다 — seq가 바뀌지 않으니 두 값이 어긋날 일이 없다).
//  - 금투협 게시판: 숫자뿐인 seq(협회 공고 번호)
//  - 직접 추가: "manual-…"
//  - 채용 사이트 감시(lib/company-watch.ts): "<어댑터>-<원본 ID>". 그리팅 "greeting-<openingId>",
//    사람인 기업 채용 사이트 "saraminats-<slug>-<채용 ID>", recruiter.co.kr 구형 "recruiter-<slug>-<jobnoticeSn>",
//    자체 채용 게시판 "page-<공고 주소 해시 12자리>", 자체 채용 사이트의 목록 API "api-<slug>-<공고 ID>"
// 금투협이 아닌 공고의 siteUrl은 그 공고의 원문 페이지(곧 지원하는 곳)다. AI 없음(클라이언트에서도 쓴다).

export type JobSource = "kofia" | "manual" | "greeting" | "saraminAts" | "recruiterAppsite" | "pageWatch" | "endpoint";

export const WATCH_SEQ_PREFIXES = { greeting: "greeting-", saraminAts: "saraminats-", recruiterAppsite: "recruiter-", pageWatch: "page-", endpoint: "api-" } as const;
export type WatchAdapterType = keyof typeof WATCH_SEQ_PREFIXES;

export const JOB_SOURCE_LABELS: Record<JobSource, string> = {
  kofia: "금융투자협회",
  manual: "직접 추가",
  greeting: "채용 사이트(그리팅)",
  saraminAts: "채용 사이트(사람인)",
  recruiterAppsite: "채용 사이트(recruiter)",
  pageWatch: "회사 채용 게시판",
  endpoint: "회사 채용 사이트",
};

export function isKofiaSeq(seq: string): boolean {
  return /^\d+$/.test(seq);
}

export function jobSource(seq: string): JobSource {
  if (isKofiaSeq(seq)) return "kofia";
  if (seq.startsWith(WATCH_SEQ_PREFIXES.greeting)) return "greeting";
  if (seq.startsWith(WATCH_SEQ_PREFIXES.saraminAts)) return "saraminAts";
  if (seq.startsWith(WATCH_SEQ_PREFIXES.recruiterAppsite)) return "recruiterAppsite";
  if (seq.startsWith(WATCH_SEQ_PREFIXES.pageWatch)) return "pageWatch";
  if (seq.startsWith(WATCH_SEQ_PREFIXES.endpoint)) return "endpoint";
  return "manual";
}

/** 채용 사이트 감시로 모은 공고(그리팅·사람인 등). 직접 추가한 공고와 달리 사용자가 고칠 수 없다. */
export function isWatchSeq(seq: string): boolean {
  return !isKofiaSeq(seq) && !isManualSeq(seq) && jobSource(seq) !== "manual";
}

/** 공고 원문 주소. 금투협 공고는 협회 게시판, 그 밖의 공고는 siteUrl(없으면 null). */
export function postingLink(job: { seq: string; siteUrl: string }): string | null {
  if (isKofiaSeq(job.seq)) return `https://www.kofia.or.kr/brd/m_96/view.do?seq=${job.seq}`;
  return job.siteUrl || null;
}
