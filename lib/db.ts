import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, renameSync } from "fs";
import { join } from "path";
import type { JobSummary } from "./summarizer";
import type { JobMatch } from "./matcher";

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
}

export type JobWithMatch = JobSummary & Partial<JobMatch> & {
  matchProfileHash?: string | null;
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
    matchScore: row.matchScore ?? undefined,
    matchVerdict: (row.matchVerdict as JobMatch["matchVerdict"] | null) ?? undefined,
    matchStrengths: row.matchStrengths ? JSON.parse(row.matchStrengths) : undefined,
    matchGaps: row.matchGaps ? JSON.parse(row.matchGaps) : undefined,
    matchReasoning: row.matchReasoning ?? undefined,
    matchProfileHash: row.matchProfileHash,
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
    @attachments, @positionType, @experienceYears, @positions, '[]',
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

const selectJobsNeedingMatchStmt = db.prepare(`
  SELECT * FROM jobs
  WHERE summarizedAt IS NOT NULL
    AND (matchProfileHash IS NULL OR matchProfileHash != ?)
`);

export function getJobsNeedingMatch(profileHash: string): JobWithMatch[] {
  const rows = selectJobsNeedingMatchStmt.all(profileHash) as JobRow[];
  return rows.map(rowToJobWithMatch);
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
  const end = (parts[1] || parts[0]).trim();
  if (/^\d{8}$/.test(end)) {
    return `${end.slice(0, 4)}-${end.slice(4, 6)}-${end.slice(6, 8)}`;
  }
  return "";
}

const selectActiveJobsStmt = db.prepare(
  `SELECT * FROM jobs WHERE summarizedAt IS NOT NULL
   ORDER BY
     CASE WHEN matchScore IS NULL THEN 1 ELSE 0 END,
     matchScore DESC,
     date DESC`
);

export function getActiveJobs(): JobWithMatch[] {
  const today = todayYmd();
  const rows = selectActiveJobsStmt.all() as JobRow[];
  return rows
    .filter((row) => {
      const deadlineOk = /^\d{4}-\d{2}-\d{2}$/.test(row.deadline);
      if (deadlineOk) return row.deadline >= today;
      const periodEnd = applicationPeriodEnd(row.applicationPeriod);
      if (periodEnd) return periodEnd >= today;
      return true;
    })
    .map(rowToJobWithMatch);
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
