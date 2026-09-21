import { after } from "next/server";
import { createFillSession, verifyFillSession, localRequest } from "@/lib/fill-session";
import { getJobBySeq } from "@/lib/db";
import { buildEssayFillSources, planApplicationFill, validateFillTargets } from "@/lib/application-fill";
import { getCachedApplicationDraft } from "@/lib/application-draft";
import { createApplicationTask, executeApplicationTask, getApplicationTask } from "@/lib/application-tasks";
export const runtime = "nodejs";
export const maxDuration = 180;
export async function POST(request: Request, { params }: { params: Promise<{ seq: string }> }) {
  const { seq } = await params;
  if (!getJobBySeq(seq)) return Response.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token) {
    if (!localRequest(request)) return Response.json({ error: "Findar를 localhost에서 열어 연결해주세요." }, { status: 403 });
    return Response.json({ token: createFillSession(seq) });
  }
  if (!verifyFillSession(token, seq)) return Response.json({ error: "연결이 만료되었습니다. Findar에서 다시 연결해주세요." }, { status: 401 });
  try {
    const body = await request.json();
    if (typeof body.taskId === "string") {
      const task = getApplicationTask(seq, body.taskId);
      if (!task || task.kind !== "web") return Response.json({ error: "작업을 찾을 수 없습니다. 다시 실행해주세요." }, { status: 404 });
      return Response.json({ task });
    }
    const targets = validateFillTargets(body.targets);
    const essays = buildEssayFillSources(getCachedApplicationDraft(seq)?.essayAnswers ?? []);
    const task = createApplicationTask(seq, "web");
    after(() => executeApplicationTask(task.id, async () => ({ plan: await planApplicationFill(targets, undefined, essays) })));
    return Response.json({ task }, { status: 202 });
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : "입력칸 분석에 실패했습니다." }, { status: 400 }); }
}
