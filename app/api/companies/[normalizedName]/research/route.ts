import {
  researchSection,
  listStaleSections,
  COMPANY_SECTION_TYPES,
  type CompanySectionType,
} from "@/lib/company-research";

// app/api/jobs/route.ts와 동일한 SSE 프레이밍(data: ...\n\n)을 재사용한다.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ normalizedName: string }> }
) {
  const { normalizedName } = await params;
  const { displayName, sections, force } = await request.json();
  if (!displayName || typeof displayName !== "string") {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }

  const requested: CompanySectionType[] | undefined = Array.isArray(sections)
    ? sections.filter((s): s is CompanySectionType =>
        (COMPANY_SECTION_TYPES as readonly string[]).includes(s)
      )
    : undefined;

  // 이미 신선한(TTL 안 지난) 섹션은 건너뛴다 — 단, force=true면(개별 섹션 새로고침) 무시.
  const targets = listStaleSections(normalizedName, requested, force === true);

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
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      }

      try {
        send({ type: "targets", sectionTypes: targets });
        for (const sectionType of targets) {
          if (closed) return;
          send({ type: "section-start", sectionType });
          try {
            const section = await researchSection(normalizedName, displayName, sectionType);
            send({ type: "section-done", sectionType, section });
          } catch (e) {
            console.error(`[company-research] 섹션 실패 (${sectionType}):`, e);
            send({
              type: "section-error",
              sectionType,
              message: "리서치 중 오류가 발생했습니다.",
            });
          }
        }
        send({ type: "done" });
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
