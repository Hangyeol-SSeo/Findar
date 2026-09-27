import { getTrackedApplicationJobs } from "@/lib/db";

// 제출완료 이후 단계의 공고 — 마감이 지났거나 숨긴 공고도 포함한다. AI 호출 없음.
export async function GET() {
  return Response.json({ jobs: getTrackedApplicationJobs() }, { headers: { "Cache-Control": "private, no-store" } });
}
