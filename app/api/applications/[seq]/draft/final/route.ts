import { isSameOrigin } from "@/lib/request-origin";
import { getJobBySeq } from "@/lib/db";
import { EssayConflictError, finalSummaries, saveFinalAnswer } from "@/lib/essay-revision";

// 최종본으로 저장 — 저장된 본문을 과거 자소서 자료에 바로 넣는다(같은 공고·문항은 새 글로 교체). AI 호출 없음.
export async function POST(request: Request, { params }: { params: Promise<{ seq: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const { seq } = await params;
  if (!getJobBySeq(seq)) return Response.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  try {
    const body = await request.json();
    if (typeof body.question !== "string") throw new Error("문항을 지정해주세요.");
    saveFinalAnswer(seq, body.question, body.revision ?? null);
    return Response.json({ finals: finalSummaries(seq) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "저장하지 못했습니다." }, { status: e instanceof EssayConflictError ? 409 : 400 });
  }
}

