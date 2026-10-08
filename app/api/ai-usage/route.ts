import { getAIUsage } from "@/lib/ai-usage";

export const runtime = "nodejs";

// AI 호출별 실제 사용량(새로 처리한 입력·캐시에서 읽은 입력·출력 토큰). ?seq=로 공고 하나의 작업 대화만, ?days=로 기간을 좁힌다. AI 호출 없음.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const days = Number(params.get("days"));
  const limit = Number(params.get("limit"));
  return Response.json(getAIUsage({
    key: params.get("seq") ?? undefined,
    since: Number.isFinite(days) && days > 0 ? Date.now() - days * 86_400_000 : undefined,
    limit: Number.isFinite(limit) && limit > 0 ? limit : 500,
  }), { headers: { "Cache-Control": "private, no-store" } });
}
