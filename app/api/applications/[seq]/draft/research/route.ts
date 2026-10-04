import { after } from "next/server";
import { isSameOrigin } from "@/lib/request-origin";
import { getJobBySeq } from "@/lib/db";
import { requireApplicationRole } from "@/lib/application-role";
import { findEssayAnswer } from "@/lib/essay-revision";
import { collectIndustryResearch, scopeIndustryResearch } from "@/lib/industry-research";
import { createApplicationTask, executeApplicationTask } from "@/lib/application-tasks";
import type { ApplicationDraft } from "@/lib/application-draft";

export const runtime = "nodejs";
export const maxDuration = 1800;

// 업계 사례 조사 — 사용자가 버튼을 눌렀을 때만 실행한다. scope(후보 찾기, 검색만) → collect(고른 자료만 읽기).
export async function POST(request: Request, { params }: { params: Promise<{ seq: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const { seq } = await params;
  if (!getJobBySeq(seq)) return Response.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  try {
    const { question, step, instruction, topic, selectedIds, direction } = await request.json();
    if (typeof question !== "string" || (step !== "scope" && step !== "collect")) throw new Error("요청을 확인해주세요.");
    requireApplicationRole(seq);
    if (!findEssayAnswer(seq, question).answer.trim()) throw new Error("조사 결과를 반영할 본문이 없습니다. 먼저 답변을 작성하거나 직접 쓴 글을 가져와주세요.");
    const str = (value: unknown, limit: number) => (typeof value === "string" ? value.trim().slice(0, limit) : "");
    let work: () => Promise<ApplicationDraft>;
    if (step === "scope") {
      const topicText = str(topic, 2000);
      if (!topicText) throw new Error("조사할 내용을 적어주세요.");
      work = () => scopeIndustryResearch(seq, question, str(instruction, 2000), topicText);
    } else {
      const ids = Array.isArray(selectedIds) ? selectedIds.filter((id): id is string => typeof id === "string") : [];
      if (!ids.length) throw new Error("읽을 자료를 하나 이상 골라주세요.");
      work = () => collectIndustryResearch(seq, question, ids, str(direction, 1000));
    }
    const task = createApplicationTask(seq, "research", 1, question);
    after(() => executeApplicationTask(task.id, async () => ({
      draft: await work(),
      outcome: step === "scope" ? "candidates" as const : "findings" as const,
    })));
    return Response.json({ task }, { status: 202 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "조사를 시작하지 못했습니다." }, { status: 400 });
  }
}
