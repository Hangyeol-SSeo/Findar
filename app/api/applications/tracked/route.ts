import { after } from "next/server";
import { getTrackedApplicationJobs } from "@/lib/db";
import { flushPendingSheetSync } from "@/lib/sheet-sync";

// 검토중부터 추적하는 공고 — 마감이 지났거나 숨긴 공고도 포함한다. AI 호출 없음.
export async function GET() {
  // 이전에 시트 기록에 실패한 지원 상태가 있으면 이 김에 다시 보낸다.
  after(() => flushPendingSheetSync());
  return Response.json({ jobs: getTrackedApplicationJobs() }, { headers: { "Cache-Control": "private, no-store" } });
}
