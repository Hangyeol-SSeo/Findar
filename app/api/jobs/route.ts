import { fetchListPage, fetchDetailPage, type JobDetail } from "@/lib/crawler";
import { summarizeJob } from "@/lib/summarizer";
import {
  getExistingSeqs,
  upsertJob,
  getActiveJobs,
  updateJobMatch,
  getJobsNeedingMatch,
} from "@/lib/db";
import { ensureProfile } from "@/lib/profile";
import { matchJob } from "@/lib/matcher";
import { CRAWL_PAGES } from "@/lib/config";

const DELAY_MS = 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const pages = Math.min(
    parseInt(searchParams.get("pages") || String(CRAWL_PAGES)),
    15
  );

  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      function send(data: Record<string, unknown>) {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          closed = true;
        }
      }

      try {
        // 0단계: 프로필 확보
        send({ type: "phase", phase: "profile", message: "프로필 확인 중..." });
        const profileResult = await ensureProfile({
          onProgress: (msg) =>
            send({ type: "phase", phase: "profile", message: msg }),
        });
        const profile = profileResult.profile;
        if (profile) {
          send({
            type: "profile-ready",
            status: profileResult.status,
            name: profile.name,
          });
        } else {
          send({
            type: "profile-ready",
            status: profileResult.status,
            error: profileResult.error,
          });
        }

        // 1단계: 리스트 크롤링
        send({ type: "phase", phase: "crawl", message: "공고 목록 수집 중..." });

        const allListItems: { seq: string; company: string; title: string; date: string }[] = [];
        for (let page = 1; page <= pages; page++) {
          const items = await fetchListPage(page);
          allListItems.push(...items);
          send({
            type: "crawl-list",
            page,
            totalPages: pages,
            count: allListItems.length,
          });
          if (items.length === 0) break;
          if (page < pages) await sleep(DELAY_MS);
        }

        const allSeqs = allListItems.map((i) => i.seq);
        const existingSeqs = getExistingSeqs(allSeqs);
        const newItems = allListItems.filter((i) => !existingSeqs.has(i.seq));

        send({
          type: "phase",
          phase: "detail",
          message:
            newItems.length === 0
              ? "신규 공고 없음"
              : `신규 ${newItems.length}건 상세 정보 수집 중...`,
          total: newItems.length,
        });

        // 2단계: 신규만 상세 페이지 크롤링
        const details: JobDetail[] = [];
        for (let i = 0; i < newItems.length; i++) {
          await sleep(DELAY_MS);
          const detail = await fetchDetailPage(newItems[i].seq);
          if (detail) details.push(detail);
          send({
            type: "crawl-detail",
            current: i + 1,
            total: newItems.length,
          });
        }

        // 3단계: AI 요약 + 매칭 + DB 저장
        send({
          type: "phase",
          phase: "summarize",
          message:
            details.length === 0
              ? "AI 요약 건너뜀"
              : `AI 요약 중... (0/${details.length})`,
          total: details.length,
        });

        const startTime = Date.now();

        for (let i = 0; i < details.length; i++) {
          const detail = details[i];
          let summarizedOk = true;
          let summary;
          try {
            summary = await summarizeJob(detail);
            if (summary.jdSummary === "요약 실패") summarizedOk = false;
          } catch (e) {
            console.error(`Failed to summarize ${detail.seq}:`, e);
            summarizedOk = false;
            summary = {
              seq: detail.seq,
              company: detail.company,
              title: detail.title,
              date: detail.date,
              applicationPeriod: detail.applicationPeriod,
              siteUrl: detail.siteUrl,
              attachments: detail.attachments,
              positionType: "미분류",
              experienceYears: "미분류",
              positions: [],
              jdSummary: "요약 실패",
              qualifications: [],
              deadline: "",
            };
          }

          upsertJob({ summary, rawContent: detail.content, summarizedOk });

          // 매칭 (프로필이 있고 요약 성공한 경우만)
          let matched: Awaited<ReturnType<typeof matchJob>> | undefined;
          if (profile && summarizedOk) {
            try {
              matched = await matchJob(profile, summary);
              updateJobMatch(summary.seq, matched, profile.sourcesHash);
            } catch (e) {
              console.error(`Failed to match ${summary.seq}:`, e);
            }
          }

          const elapsed = Date.now() - startTime;
          const avgPerJob = elapsed / (i + 1);
          const remaining = Math.round((avgPerJob * (details.length - i - 1)) / 1000);

          send({
            type: "summarize-progress",
            current: i + 1,
            total: details.length,
            remainingSeconds: remaining,
            job: { ...summary, ...(matched ?? {}) },
          });
        }

        // 4단계: 프로필 해시가 바뀌었으면 기존 공고 일괄 재매칭
        if (profile) {
          const toRematch = getJobsNeedingMatch(profile.sourcesHash);
          if (toRematch.length > 0) {
            send({
              type: "phase",
              phase: "rematch",
              message: `기존 공고 ${toRematch.length}건 재평가 중...`,
              total: toRematch.length,
            });
            for (let i = 0; i < toRematch.length; i++) {
              const job = toRematch[i];
              try {
                const m = await matchJob(profile, job);
                updateJobMatch(job.seq, m, profile.sourcesHash);
                send({
                  type: "rematch-progress",
                  current: i + 1,
                  total: toRematch.length,
                  job: { ...job, ...m },
                });
              } catch (e) {
                console.error(`Failed to rematch ${job.seq}:`, e);
              }
            }
          }
        }

        // 응답: 마감일 안 지난 공고 전부 (매칭 점수 내림차순 정렬)
        const activeJobs = getActiveJobs();
        send({
          type: "done",
          jobs: activeJobs,
          newCount: details.length,
          hasProfile: !!profile,
        });
      } catch (error) {
        console.error("SSE error:", error);
        send({ type: "error", message: "처리 중 오류가 발생했습니다." });
      } finally {
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
