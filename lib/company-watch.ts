import type { JobDetail } from "./crawler";
import {
  getDedupCandidates,
  getExistingSeqs,
  getLinkedSeqs,
  getWatchRuns,
  hasJobUserState,
  insertJobLink,
  saveWatchRun,
  syncWatchPostingsOpen,
  type WatchRunRow,
} from "./db";
import { findDuplicate, type DedupPosting } from "./job-dedup";
import { WATCH_SEQ_PREFIXES, isKofiaSeq, isWatchSeq } from "./job-source";
import { isManualSeq } from "./manual-jobs";
import { isCollectable, readWatchlist, type CollectableSourceType, type WatchCompany, type WatchSource } from "./company-watchlist";
import { WATCH_ADAPTERS, type WatchPosting } from "./watch-adapters";
import { WatchBlockedError, createWatchFetcher, type WatchFetcher } from "./watch-fetch";

// 감시 목록(lib/company-watchlist.ts)의 채용 사이트를 돌며 금투협에 없는 공고를 찾는다. AI 없음 — 새 공고의 본문까지만
// 읽어 돌려주고, 요약·매칭·저장은 공고 수집 경로(app/api/jobs/route.ts)가 금투협 공고와 똑같이 한다.
//  - 출처마다 하루 한 번만 돈다(watch_runs). 차단(blocked)된 출처는 일주일 동안 건너뛴다. 설정 화면의 "다시 확인"이 기록을 지운다.
//  - 이미 저장했거나 중복으로 연결한 공고는 다시 열지 않는다. 마감이 지난 것이 확실한 공고(목록에 마감일이 있음)는 열지 않는다.
//  - 금투협·직접 추가 공고와 같은 공고면(lib/job-dedup.ts) 저장하지 않고 job_links에 연결만 남긴다(요약 비용도 들지 않는다).
//  - 마감일을 적지 않는 공고가 많아서(그리팅 상시 채용) 목록에서 내려간 공고를 닫힌 것으로 표시한다(jobs.sourceClosedAt).
//    회사 하나에 같은 유형의 출처가 둘이면 서로의 공고를 닫게 되므로, 그렇게 등록하지 않는다.
//  - 출처 하나가 실패해도 나머지는 계속한다.

export const WATCH_INTERVAL_MS = 20 * 60 * 60 * 1000;
const BLOCKED_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const DEDUP_WINDOW_DAYS = 150;
// 마감일 없이 오래 열린 공고는 인재풀 등록이다(교보자산신탁 "우수인재 등록시스템(DB)", 2024년부터 열림).
const STALE_OPEN_DAYS = 180;
const TALENT_POOL = /인재\s*(?:풀|pool|DB|등록)|인재풀|talent\s*pool/i;
const MAX_NEW_PER_SOURCE = 15;

export interface WatchDetail extends JobDetail {
  /** 채용 사이트가 알려 준 마감일(YYYY-MM-DD). 요약기가 찾은 값보다 우선한다. */
  knownDeadline: string;
}

export interface WatchProgress {
  current: number;
  total: number;
  company: string;
  status: WatchRunRow["status"] | "skipped";
  message: string;
  added: number;
}

export interface WatchResult {
  details: WatchDetail[];
  runs: number;
  linked: number;
}

interface WatchTask { company: WatchCompany; source: WatchSource & { type: CollectableSourceType } }

function todayYmd(now: Date): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(now);
}

function daysBefore(now: Date, days: number): string {
  return todayYmd(new Date(now.getTime() - days * 86_400_000));
}

/** 지금 돌 차례인 출처(켜져 있고, 자동 수집 유형이고, 하루가 지났거나 force). */
export function dueWatchTasks(now: Date, force = false): WatchTask[] {
  const runs = new Map(getWatchRuns().map((run) => [`${run.company}\n${run.sourceUrl}`, run]));
  const tasks: WatchTask[] = [];
  for (const company of readWatchlist().companies) {
    if (!company.enabled) continue;
    for (const source of company.sources) {
      if (!isCollectable(source.type)) continue;
      const last = runs.get(`${company.name}\n${source.url}`);
      const wait = last?.status === "blocked" ? BLOCKED_RETRY_MS : WATCH_INTERVAL_MS;
      if (!force && last && now.getTime() - last.ranAt < wait) continue;
      tasks.push({ company, source: source as WatchTask["source"] });
    }
  }
  return tasks;
}

function keepPosting(posting: WatchPosting, source: WatchSource, now: Date): boolean {
  if (source.titleIncludes?.length && !source.titleIncludes.some((word) => posting.title.includes(word))) return false;
  if (TALENT_POOL.test(posting.title)) return false;
  if (posting.deadline && posting.deadline < todayYmd(now)) return false;
  if (!posting.deadline && posting.postedAt && posting.postedAt.slice(0, 10) < daysBefore(now, STALE_OPEN_DAYS)) return false;
  return true;
}

export interface CompanyWatchDeps {
  fetcher: WatchFetcher;
  now: () => Date;
}

export async function runCompanyWatch({
  force = false,
  onProgress,
  signal,
  deps = {},
}: {
  force?: boolean;
  onProgress?: (progress: WatchProgress) => void;
  signal?: AbortSignal;
  deps?: Partial<CompanyWatchDeps>;
} = {}): Promise<WatchResult> {
  const now = deps.now ?? (() => new Date());
  const fetcher = deps.fetcher ?? createWatchFetcher(fetch, { signal });
  const tasks = dueWatchTasks(now(), force);
  const details: WatchDetail[] = [];
  let linked = 0;
  // 같은 채용 사이트를 쓰는 회사(NICE그룹, 한투금융 채용포탈)는 목록을 한 번만 받는다.
  const listCache = new Map<string, Promise<WatchPosting[]>>();

  for (let i = 0; i < tasks.length; i++) {
    if (signal?.aborted) break;
    const { company, source } = tasks[i];
    const adapter = WATCH_ADAPTERS[source.type];
    const run: WatchRunRow = { company: company.name, sourceUrl: source.url, sourceType: source.type, status: "ok", message: "", found: 0, added: 0, ranAt: now().getTime() };
    try {
      const cacheKey = `${source.type}\n${source.url}`;
      if (!listCache.has(cacheKey)) listCache.set(cacheKey, adapter.list(source.url, fetcher));
      const postings = (await listCache.get(cacheKey)!).filter((p) => keepPosting(p, source, now()));
      run.found = postings.length;
      syncWatchPostingsOpen(company.name, WATCH_SEQ_PREFIXES[source.type], postings.map((p) => p.seq), now().getTime());

      const seqs = postings.map((p) => p.seq);
      const known = new Set([...getExistingSeqs(seqs), ...getLinkedSeqs(seqs)]);
      const candidates: DedupPosting[] = getDedupCandidates(daysBefore(now(), DEDUP_WINDOW_DAYS))
        .map((row) => ({ seq: row.seq, company: row.company, title: row.title, deadline: row.deadline, url: row.siteUrl }));

      let opened = 0;
      for (const posting of postings) {
        if (known.has(posting.seq) || details.some((d) => d.seq === posting.seq)) continue;
        const duplicate = findDuplicate({ seq: posting.seq, company: company.name, title: posting.title, deadline: posting.deadline, url: posting.url }, candidates);
        if (duplicate) {
          insertJobLink({ seq: posting.seq, canonicalSeq: duplicate.match.seq, reason: duplicate.reason, title: posting.title, url: posting.url });
          linked += 1;
          continue;
        }
        if (opened >= MAX_NEW_PER_SOURCE) break;
        opened += 1;
        const content = await adapter.content(posting, fetcher);
        details.push({
          seq: posting.seq,
          company: company.name,
          title: posting.title,
          date: posting.postedAt || new Intl.DateTimeFormat("sv-SE", {
            timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
          }).format(now()),
          views: "",
          applicationPeriod: "",
          siteUrl: posting.url,
          attachments: [],
          content,
          knownDeadline: posting.deadline,
        });
        run.added += 1;
      }
      run.status = postings.length === 0 ? "empty" : "ok";
      run.message = postings.length === 0 ? "진행 중인 공고 없음" : `진행 중 ${postings.length}건, 새 공고 ${run.added}건`;
    } catch (error) {
      run.status = error instanceof WatchBlockedError ? "blocked" : "failed";
      run.message = error instanceof Error ? error.message : String(error);
      console.error(`[company-watch] ${company.name} ${source.url}: ${run.message}`);
    }
    if (signal?.aborted) break; // 중간에 끊긴 출처는 기록하지 않아 다음 새로고침에 다시 돈다
    saveWatchRun(run);
    onProgress?.({ current: i + 1, total: tasks.length, company: company.name, status: run.status, message: run.message, added: run.added });
  }
  return { details, runs: tasks.length, linked };
}

/**
 * 금투협에 새로 올라온 공고가 이미 저장된 채용 사이트·직접 추가 공고와 같으면 한쪽을 목록에서 뺀다.
 * 사용자가 손댄 쪽(지원 상태·찜·초안·메모)과 직접 추가한 공고를 남기고, 그 밖에는 금투협 공고를 남긴다.
 */
export function linkKofiaDuplicates(kofia: DedupPosting[], now: Date = new Date()): number {
  if (kofia.length === 0) return 0;
  const others = getDedupCandidates(daysBefore(now, DEDUP_WINDOW_DAYS))
    .filter((row) => !isKofiaSeq(row.seq))
    .map((row) => ({ seq: row.seq, company: row.company, title: row.title, deadline: row.deadline, url: row.siteUrl }));
  let linked = 0;
  for (const posting of kofia) {
    const duplicate = findDuplicate(posting, others);
    if (!duplicate) continue;
    const other = duplicate.match;
    const keepOther = isManualSeq(other.seq) || (isWatchSeq(other.seq) && hasJobUserState(other.seq));
    const [drop, keep] = keepOther ? [posting, other] : [other, posting];
    insertJobLink({ seq: drop.seq, canonicalSeq: keep.seq, reason: duplicate.reason, title: drop.title, url: drop.url });
    linked += 1;
  }
  return linked;
}
