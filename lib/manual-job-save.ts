import { randomBytes } from "crypto";
import { clearJobMatch, getJobBySeq, updateJobMatch, upsertJob, type JobWithMatch } from "./db";
import { fallbackSummary, summarizeJob, type JobSummary } from "./summarizer";
import { matchJobBatch } from "./matcher";
import { getCachedProfile, type Profile } from "./profile";
import { MANUAL_SEQ_PREFIX, isManualSeq, type ManualJobInput } from "./manual-jobs";
import type { JobDetail } from "./crawler";

// 직접 추가한 공고를 저장한다. 크롤링한 공고와 같은 요약(summarizeJob)·매칭(matchJobBatch)을 한 건만 돌린다.
// 요약이 실패해도 공고는 남긴다(jdSummary "요약 실패") — KOFIA 공고와 달리 다음 크롤링이 다시 요약해 주지 않으므로,
// summarizedAt을 채워 목록에 보이게 하고 사용자가 수정 저장으로 다시 요약하게 한다.
// 매칭은 이미 분석된 이력서(getCachedProfile)가 있을 때만 하고, 실패하면 다음 새로고침의 재매칭이 채운다.

export interface ManualJobDeps {
  summarize: (job: JobDetail) => Promise<JobSummary>;
  match: (profile: Profile, jobs: JobSummary[]) => Promise<Map<string, import("./matcher").JobMatch>>;
  profile: () => Profile | null;
  now: () => Date;
}

const defaultDeps: ManualJobDeps = {
  summarize: summarizeJob,
  match: matchJobBatch,
  profile: getCachedProfile,
  now: () => new Date(),
};

export interface ManualJobSaveResult {
  job: JobWithMatch;
  summarized: boolean;
  matched: boolean;
}

export class ManualJobError extends Error {}

export function newManualSeq(now: Date): string {
  return `${MANUAL_SEQ_PREFIX}${now.getTime().toString(36)}${randomBytes(3).toString("hex")}`;
}

// KOFIA 목록의 등록일과 같은 형식(서울 기준 "YYYY-MM-DD HH:mm:ss").
function seoulDateTime(date: Date): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(date);
}

export async function saveManualJob(
  input: ManualJobInput,
  seq?: string,
  deps: Partial<ManualJobDeps> = {}
): Promise<ManualJobSaveResult> {
  const { summarize, match, profile: loadProfile, now } = { ...defaultDeps, ...deps };
  const existing = seq ? getJobBySeq(seq) : undefined;
  if (seq && (!isManualSeq(seq) || !existing)) throw new ManualJobError("직접 추가한 공고만 수정할 수 있습니다.");

  const jobSeq = seq ?? newManualSeq(now());
  const detail: JobDetail = {
    seq: jobSeq,
    company: input.company,
    title: input.title,
    date: existing?.date ?? seoulDateTime(now()),
    views: "",
    applicationPeriod: "",
    siteUrl: input.url,
    attachments: [],
    content: input.content,
  };

  // 회사·제목·본문이 그대로면(링크·마감일만 고친 경우) 요약과 매칭을 다시 하지 않는다.
  const reuse = existing && existing.jdSummary !== "요약 실패"
    && existing.company === input.company && existing.title === input.title && existing.rawContent === input.content;

  let summary: JobSummary;
  let summarized: boolean;
  if (reuse) {
    summary = { ...existing, siteUrl: input.url, deadline: input.deadline || existing.deadline };
    summarized = true;
  } else {
    try {
      summary = await summarize(detail);
    } catch (error) {
      console.error(`[manual-job] ${jobSeq} 요약 실패:`, error);
      summary = fallbackSummary(detail);
    }
    summarized = summary.jdSummary !== "요약 실패";
    if (input.deadline) summary = { ...summary, deadline: input.deadline };
  }

  upsertJob({ summary, rawContent: input.content, summarizedOk: true });
  if (!reuse) clearJobMatch(jobSeq);

  let matched = false;
  const profile = loadProfile();
  if (profile && summarized && !(reuse && existing?.matchProfileHash === profile.sourcesHash)) {
    try {
      const result = (await match(profile, [summary])).get(jobSeq);
      if (result) {
        updateJobMatch(jobSeq, result, profile.sourcesHash);
        matched = true;
      }
    } catch (error) {
      console.error(`[manual-job] ${jobSeq} 매칭 실패:`, error);
    }
  } else if (reuse && existing?.matchScore !== undefined) {
    matched = true;
  }

  const saved = getJobBySeq(jobSeq);
  if (!saved) throw new ManualJobError("공고를 저장하지 못했습니다.");
  const { rawContent: _rawContent, ...job } = saved;
  void _rawContent;
  return { job, summarized, matched };
}
