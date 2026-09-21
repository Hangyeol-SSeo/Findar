import { after } from "next/server";
import { isSameOrigin } from "@/lib/request-origin";
import { getJobBySeq } from "@/lib/db";
import { generateCustomEssayAnswer, getCachedApplicationDraft, persistEssay } from "@/lib/application-draft";
import { parseEssayRequest } from "@/lib/essay-contract";
import { createApplicationTask, executeApplicationTask } from "@/lib/application-tasks";
export const runtime = "nodejs";
export const maxDuration = 3600;
export async function POST(request: Request, { params }: { params: Promise<{ seq: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const { seq } = await params;
  if (!getJobBySeq(seq)) return Response.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  try {
    const body = await request.json();
    const values = body.questions ?? [body];
    if (!Array.isArray(values) || !values.length || values.length > 20) throw new Error("한 번에 1~20개 문항을 작성할 수 있습니다.");
    const inputs = values.map(parseEssayRequest);
    const task = createApplicationTask(seq, "writing", inputs.length);
    after(() => executeApplicationTask(task.id, async (progress) => {
      let needsInfo = 0;
      let draft = getCachedApplicationDraft(seq);
      for (let i = 0; i < inputs.length; i++) {
        const initial = JSON.stringify(getCachedApplicationDraft(seq));
        // Work is owned by the server, never by the request/selected tab's AbortSignal.
        const answer = await generateCustomEssayAnswer(seq, inputs[i]);
        if (JSON.stringify(getCachedApplicationDraft(seq)) !== initial)
          throw new Error("작성 중 답변이 다른 창에서 변경되어 덮어쓰지 않았습니다. 완료된 문항은 저장되어 있습니다.");
        draft = persistEssay(seq, answer);
        if (answer.status === "needs_info") needsInfo++;
        progress(i + 1);
      }
      return { draft: draft!, needsInfo };
    }));
    return Response.json({ task }, { status: 202 });
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : "문항을 확인해주세요." }, { status: 400 }); }
}
