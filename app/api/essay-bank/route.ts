import { getCachedEssayBank, appendEssayEntry } from "@/lib/essay-bank";
import { logEssayEvent } from "@/lib/essay-log";

// 과거 자소서 참고자료 현황 조회 — AI 호출 없음.
export async function GET() {
  return Response.json({ bank: getCachedEssayBank() });
}

// "지원 도우미" 탭에서 다듬어 확정한 답변을 참고자료로 저장 — 다음 초안 생성부터 반영된다.
export async function POST(request: Request) {
  const { company, question, answer, seq } = await request.json();
  if (typeof question !== "string" || typeof answer !== "string" || !answer.trim()) {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  appendEssayEntry(typeof company === "string" ? company : "", question, answer);
  // 사용자가 "이 글은 됐다"고 확정한 시점이라 작성 기록에도 남긴다.
  if (typeof seq === "string" && seq) logEssayEvent({ seq, question, type: "saved_to_bank", textBefore: answer, detail: { company: typeof company === "string" ? company : "" } });
  return Response.json({ ok: true });
}
