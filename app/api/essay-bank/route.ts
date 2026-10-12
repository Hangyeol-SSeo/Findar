import { getCachedEssayBank } from "@/lib/essay-bank";

// 과거 자소서 참고자료 현황 조회 — AI 호출 없음. 최종본 저장은 POST /api/applications/[seq]/draft/final.
export async function GET() {
  return Response.json({ bank: getCachedEssayBank() });
}
