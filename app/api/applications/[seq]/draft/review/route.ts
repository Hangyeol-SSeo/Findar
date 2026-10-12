import { after } from "next/server";
import { isSameOrigin } from "@/lib/request-origin";
import { getJobBySeq } from "@/lib/db";
import { requireApplicationRole } from "@/lib/application-role";
import { findEssayAnswer } from "@/lib/essay-revision";
import { createApplicationTask, executeApplicationTask } from "@/lib/application-tasks";
import { reviewEssay } from "@/lib/essay-review";

export const runtime = "nodejs";
export const maxDuration = 1800;

// 첨삭 받기. AI 호출 1번(JSON 문법 오류 때만 1번 더). 결과는 답변의 feedback에 저장된다.
export async function POST(request: Request, { params }: { params: Promise<{ seq: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const { seq } = await params;
  if (!getJobBySeq(seq)) return Response.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  try {
    const { question, focus } = await request.json();
    if (typeof question !== "string") throw new Error("요청을 확인해주세요.");
    const text = typeof focus === "string" ? focus.trim() : "";
    if (text.length > 500) throw new Error("중점 사항은 500자 이내로 적어주세요.");
    requireApplicationRole(seq);
    if (!findEssayAnswer(seq, question).answer.trim()) throw new Error("본문이 없습니다. 먼저 자기소개서를 저장해주세요.");
    const task = createApplicationTask(seq, "revision", 1, question);
    after(() => executeApplicationTask(task.id, async (_progress, signal) => await reviewEssay(seq, question, text, signal)));
    return Response.json({ task }, { status: 202 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "요청을 시작하지 못했습니다." }, { status: 400 });
  }
}
