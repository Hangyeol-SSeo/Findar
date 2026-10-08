import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, renameSync } from "fs";
import { join } from "path";
import type { JobSummary } from "./summarizer";
import type { JobMatch } from "./matcher";
import { categorizePositions } from "./position-categories";
import { TRACKED_APPLICATION_STATUSES, type ApplicationStatus } from "./application-status";
import { normalizeCompanyName } from "./company-normalize";

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

  -- 하나의 공고(key=seq)에서 이어지는 AI 작업 대화의 모델별 세션 위치(lib/ai-conversation.ts). 대화의 원본 기억은
  -- essay_events이고, 이 표는 모델의 네이티브 세션을 이어 쓰기 위한 위치(세션 id, 어디까지 기록을 넘겼는지)만 담는다.
  CREATE TABLE IF NOT EXISTS ai_conversations (
    key TEXT NOT NULL,
    provider TEXT NOT NULL,
    sessionId TEXT,
    lastMessageId TEXT,
    headerHash TEXT NOT NULL,
    syncedRowid INTEGER NOT NULL DEFAULT 0,
    chars INTEGER NOT NULL DEFAULT 0,
    model TEXT NOT NULL DEFAULT '',
    updatedAt INTEGER NOT NULL,
    PRIMARY KEY (key, provider)
  );

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

const selectJobsNeedingMatchStmt = db.prepare(`
  ${JOB_WITH_APPLICATION_SELECT}
  WHERE jobs.summarizedAt IS NOT NULL
    AND jobs.hidden = 0
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
  WHERE jobs.summarizedAt IS NOT NULL AND jobs.hidden = 0
  ORDER BY
    CASE WHEN jobs.matchScore IS NULL THEN 1 ELSE 0 END,
    jobs.matchScore DESC,
    jobs.date DESC
`);

// 마감일(deadline) 또는 접수기간 끝날짜가 오늘 이후면 열린 공고. 둘 다 없으면 마감 미정으로 보고 열린 것으로 친다.
function isJobOpen(row: Pick<JobRow, "deadline" | "applicationPeriod">, today: string): boolean {
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
    applicationUpdatedAt: number;
  })[];
  return rows.map((row) => ({
    ...rowToJobWithMatch(row),
    submittedAt: row.submittedAt,
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

// ---- AI 작업 대화(lib/ai-conversation.ts) ----
export interface AIConversationRow {
  key: string;
  provider: string;
  sessionId: string | null;
  lastMessageId: string | null;
  headerHash: string;
  syncedRowid: number;
  chars: number;
  model: string;
  updatedAt: number;
}

export function getAIConversationRow(key: string, provider: string): AIConversationRow | undefined {
  return db.prepare(`SELECT * FROM ai_conversations WHERE key = ? AND provider = ?`).get(key, provider) as AIConversationRow | undefined;
}

export function saveAIConversationRow(row: AIConversationRow): void {
  db.prepare(`
    INSERT INTO ai_conversations (key, provider, sessionId, lastMessageId, headerHash, syncedRowid, chars, model, updatedAt)
    VALUES (@key, @provider, @sessionId, @lastMessageId, @headerHash, @syncedRowid, @chars, @model, @updatedAt)
    ON CONFLICT(key, provider) DO UPDATE SET sessionId = excluded.sessionId, lastMessageId = excluded.lastMessageId,
      headerHash = excluded.headerHash, syncedRowid = excluded.syncedRowid, chars = excluded.chars, model = excluded.model, updatedAt = excluded.updatedAt
  `).run(row);
}

export function deleteAIConversationRow(key: string, provider: string): void {
  db.prepare(`DELETE FROM ai_conversations WHERE key = ? AND provider = ?`).run(key, provider);
}

// 한 공고의 작성 기록 중 rowid가 afterRowid보다 큰 것(기록에 들어간 순서). 대화에 아직 넘기지 않은 사건을 고른다.
export function listEssayEventRowsAfter(seq: string, afterRowid: number): (EssayEventRow & { rowid: number })[] {
  return db.prepare(`SELECT rowid, id, seq, question, type, actor, threadId, textBefore, textAfter, detail, analysis, createdAt
    FROM essay_events WHERE seq = ? AND rowid > ? ORDER BY rowid`).all(seq, afterRowid) as (EssayEventRow & { rowid: number })[];
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
