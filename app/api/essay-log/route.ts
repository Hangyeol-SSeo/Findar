import { getEssayLogSummary, listEssayEvents } from "@/lib/essay-log";
import { ESSAY_EVENT_TYPES, type EssayEventType } from "@/lib/essay-log-analysis";

export const runtime = "nodejs";

const MAX_LIMIT = 5000;

// 자기소개서 작성 기록 조회 — AI 호출 없음.
//  ?view=summary  해석된 통계(요청과 결과, 첨삭 유형별 반영/넘김, 직접 수정 위치·성격, 문체 문제 변화)
//  ?format=jsonl  전체 기록을 한 줄에 하나씩 내려받기(분석·백업용)
//  그 외          사건 목록(JSON). seq, question, type(쉼표 구분), threadId, since, until, limit, text=0(전후 전문 제외)
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const types = (params.get("type") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const unknown = types.filter((t) => !ESSAY_EVENT_TYPES.includes(t as EssayEventType));
  if (unknown.length) return Response.json({ error: `알 수 없는 기록 종류: ${unknown.join(", ")}` }, { status: 400 });
  const num = (name: string) => {
    const value = Number(params.get(name));
    return params.get(name) && Number.isFinite(value) ? value : undefined;
  };
  const filter = {
    seq: params.get("seq") ?? undefined,
    question: params.get("question") ?? undefined,
    threadId: params.get("threadId") ?? undefined,
    types: types.length ? types : undefined,
    since: num("since"),
    until: num("until"),
  };

  if (params.get("view") === "summary") return Response.json({ summary: getEssayLogSummary(filter) });

  if (params.get("format") === "jsonl") {
    const body = listEssayEvents(filter).map((e) => JSON.stringify(e)).join("\n");
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(body ? `${body}\n` : "", { headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="findar-essay-log-${stamp}.jsonl"`,
    } });
  }

  const limit = Math.min(MAX_LIMIT, Math.max(1, num("limit") ?? 500));
  const withText = params.get("text") !== "0";
  const events = listEssayEvents({ ...filter, limit }).map((e) => (withText ? e : { ...e, textBefore: null, textAfter: null }));
  return Response.json({ events });
}
