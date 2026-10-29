import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, renameSync } from "fs";
import { join } from "path";
import type { JobSummary } from "./summarizer";
import type { JobMatch } from "./matcher";
import { categorizePositions } from "./position-categories";
import { TRACKED_APPLICATION_STATUSES, applicationAppliedAt, type ApplicationStatus } from "./application-status";
import { normalizeCompanyName } from "./company-normalize";
import type { Memo, MemoIndex, MemoScope } from "./memo-types";

const DATA_DIR = join(process.cwd(), "data");
const DB_PATH = join(DATA_DIR, "findar.db");
const LEGACY_CACHE_PATH = join(process.cwd(), ".cache", "jobs.json");
const LEGACY_CACHE_MIGRATED_PATH = `${LEGACY_CACHE_PATH}.migrated`;

mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    seq TEXT PRIMARY KEY,
    company TEXT NOT NULL,
    title TEXT NOT NULL,
    date TEXT NOT NULL,
    applicationPeriod TEXT NOT NULL DEFAULT '',
    siteUrl TEXT NOT NULL DEFAULT '',
    rawContent TEXT NOT NULL DEFAULT '',
    attachments TEXT NOT NULL DEFAULT '[]',
    positionType TEXT NOT NULL DEFAULT '미분류',
    experienceYears TEXT NOT NULL DEFAULT '미분류',
    positions TEXT NOT NULL DEFAULT '[]',
    categories TEXT NOT NULL DEFAULT '["기타"]',
    qualifications TEXT NOT NULL DEFAULT '[]',
    jdSummary TEXT NOT NULL DEFAULT '',
    deadline TEXT NOT NULL DEFAULT '',
    summarizedAt INTEGER,
    createdAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_deadline ON jobs(deadline);
  CREATE INDEX IF NOT EXISTS idx_jobs_date ON jobs(date);

  CREATE TABLE IF NOT EXISTS applications (
    seq TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT '미지원',
    notes TEXT NOT NULL DEFAULT '',
    history TEXT NOT NULL DEFAULT '[]',
    submittedAt INTEGER,
    updatedAt INTEGER NOT NULL,
    createdAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS companies (
    normalizedName TEXT PRIMARY KEY,
    displayName TEXT NOT NULL,
    dartCorpCode TEXT,
    dartMatchConfidence TEXT,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS company_sections (
    normalizedName TEXT NOT NULL,
    sectionType TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    contentJson TEXT,
    sources TEXT NOT NULL DEFAULT '[]',
    model TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ok',
    generatedAt INTEGER NOT NULL,
    PRIMARY KEY (normalizedName, sectionType)
  );

  CREATE TABLE IF NOT EXISTS application_drafts (
    seq TEXT PRIMARY KEY,
    draftJson TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    generatedAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS application_roles (
    seq TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    revision TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS resume_tailoring (
    seq TEXT PRIMARY KEY,
    resultJson TEXT NOT NULL,
    inputsHash TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    generatedAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sheet_sync_pending (
    seq TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 0,
    lastError TEXT NOT NULL DEFAULT '',
    updatedAt INTEGER NOT NULL
  );

  -- 자기소개서 작성·첨삭·수정·피드백의 추가 전용 기록(lib/essay-log.ts). application_drafts는 현재 상태만 담고
  -- 첨삭 결과·버린 수정본은 닫으면 사라지므로, 변화 과정은 여기에만 남는다. 지우거나 고치지 않는다.
  CREATE TABLE IF NOT EXISTS essay_events (
    id TEXT PRIMARY KEY,
    seq TEXT NOT NULL,
    question TEXT NOT NULL,
    type TEXT NOT NULL,
    actor TEXT NOT NULL,
    threadId TEXT,
    textBefore TEXT,
    textAfter TEXT,
    detail TEXT NOT NULL DEFAULT '{}',
    analysis TEXT,
    createdAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_essay_events_answer ON essay_events(seq, question, createdAt);
  CREATE INDEX IF NOT EXISTS idx_essay_events_type ON essay_events(type, createdAt);
  CREATE INDEX IF NOT EXISTS idx_essay_events_thread ON essay_events(threadId);


  -- AI 호출마다 실제 토큰·캐시 적중·비용(모델이 알려 주는 값). 비용을 줄이는 변경의 효과를 숫자로 확인하는 기록이다.
  CREATE TABLE IF NOT EXISTS ai_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL DEFAULT '',
    feature TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    mode TEXT NOT NULL,
    promptChars INTEGER NOT NULL DEFAULT 0,
    inputTokens INTEGER,
    cacheReadTokens INTEGER,
    cacheCreationTokens INTEGER,
    outputTokens INTEGER,
    costUsd REAL,
    createdAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ai_usage_key ON ai_usage(key, createdAt);

  -- 사용자가 직접 쓰는 메모(lib/memo-types.ts). scope='job'은 key=seq, scope='company'는 key=normalizeCompanyName().
  -- jobs와 따로 둬서 재크롤링(upsertJob)이 덮어쓰지 않는다. 빈 메모는 행을 지운다.
  CREATE TABLE IF NOT EXISTS memos (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    displayName TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    PRIMARY KEY (scope, key)
  );

  -- 같은 공고가 두 출처(금투협·채용 사이트·직접 추가)에 있을 때의 연결(lib/job-dedup.ts). seq는 목록에서 빠지는 쪽,
  -- canonicalSeq는 남는 쪽이다. 채용 사이트 공고가 처음부터 중복이면 jobs에 저장하지 않고 이 행만 남겨, 다음 수집이
  -- 같은 공고를 다시 열거나 요약하지 않게 한다.
  CREATE TABLE IF NOT EXISTS job_links (
    seq TEXT PRIMARY KEY,
    canonicalSeq TEXT NOT NULL,
    reason TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    createdAt INTEGER NOT NULL
  );

  -- 자체 채용 게시판에서 열어 봤지만 공고가 아니었던 글(요약에 모집 직무가 없음). 다시 열거나 요약하지 않는다.
  CREATE TABLE IF NOT EXISTS watch_not_postings (
    seq TEXT PRIMARY KEY,
    company TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  );

  -- 채용 사이트 감시(lib/company-watch.ts)의 출처별 마지막 결과. 하루 한 번만 돌리는 기준이자 설정 화면의 상태 표시.
  CREATE TABLE IF NOT EXISTS watch_runs (
    company TEXT NOT NULL,
    sourceUrl TEXT NOT NULL,
    sourceType TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    found INTEGER NOT NULL DEFAULT 0,
    added INTEGER NOT NULL DEFAULT 0,
    ranAt INTEGER NOT NULL,
    PRIMARY KEY (company, sourceUrl)
  );
`);

function addColumnIfMissing(column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(jobs)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE jobs ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing("matchScore", "INTEGER");
addColumnIfMissing("matchVerdict", "TEXT");
addColumnIfMissing("matchStrengths", "TEXT");
addColumnIfMissing("matchGaps", "TEXT");
addColumnIfMissing("matchReasoning", "TEXT");
addColumnIfMissing("matchProfileHash", "TEXT");
addColumnIfMissing("hidden", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("bookmarked", "INTEGER NOT NULL DEFAULT 0");
// 채용 사이트 감시로 받은 공고가 그 사이트 목록에서 사라진 시각(마감일을 적지 않는 공고가 많아 이것으로 닫는다).
// upsertJobStmt의 SET에 넣지 않는다 — 감시(lib/company-watch.ts)만 바꾼다.
addColumnIfMissing("sourceClosedAt", "INTEGER");
{
  const cols = db.prepare(`PRAGMA table_info(job_links)`).all() as { name: string }[];
  // "중복 아님"으로 푼 시각. 행을 지우지 않는 이유: 지우면 다음 수집이 같은 공고를 다시 중복으로 묶는다.
  if (!cols.some((c) => c.name === "separatedAt")) db.exec(`ALTER TABLE job_links ADD COLUMN separatedAt INTEGER`);
}

db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_matchScore ON jobs(matchScore)`);

interface JobRow {
  seq: string;
  company: string;
  title: string;
  date: string;
  applicationPeriod: string;
  siteUrl: string;
  rawContent: string;
  attachments: string;
  positionType: string;
  experienceYears: string;
  positions: string;
  categories: string;
  qualifications: string;
  jdSummary: string;
  deadline: string;
  summarizedAt: number | null;
  createdAt: number;
  matchScore: number | null;
  matchVerdict: string | null;
  matchStrengths: string | null;
  matchGaps: string | null;
  matchReasoning: string | null;
  matchProfileHash: string | null;
  hidden: number;
  bookmarked: number;
  sourceClosedAt: number | null;
  applicationStatus: string;
  applicationNotes: string | null;
}

export type JobWithMatch = JobSummary & Partial<JobMatch> & {
  categories: string[];
  matchProfileHash?: string | null;
  bookmarked: boolean;
  applicationStatus: ApplicationStatus;
  applicationNotes: string;
};

function rowToJobWithMatch(row: JobRow): JobWithMatch {
  const base: JobSummary = {
    seq: row.seq,
    company: row.company,
    title: row.title,
    date: row.date,
    applicationPeriod: row.applicationPeriod,
    siteUrl: row.siteUrl,
    attachments: JSON.parse(row.attachments),
    positionType: row.positionType,
    experienceYears: row.experienceYears,
    positions: JSON.parse(row.positions),
    qualifications: JSON.parse(row.qualifications),
    jdSummary: row.jdSummary,
    deadline: row.deadline,
  };
  return {
    ...base,
    categories: JSON.parse(row.categories),
    matchScore: row.matchScore ?? undefined,
    matchVerdict: (row.matchVerdict as JobMatch["matchVerdict"] | null) ?? undefined,
    matchStrengths: row.matchStrengths ? JSON.parse(row.matchStrengths) : undefined,
    matchGaps: row.matchGaps ? JSON.parse(row.matchGaps) : undefined,
    matchReasoning: row.matchReasoning ?? undefined,
    matchProfileHash: row.matchProfileHash,
    bookmarked: row.bookmarked === 1,
    applicationStatus: (row.applicationStatus as ApplicationStatus) || "미지원",
    applicationNotes: row.applicationNotes ?? "",
  };
}

const selectExistingSeqsStmt = db.prepare(
  `SELECT seq FROM jobs WHERE seq = ? AND summarizedAt IS NOT NULL`
);

export function getExistingSeqs(seqs: string[]): Set<string> {
  const existing = new Set<string>();
  for (const seq of seqs) {
    if (selectExistingSeqsStmt.get(seq)) existing.add(seq);
  }
  return existing;
}

const upsertJobStmt = db.prepare(`
  INSERT INTO jobs (
    seq, company, title, date, applicationPeriod, siteUrl, rawContent,
    attachments, positionType, experienceYears, positions, categories,
    qualifications, jdSummary, deadline, summarizedAt, createdAt
  ) VALUES (
    @seq, @company, @title, @date, @applicationPeriod, @siteUrl, @rawContent,
    @attachments, @positionType, @experienceYears, @positions, @categories,
    @qualifications, @jdSummary, @deadline, @summarizedAt, @createdAt
  )
  ON CONFLICT(seq) DO UPDATE SET
    company = excluded.company,
    title = excluded.title,
    date = excluded.date,
    applicationPeriod = excluded.applicationPeriod,
    siteUrl = excluded.siteUrl,
    rawContent = excluded.rawContent,
    attachments = excluded.attachments,
    positionType = excluded.positionType,
    experienceYears = excluded.experienceYears,
    positions = excluded.positions,
    categories = excluded.categories,
    qualifications = excluded.qualifications,
    jdSummary = excluded.jdSummary,
    deadline = excluded.deadline,
    summarizedAt = excluded.summarizedAt
`);

export interface UpsertJobInput {
  summary: JobSummary;
  rawContent: string;
  summarizedOk: boolean;
}

export function upsertJob({ summary, rawContent, summarizedOk }: UpsertJobInput): void {
  const now = Date.now();
  upsertJobStmt.run({
    seq: summary.seq,
    company: summary.company,
    title: summary.title,
    date: summary.date,
    applicationPeriod: summary.applicationPeriod,
    siteUrl: summary.siteUrl,
    rawContent,
    attachments: JSON.stringify(summary.attachments),
    positionType: summary.positionType,
    experienceYears: summary.experienceYears,
    positions: JSON.stringify(summary.positions),
    categories: JSON.stringify(categorizePositions(summary.positions)),
    qualifications: JSON.stringify(summary.qualifications),
    jdSummary: summary.jdSummary,
    deadline: summary.deadline,
    summarizedAt: summarizedOk ? now : null,
    createdAt: now,
  });
}

const updateMatchStmt = db.prepare(`
  UPDATE jobs SET
    matchScore = @matchScore,
    matchVerdict = @matchVerdict,
    matchStrengths = @matchStrengths,
    matchGaps = @matchGaps,
    matchReasoning = @matchReasoning,
    matchProfileHash = @matchProfileHash
  WHERE seq = @seq
`);

export function updateJobMatch(seq: string, match: JobMatch, profileHash: string): void {
  updateMatchStmt.run({
    seq,
    matchScore: match.matchScore,
    matchVerdict: match.matchVerdict,
    matchStrengths: JSON.stringify(match.matchStrengths),
    matchGaps: JSON.stringify(match.matchGaps),
    matchReasoning: match.matchReasoning,
    matchProfileHash: profileHash,
  });
}

// 직접 추가한 공고의 본문을 고쳐 다시 요약했는데 매칭이 실패하면, 옛 본문의 점수가 현재 해시로 남아 재매칭되지 않는다.
// 그래서 다시 요약할 때는 점수를 먼저 지워 다음 새로고침의 재매칭(getJobsNeedingMatch)이 채우게 한다.
export function clearJobMatch(seq: string): void {
  db.prepare(`
    UPDATE jobs SET matchScore = NULL, matchVerdict = NULL, matchStrengths = NULL, matchGaps = NULL,
      matchReasoning = NULL, matchProfileHash = NULL
    WHERE seq = ?
  `).run(seq);
}

// jobs 조회 시 applications를 항상 조인해 applicationStatus를 함께 채운다.
// 이 조인이 빠지면 rowToJobWithMatch가 기본값('미지원')으로 채워버려, 재매칭 시
// 이미 저장된 지원 상태를 실수로 덮어쓸 위험이 있다(클라이언트가 이 결과를 jobs 상태에 그대로 병합함).
const JOB_WITH_APPLICATION_SELECT = `
  SELECT jobs.*,
    COALESCE(applications.status, '미지원') AS applicationStatus,
    applications.notes AS applicationNotes
  FROM jobs
  LEFT JOIN applications ON applications.seq = jobs.seq
`;

// 다른 출처의 같은 공고로 연결된 쪽(job_links.seq)은 목록·매칭에서 뺀다. 사용자가 "중복 아님"으로 푼 연결(separatedAt)은 제외.
const NOT_LINKED_DUPLICATE = `jobs.seq NOT IN (SELECT seq FROM job_links WHERE separatedAt IS NULL)`;

const selectJobsNeedingMatchStmt = db.prepare(`
  ${JOB_WITH_APPLICATION_SELECT}
  WHERE jobs.summarizedAt IS NOT NULL
    AND jobs.hidden = 0
    AND ${NOT_LINKED_DUPLICATE}
    AND (jobs.matchProfileHash IS NULL OR jobs.matchProfileHash != ?)
`);

export function getJobsNeedingMatch(profileHash: string): JobWithMatch[] {
  const rows = selectJobsNeedingMatchStmt.all(profileHash) as JobRow[];
  return rows.map(rowToJobWithMatch);
}

// 이력서 원본이 옮겨지기만 하고 내용은 그대로일 때(lib/profile.ts의 legacy resume/ 이전),
// 해시 계산 방식이 바뀌었다는 이유만으로 전체 재매칭(=토큰 소모)이 일어나지 않도록 기존 매칭의 해시만 바꿔준다.
export function remapMatchProfileHash(from: string, to: string): number {
  return db.prepare(`UPDATE jobs SET matchProfileHash = ? WHERE matchProfileHash = ?`).run(to, from).changes;
}

const skipLowScoreMatchesStmt = db.prepare(`
  UPDATE jobs SET matchProfileHash = ?
  WHERE summarizedAt IS NOT NULL
    AND hidden = 0
    AND matchProfileHash IS NOT NULL
    AND matchProfileHash != ?
    AND matchScore IS NOT NULL
    AND matchScore <= ?
`);

export function skipLowScoreMatches(profileHash: string, minScore: number): number {
  const result = skipLowScoreMatchesStmt.run(profileHash, profileHash, minScore);
  return result.changes;
}

const setJobHiddenStmt = db.prepare(`UPDATE jobs SET hidden = ? WHERE seq = ?`);

export function setJobHidden(seq: string, hidden: boolean): void {
  setJobHiddenStmt.run(hidden ? 1 : 0, seq);
}

export function getHiddenSeqs(): string[] {
  const rows = db.prepare(`SELECT seq FROM jobs WHERE hidden = 1`).all() as { seq: string }[];
  return rows.map((r) => r.seq);
}

const selectHiddenJobsStmt = db.prepare(`
  ${JOB_WITH_APPLICATION_SELECT}
  WHERE jobs.summarizedAt IS NOT NULL AND jobs.hidden = 1
  ORDER BY
    CASE WHEN jobs.matchScore IS NULL THEN 1 ELSE 0 END,
    jobs.matchScore DESC,
    jobs.date DESC
`);

// 숨김 탭에도 일반 목록과 동일한 마감 기준을 적용한다.
export function getHiddenJobs(): JobWithMatch[] {
  const today = todayYmd();
  const rows = selectHiddenJobsStmt.all() as JobRow[];
  return rows.filter((row) => isJobOpen(row, today)).map(rowToJobWithMatch);
}

// hidden과 달리 bookmarked는 getActiveJobs()가 걸러내지 않고 매 job 객체에 그대로 실어
// 보낸다(applicationStatus와 동일한 패턴) — "찜한 공고만 보기"는 서버에서 아예 빼는 게
// 아니라 클라이언트가 이미 가진 목록을 필터링하는 것이므로, hidden처럼 목록에서 영구히
// 빠지면 안 된다.
const setJobBookmarkedStmt = db.prepare(`UPDATE jobs SET bookmarked = ? WHERE seq = ?`);

export function setJobBookmarked(seq: string, bookmarked: boolean): void {
  setJobBookmarkedStmt.run(bookmarked ? 1 : 0, seq);
}

export interface ApplicationRow {
  seq: string;
  status: string;
  notes: string;
  history: string;
  submittedAt: number | null;
  updatedAt: number;
  createdAt: number;
}

const selectApplicationStmt = db.prepare(`SELECT * FROM applications WHERE seq = ?`);

const upsertApplicationStmt = db.prepare(`
  INSERT INTO applications (seq, status, notes, history, submittedAt, updatedAt, createdAt)
  VALUES (@seq, @status, @notes, @history, @submittedAt, @updatedAt, @createdAt)
  ON CONFLICT(seq) DO UPDATE SET
    status = excluded.status,
    notes = excluded.notes,
    history = excluded.history,
    submittedAt = excluded.submittedAt,
    updatedAt = excluded.updatedAt
`);

// notes를 생략하면 기존 값을 유지한다. submittedAt은 '제출완료'로 처음 전환되는 시점에만
// 기록하고, 이후 상태가 바뀌어도(예: 서류합격 → 면접) 최초 제출 시각을 덮어쓰지 않는다.
export function upsertApplicationStatus(
  seq: string,
  status: ApplicationStatus,
  notes?: string
): void {
  const now = Date.now();
  const existing = selectApplicationStmt.get(seq) as ApplicationRow | undefined;
  const history = existing
    ? (JSON.parse(existing.history) as { status: string; at: number }[])
    : [];
  history.push({ status, at: now });

  upsertApplicationStmt.run({
    seq,
    status,
    notes: notes ?? existing?.notes ?? "",
    history: JSON.stringify(history),
    submittedAt: existing?.submittedAt ?? (status === "제출완료" ? now : null),
    updatedAt: now,
    createdAt: existing?.createdAt ?? now,
  });
}

export function getApplication(seq: string): ApplicationRow | undefined {
  return selectApplicationStmt.get(seq) as ApplicationRow | undefined;
}

// Google 시트 동기화(lib/sheet-sync.ts) 재시도 큐. 행에는 seq만 두고, 보낼 내용은 전송 시점의
// applications/jobs에서 다시 만든다 — 재시도가 늦어져도 항상 최신 상태가 시트에 적힌다.
export function markSheetSyncPending(seq: string): void {
  db.prepare(`
    INSERT INTO sheet_sync_pending (seq, updatedAt) VALUES (?, ?)
    ON CONFLICT(seq) DO UPDATE SET updatedAt = excluded.updatedAt
  `).run(seq, Date.now());
}

export function clearSheetSyncPending(seq: string): void {
  db.prepare(`DELETE FROM sheet_sync_pending WHERE seq = ?`).run(seq);
}

export function recordSheetSyncFailure(seq: string, error: string): void {
  db.prepare(`UPDATE sheet_sync_pending SET attempts = attempts + 1, lastError = ?, updatedAt = ? WHERE seq = ?`)
    .run(error.slice(0, 500), Date.now(), seq);
}

export function getPendingSheetSyncSeqs(): string[] {
  return (db.prepare(`SELECT seq FROM sheet_sync_pending ORDER BY updatedAt`).all() as { seq: string }[]).map((r) => r.seq);
}

export interface CompanyRow {
  normalizedName: string;
  displayName: string;
  dartCorpCode: string | null;
  dartMatchConfidence: string | null;
  createdAt: number;
  updatedAt: number;
}

const upsertCompanyStmt = db.prepare(`
  INSERT INTO companies (normalizedName, displayName, createdAt, updatedAt)
  VALUES (@normalizedName, @displayName, @createdAt, @updatedAt)
  ON CONFLICT(normalizedName) DO UPDATE SET
    displayName = excluded.displayName,
    updatedAt = excluded.updatedAt
`);

// jobs.company(자유 텍스트)로부터 companies 행을 만들거나 최신 표기로 갱신한다.
// 공고가 크롤링될 때마다 호출해도 안전하도록 멱등적으로 동작.
export function upsertCompanySeen(displayName: string): string {
  const normalizedName = normalizeCompanyName(displayName);
  const now = Date.now();
  upsertCompanyStmt.run({ normalizedName, displayName, createdAt: now, updatedAt: now });
  return normalizedName;
}

const selectCompanyStmt = db.prepare(`SELECT * FROM companies WHERE normalizedName = ?`);

export function getCompany(normalizedName: string): CompanyRow | undefined {
  return selectCompanyStmt.get(normalizedName) as CompanyRow | undefined;
}

// 금투협 공고의 "사이트바로가기"만 쓴다. 직접 추가·채용 사이트 공고(숫자가 아닌 seq)의 siteUrl은 채용 사이트 공고 링크라
// 홈페이지 후보가 아니다.
const selectJobSiteUrlsStmt = db.prepare(`
  SELECT company, siteUrl FROM jobs
  WHERE siteUrl != '' AND seq NOT GLOB '*[^0-9]*' AND instr(replace(company, ' ', ''), ?) > 0
  ORDER BY date DESC
`);

// 회사의 공고에 적힌 "사이트바로가기" 주소들(최신 공고 순, 중복 제거). 회사 리서치가 홈페이지를 먼저 읽는 데 쓴다.
export function getCompanySiteUrls(normalizedName: string): string[] {
  const rows = selectJobSiteUrlsStmt.all(normalizedName) as { company: string; siteUrl: string }[];
  return [...new Set(rows.filter((r) => normalizeCompanyName(r.company) === normalizedName).map((r) => r.siteUrl.trim()).filter(Boolean))];
}

// 등록일 순. 직접 추가한 공고의 seq는 숫자가 아니라서 seq로 정렬하면 맨 뒤로 밀린다.
const selectCompanyJobsStmt = db.prepare(`
  SELECT seq, company, title, date, applicationPeriod, siteUrl, rawContent FROM jobs
  WHERE instr(replace(company, ' ', ''), ?) > 0 ORDER BY date DESC
`);

export interface CompanyJobPosting { seq: string; title: string; date: string; applicationPeriod: string; siteUrl: string; rawContent: string }

// 회사의 최근 공고(KOFIA·직접 추가, 최신순). 회사 리서치가 날짜가 분명한 1차 자료(근무지·회사 소개 문단·채용 부서)이자
// 홈페이지 주소 후보(지원 이메일 도메인)로 쓴다.
export function getCompanyRecentJobs(normalizedName: string, limit: number): CompanyJobPosting[] {
  // SQL은 후보만 좁히고(공백 제거 후 포함), 정확한 일치는 normalizeCompanyName으로 본다.
  const rows = selectCompanyJobsStmt.all(normalizedName) as (CompanyJobPosting & { company: string })[];
  return rows.filter((r) => normalizeCompanyName(r.company) === normalizedName).slice(0, limit)
    .map(({ seq, title, date, applicationPeriod, siteUrl, rawContent }) => ({ seq, title, date, applicationPeriod, siteUrl, rawContent }));
}

const setCompanyDartMatchStmt = db.prepare(`
  UPDATE companies SET dartCorpCode = ?, dartMatchConfidence = ?, updatedAt = ? WHERE normalizedName = ?
`);

export function setCompanyDartMatch(
  normalizedName: string,
  corpCode: string | null,
  confidence: string | null
): void {
  setCompanyDartMatchStmt.run(corpCode, confidence, Date.now(), normalizedName);
}

interface CompanySectionRow {
  normalizedName: string;
  sectionType: string;
  content: string;
  contentJson: string | null;
  sources: string;
  model: string;
  status: string;
  generatedAt: number;
}

export interface CompanySection {
  sectionType: string;
  content: string;
  contentJson: unknown;
  sources: { title: string; url: string }[];
  model: string;
  status: string;
  generatedAt: number;
}

function rowToCompanySection(row: CompanySectionRow): CompanySection {
  return {
    sectionType: row.sectionType,
    content: row.content,
    contentJson: row.contentJson ? JSON.parse(row.contentJson) : null,
    sources: JSON.parse(row.sources),
    model: row.model,
    status: row.status,
    generatedAt: row.generatedAt,
  };
}

const selectCompanySectionsStmt = db.prepare(
  `SELECT * FROM company_sections WHERE normalizedName = ?`
);

export function getCompanySections(normalizedName: string): CompanySection[] {
  const rows = selectCompanySectionsStmt.all(normalizedName) as CompanySectionRow[];
  return rows.map(rowToCompanySection);
}

const upsertCompanySectionStmt = db.prepare(`
  INSERT INTO company_sections (normalizedName, sectionType, content, contentJson, sources, model, status, generatedAt)
  VALUES (@normalizedName, @sectionType, @content, @contentJson, @sources, @model, @status, @generatedAt)
  ON CONFLICT(normalizedName, sectionType) DO UPDATE SET
    content = excluded.content,
    contentJson = excluded.contentJson,
    sources = excluded.sources,
    model = excluded.model,
    status = excluded.status,
    generatedAt = excluded.generatedAt
`);

export function saveCompanySection(
  normalizedName: string,
  sectionType: string,
  data: {
    content: string;
    contentJson?: unknown;
    sources: { title: string; url: string }[];
    model: string;
    status: "ok" | "partial" | "failed";
  }
): void {
  upsertCompanySectionStmt.run({
    normalizedName,
    sectionType,
    content: data.content,
    contentJson: data.contentJson !== undefined ? JSON.stringify(data.contentJson) : null,
    sources: JSON.stringify(data.sources),
    model: data.model,
    status: data.status,
    generatedAt: Date.now(),
  });
}

export interface ApplicationDraftRow {
  seq: string;
  draftJson: string;
  model: string;
  generatedAt: number;
}

const selectDraftStmt = db.prepare(`SELECT * FROM application_drafts WHERE seq = ?`);

export function getApplicationDraftRow(seq: string): ApplicationDraftRow | undefined {
  return selectDraftStmt.get(seq) as ApplicationDraftRow | undefined;
}

const upsertDraftStmt = db.prepare(`
  INSERT INTO application_drafts (seq, draftJson, model, generatedAt)
  VALUES (@seq, @draftJson, @model, @generatedAt)
  ON CONFLICT(seq) DO UPDATE SET
    draftJson = excluded.draftJson,
    model = excluded.model,
    generatedAt = excluded.generatedAt
`);

export function saveApplicationDraft(seq: string, draftJson: string, model: string): void {
  upsertDraftStmt.run({ seq, draftJson, model, generatedAt: Date.now() });
}

export function listApplicationDraftRows(): ApplicationDraftRow[] {
  return db.prepare(`SELECT * FROM application_drafts`).all() as ApplicationDraftRow[];
}

export interface EssayEventRow {
  id: string;
  seq: string;
  question: string;
  type: string;
  actor: string;
  threadId: string | null;
  textBefore: string | null;
  textAfter: string | null;
  detail: string;
  analysis: string | null;
  createdAt: number;
}

const insertEssayEventStmt = db.prepare(`
  INSERT INTO essay_events (id, seq, question, type, actor, threadId, textBefore, textAfter, detail, analysis, createdAt)
  VALUES (@id, @seq, @question, @type, @actor, @threadId, @textBefore, @textAfter, @detail, @analysis, @createdAt)
`);
const insertEssayEventsTx = db.transaction((rows: EssayEventRow[]) => { for (const row of rows) insertEssayEventStmt.run(row); });

export function insertEssayEvents(rows: EssayEventRow[]): void {
  if (rows.length) insertEssayEventsTx(rows);
}

export function hasEssayEvents(seq: string, question: string): boolean {
  return !!db.prepare(`SELECT 1 FROM essay_events WHERE seq = ? AND question = ? LIMIT 1`).get(seq, question);
}

export interface EssayEventFilter { seq?: string; question?: string; threadId?: string; types?: string[]; since?: number; until?: number; limit?: number }

// 시간순(오래된 것부터). limit이 있으면 조건에 맞는 가장 최근 limit개를 시간순으로 돌려준다.
export function listEssayEventRows(filter: EssayEventFilter = {}): EssayEventRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.seq !== undefined) { where.push("seq = ?"); params.push(filter.seq); }
  if (filter.question !== undefined) { where.push("question = ?"); params.push(filter.question); }
  if (filter.threadId !== undefined) { where.push("threadId = ?"); params.push(filter.threadId); }
  if (filter.types?.length) { where.push(`type IN (${filter.types.map(() => "?").join(", ")})`); params.push(...filter.types); }
  if (filter.since !== undefined) { where.push("createdAt >= ?"); params.push(filter.since); }
  if (filter.until !== undefined) { where.push("createdAt <= ?"); params.push(filter.until); }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const columns = "id, seq, question, type, actor, threadId, textBefore, textAfter, detail, analysis, createdAt";
  const sql = filter.limit
    ? `SELECT ${columns} FROM (SELECT rowid AS r, * FROM essay_events ${clause} ORDER BY createdAt DESC, r DESC LIMIT ?) ORDER BY createdAt, r`
    : `SELECT ${columns} FROM essay_events ${clause} ORDER BY createdAt, rowid`;
  if (filter.limit) params.push(filter.limit);
  return db.prepare(sql).all(...params) as EssayEventRow[];
}

export interface ResumeTailoringRow {
  seq: string;
  resultJson: string;
  inputsHash: string;
  model: string;
  generatedAt: number;
}

const selectTailoringStmt = db.prepare(`SELECT * FROM resume_tailoring WHERE seq = ?`);

export function getResumeTailoringRow(seq: string): ResumeTailoringRow | undefined {
  return selectTailoringStmt.get(seq) as ResumeTailoringRow | undefined;
}

const upsertTailoringStmt = db.prepare(`
  INSERT INTO resume_tailoring (seq, resultJson, inputsHash, model, generatedAt)
  VALUES (@seq, @resultJson, @inputsHash, @model, @generatedAt)
  ON CONFLICT(seq) DO UPDATE SET
    resultJson = excluded.resultJson,
    inputsHash = excluded.inputsHash,
    model = excluded.model,
    generatedAt = excluded.generatedAt
`);

export function saveResumeTailoring(seq: string, resultJson: string, inputsHash: string, model: string): void {
  upsertTailoringStmt.run({ seq, resultJson, inputsHash, model, generatedAt: Date.now() });
}

export function clearAllMatches(): void {
  db.exec(`
    UPDATE jobs SET
      matchScore = NULL,
      matchVerdict = NULL,
      matchStrengths = NULL,
      matchGaps = NULL,
      matchReasoning = NULL,
      matchProfileHash = NULL
  `);
}

function todayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function applicationPeriodEnd(period: string): string {
  if (!period) return "";
  const parts = period.split("~");
  // 끝날짜가 없으면("YYYYMMDD~") 마감 미정으로 처리
  const end = parts[1]?.trim() ?? "";
  if (/^\d{8}$/.test(end)) {
    return `${end.slice(0, 4)}-${end.slice(4, 6)}-${end.slice(6, 8)}`;
  }
  return "";
}

const selectActiveJobsStmt = db.prepare(`
  ${JOB_WITH_APPLICATION_SELECT}
  WHERE jobs.summarizedAt IS NOT NULL AND jobs.hidden = 0 AND ${NOT_LINKED_DUPLICATE}
  ORDER BY
    CASE WHEN jobs.matchScore IS NULL THEN 1 ELSE 0 END,
    jobs.matchScore DESC,
    jobs.date DESC
`);

// 마감일(deadline) 또는 접수기간 끝날짜가 오늘 이후면 열린 공고. 둘 다 없으면 마감 미정으로 보고 열린 것으로 친다.
// 채용 사이트 목록에서 내려간 공고(sourceClosedAt)는 마감일과 상관없이 닫힌 공고다.
function isJobOpen(row: Pick<JobRow, "deadline" | "applicationPeriod"> & { sourceClosedAt?: number | null }, today: string): boolean {
  if (row.sourceClosedAt) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(row.deadline)) return row.deadline >= today;
  const periodEnd = applicationPeriodEnd(row.applicationPeriod);
  if (periodEnd) return periodEnd >= today;
  return true;
}

export function getActiveJobs(): JobWithMatch[] {
  const today = todayYmd();
  const rows = selectActiveJobsStmt.all() as JobRow[];
  return rows.filter((row) => isJobOpen(row, today)).map(rowToJobWithMatch);
}

export type TrackedApplicationJob = JobWithMatch & {
  submittedAt: number | null;
  // 제출완료 이후 단계면 지원한 시각(applicationAppliedAt), 아직 지원 전(검토중/작성중)이면 null.
  // 보드가 이 값으로 "최근 지원한 회사"를 표시한다.
  appliedAt: number | null;
  applicationUpdatedAt: number;
  expired: boolean;
};

// "지원 현황" 보기용: 검토중부터 추적하는 공고는 마감이 지나도, 사용자가 숨겼어도 계속 돌려준다.
// getActiveJobs()와 달리 마감/hidden 필터가 없다 — 지원 과정을 추적하는 공고가 기한 경과로 사라지면 안 되므로.
const selectTrackedJobsStmt = db.prepare(`
  SELECT jobs.*,
    applications.status AS applicationStatus,
    applications.notes AS applicationNotes,
    applications.submittedAt AS submittedAt,
    applications.history AS applicationHistory,
    applications.updatedAt AS applicationUpdatedAt
  FROM jobs
  JOIN applications ON applications.seq = jobs.seq
  WHERE applications.status IN (${TRACKED_APPLICATION_STATUSES.map(() => "?").join(", ")})
  ORDER BY applications.updatedAt DESC
`);

export function getTrackedApplicationJobs(): TrackedApplicationJob[] {
  const today = todayYmd();
  const rows = selectTrackedJobsStmt.all(...TRACKED_APPLICATION_STATUSES) as (JobRow & {
    submittedAt: number | null;
    applicationHistory: string | null;
    applicationUpdatedAt: number;
  })[];
  return rows.map((row) => ({
    ...rowToJobWithMatch(row),
    submittedAt: row.submittedAt,
    appliedAt: applicationAppliedAt({
      status: row.applicationStatus,
      submittedAt: row.submittedAt,
      history: row.applicationHistory ? JSON.parse(row.applicationHistory) : [],
      updatedAt: row.applicationUpdatedAt,
    }),
    applicationUpdatedAt: row.applicationUpdatedAt,
    expired: !isJobOpen(row, today),
  }));
}

const selectJobBySeqStmt = db.prepare(`${JOB_WITH_APPLICATION_SELECT} WHERE jobs.seq = ?`);

// 지원 초안 생성(lib/application-draft.ts)에 필요한 rawContent까지 포함해서 반환한다.
// getActiveJobs 등 목록 조회에는 일부러 rawContent를 안 실어서 응답을 가볍게 유지하므로 분리.
export function getJobBySeq(seq: string): (JobWithMatch & { rawContent: string }) | undefined {
  const row = selectJobBySeqStmt.get(seq) as JobRow | undefined;
  if (!row) return undefined;
  return { ...rowToJobWithMatch(row), rawContent: row.rawContent };
}

function migrateLegacyCache(): void {
  if (!existsSync(LEGACY_CACHE_PATH)) return;
  try {
    const raw = readFileSync(LEGACY_CACHE_PATH, "utf-8");
    const store = JSON.parse(raw) as Record<string, { data: JobSummary[]; expiresAt: number }>;
    const entry = store["jobs"];
    if (entry?.data?.length) {
      const now = Date.now();
      const tx = db.transaction((summaries: JobSummary[]) => {
        for (const s of summaries) {
          upsertJobStmt.run({
            seq: s.seq,
            company: s.company,
            title: s.title,
            date: s.date,
            applicationPeriod: s.applicationPeriod,
            siteUrl: s.siteUrl,
            rawContent: "",
            attachments: JSON.stringify(s.attachments || []),
            positionType: s.positionType,
            experienceYears: s.experienceYears,
            positions: JSON.stringify(s.positions || []),
            categories: JSON.stringify(categorizePositions(s.positions || [])),
            qualifications: JSON.stringify(s.qualifications || []),
            jdSummary: s.jdSummary,
            deadline: s.deadline,
            summarizedAt: s.jdSummary === "요약 실패" ? null : now,
            createdAt: now,
          });
        }
      });
      tx(entry.data);
      console.log(`[migrate] imported ${entry.data.length} jobs from legacy cache`);
    }
    renameSync(LEGACY_CACHE_PATH, LEGACY_CACHE_MIGRATED_PATH);
  } catch (e) {
    console.error("[migrate] failed to import legacy cache:", e);
  }
}

migrateLegacyCache();

// categories 컬럼이 죽어있던 시절('[]' 하드코딩)에 저장된 기존 행을 1회성으로 백필한다.
// AI 호출 없이 이미 저장된 positions로부터 순수 계산만 하므로 반복 실행돼도 저렴하다.
function backfillCategories(): void {
  const rows = db
    .prepare(`SELECT seq, positions FROM jobs WHERE categories = '[]'`)
    .all() as { seq: string; positions: string }[];
  if (rows.length === 0) return;
  const stmt = db.prepare(`UPDATE jobs SET categories = ? WHERE seq = ?`);
  const tx = db.transaction((items: typeof rows) => {
    for (const row of items) {
      const positions = JSON.parse(row.positions) as unknown;
      stmt.run(JSON.stringify(categorizePositions(positions)), row.seq);
    }
  });
  tx(rows);
  console.log(`[migrate] backfilled categories for ${rows.length} jobs`);
}

backfillCategories();

// 예전 DART 매칭은 회사 이름 안에 DART 상호가 들어 있기만 해도 연결해, "DS투자증권"·"에픽투자일임"이 한 글자 상호 "자"에,
// "금융투자협회"가 "융"에 묶였다(lib/dart.ts findCorpCode). 그 fuzzy 매칭으로 만든 지배구조·재무 분석은 다른 법인의 대표이사·
// 임원·재무를 공시 사실로 쓴 것이라, 일부 확인(partial)으로 낮추고 안내를 붙여 새로고침 대상으로 돌린다. 매칭은 지워 다시 찾게 한다.
// 새 분석은 contentJson.dartMatch를 남기므로 건드리지 않는다. 반복 실행돼도 안전하다.
export const DART_MISMATCH_NOTICE = "※ DART에서 이름만 비슷한 다른 법인을 연결해 만든 분석입니다. 대표이사·임원·재무 수치가 이 회사의 것이 아닐 수 있으니 다시 조사해주세요.";
function invalidateFuzzyDartSections(): void {
  const companies = db.prepare(`SELECT normalizedName FROM companies WHERE dartMatchConfidence = 'fuzzy'`).all() as { normalizedName: string }[];
  if (companies.length === 0) return;
  const sections = db.prepare(`SELECT sectionType, content, contentJson FROM company_sections WHERE normalizedName = ? AND sectionType IN ('governance_structure', 'financials')`);
  const mark = db.prepare(`UPDATE company_sections SET status = 'partial', content = ? WHERE normalizedName = ? AND sectionType = ?`);
  let marked = 0;
  db.transaction(() => {
    for (const { normalizedName } of companies) {
      for (const row of sections.all(normalizedName) as { sectionType: string; content: string; contentJson: string | null }[]) {
        const json = row.contentJson ? JSON.parse(row.contentJson) as { dartMatch?: unknown } | null : null;
        if (json?.dartMatch || row.content.startsWith(DART_MISMATCH_NOTICE)) continue;
        mark.run(`${DART_MISMATCH_NOTICE}\n\n${row.content}`, normalizedName, row.sectionType);
        marked++;
      }
    }
    db.prepare(`UPDATE companies SET dartCorpCode = NULL, dartMatchConfidence = NULL WHERE dartMatchConfidence = 'fuzzy'`).run();
  })();
  console.log(`[migrate] cleared ${companies.length} fuzzy DART matches, marked ${marked} sections for re-research`);
}

invalidateFuzzyDartSections();

// A single target per posting, independent of scraped positions and application status.
export function getApplicationRole(seq: string): { role: string; revision: string } {
  return (db.prepare("SELECT role, revision FROM application_roles WHERE seq = ?").get(seq) as { role: string; revision: string } | undefined) ?? { role: "", revision: "" };
}
export function saveApplicationRole(seq: string, role: string, expectedRevision: string) {
  return db.transaction(() => {
    if (getApplicationRole(seq).revision !== expectedRevision) throw new Error("다른 창에서 지원 직무가 변경되었습니다. 새로고침 후 다시 저장해주세요.");
    const revision = crypto.randomUUID();
    db.prepare("INSERT INTO application_roles (seq, role, revision) VALUES (?, ?, ?) ON CONFLICT(seq) DO UPDATE SET role = excluded.role, revision = excluded.revision").run(seq, role, revision);
    return { role, revision };
  })();
}

export interface AIUsageRow {
  key: string;
  feature: string;
  provider: string;
  model: string;
  mode: string;
  promptChars: number;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  createdAt: number;
}

export function insertAIUsage(row: AIUsageRow): void {
  db.prepare(`
    INSERT INTO ai_usage (key, feature, provider, model, mode, promptChars, inputTokens, cacheReadTokens, cacheCreationTokens, outputTokens, costUsd, createdAt)
    VALUES (@key, @feature, @provider, @model, @mode, @promptChars, @inputTokens, @cacheReadTokens, @cacheCreationTokens, @outputTokens, @costUsd, @createdAt)
  `).run(row);
}

export function listAIUsage(filter: { key?: string; since?: number; limit?: number } = {}): AIUsageRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.key !== undefined) { where.push("key = ?"); params.push(filter.key); }
  if (filter.since !== undefined) { where.push("createdAt >= ?"); params.push(filter.since); }
  params.push(Math.min(Math.max(filter.limit ?? 200, 1), 2000));
  return db.prepare(`SELECT key, feature, provider, model, mode, promptChars, inputTokens, cacheReadTokens, cacheCreationTokens, outputTokens, costUsd, createdAt
    FROM ai_usage ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY createdAt DESC, id DESC LIMIT ?`).all(...params) as AIUsageRow[];
}

interface MemoRow {
  scope: MemoScope;
  key: string;
  displayName: string;
  text: string;
  updatedAt: number;
}

export function getAllMemos(): MemoIndex {
  const index: MemoIndex = { job: {}, company: {} };
  const rows = db.prepare(`SELECT scope, key, displayName, text, updatedAt FROM memos`).all() as MemoRow[];
  for (const row of rows) {
    if (row.scope === "job") index.job[row.key] = { text: row.text, updatedAt: row.updatedAt };
    else if (row.scope === "company") index.company[row.key] = { text: row.text, updatedAt: row.updatedAt, displayName: row.displayName };
  }
  return index;
}

export function getMemo(scope: MemoScope, key: string): Memo | null {
  const row = db.prepare(`SELECT text, updatedAt FROM memos WHERE scope = ? AND key = ?`).get(scope, key) as Memo | undefined;
  return row ?? null;
}

// 공백뿐인 메모는 지운다(null 반환). 회사 메모의 key는 호출하는 쪽이 normalizeCompanyName()으로 만든다.
export function saveMemo(scope: MemoScope, key: string, text: string, displayName = ""): Memo | null {
  if (!text.trim()) {
    db.prepare(`DELETE FROM memos WHERE scope = ? AND key = ?`).run(scope, key);
    return null;
  }
  const now = Date.now();
  db.prepare(`
    INSERT INTO memos (scope, key, displayName, text, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope, key) DO UPDATE SET
      text = excluded.text,
      displayName = CASE WHEN excluded.displayName = '' THEN memos.displayName ELSE excluded.displayName END,
      updatedAt = excluded.updatedAt
  `).run(scope, key, displayName, text, now, now);
  return { text, updatedAt: now };
}

export interface JobLinkRow { seq: string; canonicalSeq: string; reason: string; title: string; url: string; createdAt: number; separatedAt: number | null }

export function insertJobLink(link: Omit<JobLinkRow, "createdAt" | "separatedAt">): void {
  db.prepare(`
    INSERT INTO job_links (seq, canonicalSeq, reason, title, url, createdAt) VALUES (@seq, @canonicalSeq, @reason, @title, @url, @createdAt)
    ON CONFLICT(seq) DO NOTHING
  `).run({ ...link, createdAt: Date.now() });
}

/** 중복으로 연결된(풀리지 않은) seq. */
export function getLinkedSeqs(seqs: string[]): Set<string> {
  const stmt = db.prepare(`SELECT seq FROM job_links WHERE seq = ? AND separatedAt IS NULL`);
  return new Set(seqs.filter((seq) => stmt.get(seq)));
}

/** 사용자가 "중복 아님"으로 푼 seq. 다시 중복으로 판정하지 않는다. */
export function getSeparatedSeqs(seqs: string[]): Set<string> {
  const stmt = db.prepare(`SELECT seq FROM job_links WHERE seq = ? AND separatedAt IS NOT NULL`);
  return new Set(seqs.filter((seq) => stmt.get(seq)));
}

/** seq 공고와 같은 공고로 묶인 다른 출처 공고들(양쪽 방향, 풀린 것 제외). */
export function getJobLinksFor(seq: string): JobLinkRow[] {
  return db.prepare(`SELECT * FROM job_links WHERE (canonicalSeq = ? OR seq = ?) AND separatedAt IS NULL ORDER BY createdAt`).all(seq, seq) as JobLinkRow[];
}

export function separateJobLink(seq: string): JobLinkRow | undefined {
  const row = db.prepare(`SELECT * FROM job_links WHERE seq = ?`).get(seq) as JobLinkRow | undefined;
  if (row && !row.separatedAt) db.prepare(`UPDATE job_links SET separatedAt = ? WHERE seq = ?`).run(Date.now(), seq);
  return row;
}

export function listJobLinks(): JobLinkRow[] {
  return db.prepare(`SELECT * FROM job_links ORDER BY createdAt DESC`).all() as JobLinkRow[];
}

export interface DedupCandidateRow { seq: string; company: string; title: string; deadline: string; siteUrl: string }

// 중복 판정 후보: 최근 공고(등록일 기준, 이미 다른 공고의 중복으로 연결된 것은 뺀다).
export function getDedupCandidates(sinceDate: string): DedupCandidateRow[] {
  return db.prepare(`
    SELECT seq, company, title, deadline, siteUrl FROM jobs
    WHERE date >= ? AND seq NOT IN (SELECT seq FROM job_links WHERE separatedAt IS NULL)
  `).all(sinceDate) as DedupCandidateRow[];
}

// 사용자가 손댄 공고(지원 상태·찜·지원서 초안·메모). 중복을 합칠 때 이쪽을 남긴다.
export function hasJobUserState(seq: string): boolean {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM applications WHERE seq = @seq AND status != '미지원')
      + (SELECT COUNT(*) FROM jobs WHERE seq = @seq AND bookmarked = 1)
      + (SELECT COUNT(*) FROM application_drafts WHERE seq = @seq)
      + (SELECT COUNT(*) FROM memos WHERE scope = 'job' AND key = @seq) AS n
  `).get({ seq }) as { n: number };
  return row.n > 0;
}

export interface WatchRunRow {
  company: string;
  sourceUrl: string;
  sourceType: string;
  status: "ok" | "empty" | "failed" | "blocked";
  message: string;
  found: number;
  added: number;
  ranAt: number;
}

export function getWatchRuns(): WatchRunRow[] {
  return db.prepare(`SELECT * FROM watch_runs`).all() as WatchRunRow[];
}

export function saveWatchRun(row: WatchRunRow): void {
  db.prepare(`
    INSERT INTO watch_runs (company, sourceUrl, sourceType, status, message, found, added, ranAt)
    VALUES (@company, @sourceUrl, @sourceType, @status, @message, @found, @added, @ranAt)
    ON CONFLICT(company, sourceUrl) DO UPDATE SET
      sourceType = excluded.sourceType, status = excluded.status, message = excluded.message,
      found = excluded.found, added = excluded.added, ranAt = excluded.ranAt
  `).run(row);
}

// 설정 화면의 "다시 확인": 마지막 수집 기록을 지워 다음 공고 새로고침 때 바로 다시 돌게 한다.
export function clearWatchRuns(company: string): void {
  db.prepare(`DELETE FROM watch_runs WHERE company = ?`).run(company);
}

// 채용 사이트 목록을 받은 뒤: 이 회사의 같은 출처 공고 중 목록에 없는 것은 닫고, 다시 보이는 것은 연다.
export function syncWatchPostingsOpen(company: string, seqPrefix: string, openSeqs: string[], now: number): void {
  const open = new Set(openSeqs);
  const rows = db.prepare(`SELECT seq, sourceClosedAt FROM jobs WHERE company = ? AND substr(seq, 1, ?) = ?`)
    .all(company, seqPrefix.length, seqPrefix) as { seq: string; sourceClosedAt: number | null }[];
  const close = db.prepare(`UPDATE jobs SET sourceClosedAt = ? WHERE seq = ?`);
  const reopen = db.prepare(`UPDATE jobs SET sourceClosedAt = NULL WHERE seq = ?`);
  db.transaction(() => {
    for (const row of rows) {
      if (open.has(row.seq)) { if (row.sourceClosedAt) reopen.run(row.seq); }
      else if (!row.sourceClosedAt) close.run(now, row.seq);
    }
  })();
}

export function insertNotPosting(row: { seq: string; company: string; title: string; url: string }): void {
  db.prepare(`INSERT INTO watch_not_postings (seq, company, title, url, createdAt) VALUES (@seq, @company, @title, @url, @createdAt)
    ON CONFLICT(seq) DO NOTHING`).run({ ...row, createdAt: Date.now() });
}

export function getNotPostingSeqs(seqs: string[]): Set<string> {
  const stmt = db.prepare(`SELECT seq FROM watch_not_postings WHERE seq = ?`);
  return new Set(seqs.filter((seq) => stmt.get(seq)));
}
