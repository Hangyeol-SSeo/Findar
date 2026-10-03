import { getApplicationRole, getJobBySeq, saveApplicationRole } from "@/lib/db";
import { isSameOrigin } from "@/lib/request-origin";
import { listApplicationTasks } from "@/lib/application-tasks";
import { taskActive } from "@/lib/application-task-types";
export const runtime = "nodejs";
export async function GET(_request: Request, { params }: { params: Promise<{ seq: string }> }) {
  const { seq } = await params;
  if (!getJobBySeq(seq)) return Response.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  return Response.json(getApplicationRole(seq), { headers: { "Cache-Control": "no-store" } });
}
export async function PUT(request: Request, { params }: { params: Promise<{ seq: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const { seq } = await params;
  if (!getJobBySeq(seq)) return Response.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  try {
    const body = await request.json();
    if (typeof body.role !== "string" || !body.role.trim() || body.role.trim().length > 200 || typeof body.revision !== "string")
      return Response.json({ error: "지원 직무 하나를 200자 이내로 입력해주세요." }, { status: 400 });
    if (listApplicationTasks(seq).some(t => taskActive(t) && (t.kind === "writing" || t.kind === "tailoring")))
      return Response.json({ error: "이력 평가 또는 자기소개서 작성이 끝난 뒤 지원 직무를 변경해주세요." }, { status: 409 });
    return Response.json(saveApplicationRole(seq, body.role.trim(), body.revision));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "직무를 저장하지 못했습니다." }, { status: 409 });
  }
}
