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
import { ensureProfile, getCachedProfile, type Profile } from "@/lib/profile";
import { matchJobBatch, FALLBACK_MATCH, type JobMatch } from "@/lib/matcher";
import { FreeRideRequestError } from "@/lib/job-ai";
import { after } from "next/server";
import { runSeasonCheck } from "@/lib/hiring-season";
import { isNotPosting, linkKofiaDuplicates, recordNotPosting, runCompanyWatch } from "@/lib/company-watch";
import { jobSource } from "@/lib/job-source";
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

  // 크롤링/AI 호출 없이 이미 저장된 공고만 보여줄 때(예: 화면을 새로 마운트할 때) 쓰는
  // 가벼운 경로 — 설정 페이지를 왔다갔다 할 때마다 전체 파이프라인이 다시 도는 걸 방지한다.
  if (searchParams.get("cachedOnly") === "true") {
    return Response.json({
      jobs: getActiveJobs(),
      hasProfile: !!getCachedProfile(),
    });
  }

  const pages = Math.min(
    parseInt(searchParams.get("pages") || String(CRAWL_PAGES)),
    50
  );
  const matchEnabled = searchParams.get("match") !== "false";
  // 회사 채용 사이트 확인: 기본은 출처마다 하루 한 번, "force"는 지금 전부, "off"는 건너뜀.
  const watchParam = searchParams.get("watch");
  const watchMode = watchParam === "off" || watchParam === "force" ? watchParam : "daily";

  // 공채 시즌 감지는 웹 검색이라 몇 분 걸린다. 새로고침 응답을 막지 않게 응답이 끝난 뒤 돌린다(시즌 중, 회사마다 주 1회).
  if (watchMode !== "off") {
    after(() => runSeasonCheck().then((result) => {
      if (result.checked || result.failed) console.info("[hiring-season]", JSON.stringify(result));
    }).catch((error) => console.error("[hiring-season] 실패:", error)));
  }

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
        // 금투협 공고와 채용 사이트 공고가 같은 경로를 탄다. knownDeadline은 채용 사이트가 알려 준 마감일(요약보다 우선).
        async function summarizeAndStore(items: (JobDetail & { knownDeadline?: string; mayNotBePosting?: boolean })[]): Promise<JobSummary[]> {
          send({
            type: "phase",
            phase: "summarize",
            message:
              items.length === 0
                ? "AI 요약 건너뜀"
                : `AI 요약 중... (0/${items.length})`,
            total: items.length,
          });

          const startTime = Date.now();
          let processed = 0;
          const stored: JobSummary[] = [];

          for (let i = 0; i < items.length; i += SUMMARIZE_BATCH_SIZE) {
            if (closed) return stored; // 남은 배치의 AI 요약/매칭 호출을 시작하지 않음
            const chunk = items.slice(i, i + SUMMARIZE_BATCH_SIZE);

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
              let finalSummary = summary ?? fallbackSummary(detail);
              if (detail.knownDeadline) finalSummary = { ...finalSummary, deadline: detail.knownDeadline };
              // 자체 게시판 글이 채용 안내·결과 발표 글이면(isNotPosting) 저장하지 않고 다시 열지 않게 기록한다.
              // 요약이 실패한 글은 기록하지 않는다 — 다음 확인 때 다시 연다.
              if (summarizedOk && isNotPosting({ title: detail.title, mayNotBePosting: detail.mayNotBePosting === true }, finalSummary)) {
                recordNotPosting(detail);
                processed += 1;
                continue;
              }
              upsertJob({ summary: finalSummary, rawContent: detail.content, summarizedOk });
              if (summarizedOk) chunkSummaries.push(finalSummary);
              stored.push(finalSummary);

              processed += 1;
              const elapsed = Date.now() - startTime;
              const avgPerJob = elapsed / processed;
              const remaining = Math.round((avgPerJob * (items.length - processed)) / 1000);

              // 매칭 전에 먼저 전송 (매칭 배치 호출 때문에 progress bar가 멈춰 보이지 않도록)
              send({
                type: "summarize-progress",
                current: processed,
                total: items.length,
                remainingSeconds: remaining,
                source: jobSource(detail.seq),
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
          return stored;
        }

        const kofiaStored = await summarizeAndStore(details);
        if (closed) return;
        // 이미 저장된 채용 사이트·직접 추가 공고와 같은 금투협 공고면 한쪽을 목록에서 뺀다(lib/job-dedup.ts).
        linkKofiaDuplicates(kofiaStored.map((s) => ({ seq: s.seq, company: s.company, title: s.title, deadline: s.deadline, url: s.siteUrl })));

        // 4-1단계: 감시 목록의 채용 사이트(금투협에 없는 공채·인턴 등). 출처마다 하루 한 번(lib/company-watch.ts).
        let watchNew = 0;
        if (watchMode !== "off") {
          send({ type: "phase", phase: "watch", message: "회사 채용 사이트 확인 중..." });
          const watch = await runCompanyWatch({
            force: watchMode === "force",
            signal: request.signal,
            onProgress: (p) =>
              send({
                type: "watch-progress",
                current: p.current,
                total: p.total,
                company: p.company,
                status: p.status,
                added: p.added,
              }),
          });
          if (closed) return;
          watchNew = watch.details.length;
          if (watch.details.length > 0) await summarizeAndStore(watch.details);
          if (closed) return;
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
          newCount: details.length + watchNew,
          hasProfile: !!profile,
        });
      } catch (error) {
        console.error("SSE error:", error);
        send({ type: "error", message: error instanceof FreeRideRequestError ? error.message : "처리 중 오류가 발생했습니다." });
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
