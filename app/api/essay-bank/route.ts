import { getCachedEssayBank, appendEssayEntry } from "@/lib/essay-bank";

// 과거 자소서 참고자료 현황 조회 — AI 호출 없음.
export async function GET() {
  return Response.json({ bank: getCachedEssayBank() });
}

// "지원 도우미" 탭에서 다듬어 확정한 답변을 참고자료로 저장 — 다음 초안 생성부터 반영된다.
export async function POST(request: Request) {
  const { company, question, answer } = await request.json();
  if (typeof question !== "string" || typeof answer !== "string" || !answer.trim()) {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  appendEssayEntry(typeof company === "string" ? company : "", question, answer);
  return Response.json({ ok: true });
}
