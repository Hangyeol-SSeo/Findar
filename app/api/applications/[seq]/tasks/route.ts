import { logEssayEvent } from "@/lib/essay-log";
import { isSameOrigin } from "@/lib/request-origin";
import { cancelApplicationTask, getApplicationTask, listApplicationTasks } from "@/lib/application-tasks";
export const runtime = "nodejs";
export async function GET(_request: Request, { params }: { params: Promise<{ seq: string }> }) {
  const { seq } = await params;
  // Drafts themselves are loaded through the existing draft API; web capability results are private.
  return Response.json({ tasks: listApplicationTasks(seq).filter((t) => t.kind !== "web") }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ seq: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const { seq } = await params;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "취소할 작업을 지정해주세요." }, { status: 400 });
  try {
    const existing = getApplicationTask(seq, id);
    if (!existing || existing.kind === "web") return Response.json({ error: "작업을 찾을 수 없습니다." }, { status: 404 });
    const task = cancelApplicationTask(seq, id);
    if (existing.status === "queued" || existing.status === "running") logEssayEvent({ seq, question: existing.question ?? "", type: "task_cancel_requested", detail: { taskId: id, kind: existing.kind, done: existing.done, total: existing.total } });
    return Response.json({ task }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "취소하지 못했습니다." }, { status: 409 });
  }
}
