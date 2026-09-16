import { fetchListPage, fetchDetailPage, type JobDetail } from "@/lib/crawler";
import {
  summarizeJob,
  summarizeJobBatch,
  fallbackSummary,
  type JobSummary,
} from "@/lib/summarizer";
import {
  getExistingSeqs,
  upsertJob,
  getActiveJobs,
  updateJobMatch,
  getJobsNeedingMatch,
  skipLowScoreMatches,
} from "@/lib/db";
import { ensureProfile, type Profile } from "@/lib/profile";
import { matchJobBatch, FALLBACK_MATCH, type JobMatch } from "@/lib/matcher";
import {
  CRAWL_PAGES,
  REMATCH_SKIP_THRESHOLD,
  REMATCH_BATCH_SIZE,
  SUMMARIZE_BATCH_SIZE,
} from "@/lib/config";

const DELAY_MS = 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const pages = Math.min(
    parseInt(searchParams.get("pages") || String(CRAWL_PAGES)),
    50
  );
  const matchEnabled = searchParams.get("match") !== "false";

  const encoder = new TextEncoder();
  let closed = false;
  request.signal.addEventListener("abort", () => {
    closed = true;
  });
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
        // 0단계: 캐시된 공고 즉시 전송 (크롤링/요약 시작 전, 새로고침 시 빈 화면 방지)
        send({ type: "cached", jobs: getActiveJobs() });

        // 1단계: 프로필 확보 (매칭이 꺼져 있으면 건너뜀)
        let profile: Profile | null = null;
        if (matchEnabled) {
          send({ type: "phase", phase: "profile", message: "프로필 확인 중..." });
          const profileResult = await ensureProfile({
            onProgress: (msg) =>
              send({ type: "phase", phase: "profile", message: msg }),
          });
          profile = profileResult.profile;
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
        } else {
          send({ type: "profile-ready", status: "disabled" });
        }

        if (closed) return; // 클라이언트가 이미 연결을 끊었으면 여기서 중단

        // 2단계: 리스트 크롤링
        send({ type: "phase", phase: "crawl", message: "공고 목록 수집 중..." });

        const allListItems: { seq: string; company: string; title: string; date: string }[] = [];
        for (let page = 1; page <= pages; page++) {
          if (closed) return; // 새로고침/페이지 수 변경 등으로 클라이언트가 연결을 끊으면 남은 페이지 크롤링을 건너뜀
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

        // 3단계: 신규만 상세 페이지 크롤링
        const details: JobDetail[] = [];
        for (let i = 0; i < newItems.length; i++) {
          if (closed) return;
          await sleep(DELAY_MS);
          const detail = await fetchDetailPage(newItems[i].seq);
          if (detail) details.push(detail);
          send({
            type: "crawl-detail",
            current: i + 1,
            total: newItems.length,
          });
        }

        // 4단계: AI 요약 + 매칭 + DB 저장 (여러 건씩 묶어서 처리 — 호출 횟수/시간/토큰 절약)
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
        let processed = 0;

        for (let i = 0; i < details.length; i += SUMMARIZE_BATCH_SIZE) {
          if (closed) return; // 남은 배치의 AI 요약/매칭 호출을 시작하지 않음
          const chunk = details.slice(i, i + SUMMARIZE_BATCH_SIZE);

          const summarized = await summarizeJobBatch(chunk);
          const missing = chunk.filter((d) => !summarized.has(d.seq));
          if (missing.length > 0) {
            // 배치 파싱 실패분만 개별 재시도 (전체 배치를 버리지 않음)
            for (const detail of missing) {
              try {
                summarized.set(detail.seq, await summarizeJob(detail));
              } catch (e) {
                console.error(`Failed to summarize ${detail.seq}:`, e);
              }
            }
          }

          const chunkSummaries: JobSummary[] = [];
          for (const detail of chunk) {
            const summary = summarized.get(detail.seq);
            const summarizedOk = !!summary && summary.jdSummary !== "요약 실패";
            const finalSummary = summary ?? fallbackSummary(detail);
            upsertJob({ summary: finalSummary, rawContent: detail.content, summarizedOk });
            if (summarizedOk) chunkSummaries.push(finalSummary);

            processed += 1;
            const elapsed = Date.now() - startTime;
            const avgPerJob = elapsed / processed;
            const remaining = Math.round((avgPerJob * (details.length - processed)) / 1000);

            // 매칭 전에 먼저 전송 (매칭 배치 호출 때문에 progress bar가 멈춰 보이지 않도록)
            send({
              type: "summarize-progress",
              current: processed,
              total: details.length,
              remainingSeconds: remaining,
              job: { ...finalSummary },
            });
          }

          // 매칭 (프로필이 있고 이번 청크에서 요약에 성공한 공고만, 한 번에 배치 호출)
          if (profile && chunkSummaries.length > 0) {
            try {
              const matched = await matchJobBatch(profile, chunkSummaries);
              for (const [seq, m] of matched) {
                updateJobMatch(seq, m, profile.sourcesHash);
              }
            } catch (e) {
              console.error(`Failed to match chunk at ${i}:`, e);
            }
          }
        }

        // 5단계: 프로필 해시가 바뀌었으면 기존 공고 일괄 재매칭
        if (profile && !closed) {
          const skipped = skipLowScoreMatches(profile.sourcesHash, REMATCH_SKIP_THRESHOLD);
          const toRematch = getJobsNeedingMatch(profile.sourcesHash);
          if (toRematch.length > 0) {
            send({
              type: "phase",
              phase: "rematch",
              message: `기존 공고 ${toRematch.length}건 재평가 중...${skipped > 0 ? ` (저점수 ${skipped}건 스킵)` : ""}`,
              total: toRematch.length,
            });
            for (let i = 0; i < toRematch.length; i += REMATCH_BATCH_SIZE) {
              if (closed) return; // 남은 재매칭 배치를 시작하지 않음
              const batch = toRematch.slice(i, i + REMATCH_BATCH_SIZE);
              let matchResults = new Map<string, JobMatch>();
              try {
                matchResults = await matchJobBatch(profile, batch);
              } catch (e) {
                console.error(`Failed to rematch batch at ${i}:`, e);
              }
              for (let j = 0; j < batch.length; j++) {
                const job = batch[j];
                const m = matchResults.get(job.seq) ?? FALLBACK_MATCH;
                updateJobMatch(job.seq, m, profile.sourcesHash);
                send({
                  type: "rematch-progress",
                  current: i + j + 1,
                  total: toRematch.length,
                  job: { ...job, ...m },
                });
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
