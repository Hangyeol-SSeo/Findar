import { NextResponse } from "next/server";
import { fetchListPage, fetchDetailPage, type JobDetail } from "@/lib/crawler";
import { summarizeJob, type JobSummary } from "@/lib/summarizer";
import { getCache, setCache } from "@/lib/cache";

const CACHE_KEY = "jobs";
const DEFAULT_PAGES = 7;
const DELAY_MS = 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const refresh = searchParams.get("refresh") === "true";
  const pages = Math.min(
    parseInt(searchParams.get("pages") || String(DEFAULT_PAGES)),
    15
  );

  // 캐시 확인
  if (!refresh) {
    const cached = getCache<JobSummary[]>(CACHE_KEY);
    if (cached) {
      return NextResponse.json({ jobs: cached, fromCache: true });
    }
  }

  // SSE 스트리밍
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

        const totalJobs = allListItems.length;
        send({
          type: "phase",
          phase: "detail",
          message: `${totalJobs}개 공고 상세 정보 수집 중...`,
          total: totalJobs,
        });

        // 2단계: 상세 페이지 크롤링
        const details: JobDetail[] = [];
        for (let i = 0; i < allListItems.length; i++) {
          await sleep(DELAY_MS);
          const detail = await fetchDetailPage(allListItems[i].seq);
          if (detail) details.push(detail);
          send({
            type: "crawl-detail",
            current: i + 1,
            total: totalJobs,
          });
        }

        // 3단계: AI 요약
        send({
          type: "phase",
          phase: "summarize",
          message: `AI 요약 중... (0/${details.length})`,
          total: details.length,
        });

        const summarized: JobSummary[] = [];
        const startTime = Date.now();

        for (let i = 0; i < details.length; i++) {
          try {
            const summary = await summarizeJob(details[i]);
            summarized.push(summary);
          } catch (e) {
            console.error(`Failed to summarize ${details[i].seq}:`, e);
            summarized.push({
              seq: details[i].seq,
              company: details[i].company,
              title: details[i].title,
              date: details[i].date,
              applicationPeriod: details[i].applicationPeriod,
              siteUrl: details[i].siteUrl,
              attachments: details[i].attachments,
              positionType: "미분류",
              experienceYears: "미분류",
              positions: [],
              jdSummary: "요약 실패",
              qualifications: [],
              deadline: "",
            });
          }

          const elapsed = Date.now() - startTime;
          const avgPerJob = elapsed / (i + 1);
          const remaining = Math.round((avgPerJob * (details.length - i - 1)) / 1000);

          send({
            type: "summarize-progress",
            current: i + 1,
            total: details.length,
            remainingSeconds: remaining,
            job: summarized[summarized.length - 1],
          });
        }

        // 캐시 저장
        setCache(CACHE_KEY, summarized);

        send({ type: "done", jobs: summarized });
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
