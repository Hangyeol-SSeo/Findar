import { fetchListPage, fetchDetailPage, type JobDetail } from "@/lib/crawler";
import { summarizeJob } from "@/lib/summarizer";
import { getExistingSeqs, upsertJob, getActiveJobs } from "@/lib/db";
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

        // 신규 + 재시도 대상 추출 (DB에 없거나 summarizedAt IS NULL)
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

        // 3단계: AI 요약 + DB 저장
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

          const elapsed = Date.now() - startTime;
          const avgPerJob = elapsed / (i + 1);
          const remaining = Math.round((avgPerJob * (details.length - i - 1)) / 1000);

          send({
            type: "summarize-progress",
            current: i + 1,
            total: details.length,
            remainingSeconds: remaining,
            job: summary,
          });
        }

        // DB에서 마감일 안 지난 공고 전부 반환
        const activeJobs = getActiveJobs();
        send({ type: "done", jobs: activeJobs, newCount: details.length });
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
