import { after } from "next/server";
import { isSameOrigin } from "@/lib/request-origin";
import { getJobBySeq } from "@/lib/db";
import { requireApplicationRole } from "@/lib/application-role";
import { findEssayAnswer, reviewEssay, reviseEssay } from "@/lib/essay-revision";
import { createApplicationTask, executeApplicationTask } from "@/lib/application-tasks";

export const runtime = "nodejs";
export const maxDuration = 1800;

// 첨삭 시작 — 고쳐쓰기(rewrite) 또는 첨삭 받기(review). Sonnet 1회(형식 오류 시 1회 재시도)로
// 백그라운드 작업으로 돌고, 결과는 답변의 pendingRevision/feedback에 저장된다.
export async function POST(request: Request, { params }: { params: Promise<{ seq: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const { seq } = await params;
  if (!getJobBySeq(seq)) return Response.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  try {
    const { question, mode, instruction, focus, findingIds } = await request.json();
    const ids = Array.isArray(findingIds) ? findingIds.filter((id): id is string => typeof id === "string").slice(0, 12) : [];
    if (typeof question !== "string" || (mode !== "rewrite" && mode !== "review")) throw new Error("요청을 확인해주세요.");
    const raw = mode === "rewrite" ? instruction : focus;
    const text = typeof raw === "string" ? raw.trim() : "";
    if (mode === "rewrite" && (!text || text.length > 4000)) throw new Error("수정 요청을 1~4,000자로 적어주세요.");
    if (mode === "review" && text.length > 500) throw new Error("중점 사항은 500자 이내로 적어주세요.");
    requireApplicationRole(seq);
    if (!findEssayAnswer(seq, question).answer.trim()) throw new Error("첨삭할 본문이 없습니다. 먼저 답변을 작성하거나 직접 쓴 글을 가져와주세요.");
    const task = createApplicationTask(seq, "revision", 1, question);
    after(() => executeApplicationTask(task.id, async () =>
      mode === "rewrite" ? await reviseEssay(seq, question, text, ids) : await reviewEssay(seq, question, text)));
    return Response.json({ task }, { status: 202 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "첨삭을 시작하지 못했습니다." }, { status: 400 });
  }
}
