import { after } from "next/server";
import { isSameOrigin } from "@/lib/request-origin";
import { getJobBySeq } from "@/lib/db";
import { requireApplicationRole } from "@/lib/application-role";
import { findEssayAnswer } from "@/lib/essay-revision";
import { createApplicationTask, executeApplicationTask } from "@/lib/application-tasks";
import { reviewEssay, rewriteParagraphs } from "@/lib/essay-writer";

export const runtime = "nodejs";
export const maxDuration = 1800;

// 문단 다시 쓰기(rewrite: 고른 문단만, 비우면 글 전체) 또는 첨삭 받기(review). 각각 AI 호출 1번(JSON 문법 오류 때만 1번 더).
// 결과는 답변의 pendingRevision(비교 후 반영)·revisionNeedsInfo·feedback에 저장된다.
export async function POST(request: Request, { params }: { params: Promise<{ seq: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const { seq } = await params;
  if (!getJobBySeq(seq)) return Response.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  try {
    const { question, mode, instruction, focus, paragraphs } = await request.json();
    if (typeof question !== "string" || (mode !== "rewrite" && mode !== "review")) throw new Error("요청을 확인해주세요.");
    const raw = mode === "review" ? focus : instruction;
    const text = typeof raw === "string" ? raw.trim() : "";
    if (mode === "rewrite" && (!text || text.length > 4000)) throw new Error("수정 요청을 1~4,000자로 적어주세요.");
    if (mode === "review" && text.length > 500) throw new Error("중점 사항은 500자 이내로 적어주세요.");
    const targets = Array.isArray(paragraphs) ? paragraphs.filter((n): n is number => Number.isInteger(n)).slice(0, 30) : [];
    requireApplicationRole(seq);
    if (!findEssayAnswer(seq, question).answer.trim()) throw new Error("본문이 없습니다. 먼저 답변을 작성하거나 직접 쓴 글을 가져와주세요.");
    const task = createApplicationTask(seq, "revision", 1, question);
    after(() => executeApplicationTask(task.id, async (_progress, signal) =>
      mode === "rewrite" ? await rewriteParagraphs(seq, question, targets, text, signal) : await reviewEssay(seq, question, text, signal)));
    return Response.json({ task }, { status: 202 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "요청을 시작하지 못했습니다." }, { status: 400 });
  }
}
