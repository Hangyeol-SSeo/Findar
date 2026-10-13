import { isSameOrigin } from "@/lib/request-origin";
import { getJobBySeq } from "@/lib/db";
import { applyEssayAnswerAction, EssayConflictError, type EssayAnswerAction } from "@/lib/essay-revision";
import { checkEssay } from "@/lib/essay-review";

const ACTIONS = ["apply-suggestion", "dismiss-suggestion", "close-feedback", "restore-version", "move"];

// 첨삭 제안 반영/넘기기·닫기, 버전 복원, 문항 순서 변경 — 저장된 결과만 다루며 AI 호출 없음.
export async function POST(request: Request, { params }: { params: Promise<{ seq: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const { seq } = await params;
  if (!getJobBySeq(seq)) return Response.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  try {
    const body = await request.json();
    if (typeof body.question !== "string" || !ACTIONS.includes(body.action)) throw new Error("요청을 확인해주세요.");
    if (["apply-suggestion", "dismiss-suggestion"].includes(body.action) && typeof body.suggestionId !== "string") throw new Error("제안을 지정해주세요.");
    if (body.action === "restore-version" && typeof body.versionId !== "string") throw new Error("버전을 지정해주세요.");
    if (body.action === "move" && !["up", "down"].includes(body.direction)) throw new Error("옮길 방향을 지정해주세요.");
    const draft = applyEssayAnswerAction(seq, body.question, body as EssayAnswerAction, body.revision ?? null, (t, r) => checkEssay(seq, t, r));
    return Response.json({ draft });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "처리하지 못했습니다." }, { status: e instanceof EssayConflictError ? 409 : 400 });
  }
}
