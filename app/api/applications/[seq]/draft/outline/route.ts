import { after } from "next/server";
import { isSameOrigin } from "@/lib/request-origin";
import { getJobBySeq } from "@/lib/db";
import { requireApplicationRole } from "@/lib/application-role";
import { parseEssayRequest } from "@/lib/essay-contract";
import { createApplicationTask, executeApplicationTask } from "@/lib/application-tasks";
import { proposeOutlines } from "@/lib/essay-writer";
import { getCachedApplicationDraft, updateApplicationDraft } from "@/lib/application-draft";

export const runtime = "nodejs";
export const maxDuration = 1800;

// 구성 제안: 문항 전체의 핵심 메시지·문단 구성·쓸 경험·확인 질문을 한 번의 AI 호출로 받는다. 결과는 draft.outlines에 저장된다.
export async function POST(request: Request, { params }: { params: Promise<{ seq: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const { seq } = await params;
  if (!getJobBySeq(seq)) return Response.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  try {
    const body = await request.json();
    const values = body.questions ?? [body];
    if (!Array.isArray(values) || !values.length || values.length > 20) throw new Error("한 번에 1~20개 문항의 구성을 받을 수 있습니다.");
    const inputs = values.map(parseEssayRequest);
    if (new Set(inputs.map((input) => input.question)).size !== inputs.length)
      throw new Error("같은 문항이 중복되어 있습니다. 문항을 구분해서 입력해주세요.");
    requireApplicationRole(seq);
    const task = createApplicationTask(seq, "writing", 1);
    after(() => executeApplicationTask(task.id, async (progress, signal) => {
      const draft = await proposeOutlines(seq, inputs, signal);
      progress(1);
      return { draft, outcome: "outline" };
    }));
    return Response.json({ task }, { status: 202 });
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : "문항을 확인해주세요." }, { status: 400 }); }
}

// 구성 지우기: 아직 작성하지 않은 구성 제안 하나를 지운다(AI 호출 없음).
export async function DELETE(request: Request, { params }: { params: Promise<{ seq: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const { seq } = await params;
  const question = new URL(request.url).searchParams.get("question") ?? "";
  if (!question) return Response.json({ error: "지울 문항을 알려주세요." }, { status: 400 });
  if (!getCachedApplicationDraft(seq)?.outlines?.some((o) => o.question === question)) return Response.json({ error: "지울 구성을 찾을 수 없습니다." }, { status: 404 });
  const draft = updateApplicationDraft(seq, "", (current) => ({ ...current, outlines: (current.outlines ?? []).filter((o) => o.question !== question) }));
  return Response.json({ draft });
}
