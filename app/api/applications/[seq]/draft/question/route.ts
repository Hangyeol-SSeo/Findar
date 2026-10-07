import { requireApplicationRole } from "@/lib/application-role";
import { after } from "next/server";
import { isSameOrigin } from "@/lib/request-origin";
import { getJobBySeq } from "@/lib/db";
import { generateCustomEssayAnswer, prepareEssayBatch, getCachedApplicationDraft, persistEssay } from "@/lib/application-draft";
import { parseEssayRequest } from "@/lib/essay-contract";
import { createApplicationTask, executeApplicationTask } from "@/lib/application-tasks";
import { logEssayEvent, logEssayEvents, newEssayThread } from "@/lib/essay-log";
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
    if (new Set(inputs.map((input) => input.question)).size !== inputs.length)
      throw new Error("같은 문항이 중복되어 있습니다. 문항을 구분해서 입력해주세요.");
    requireApplicationRole(seq);
    const task = createApplicationTask(seq, "writing", inputs.length);
    // 작성 기록: 문항마다 요청을 남기고, 저장(persistEssay)·실패를 같은 threadId로 잇는다.
    const threads = inputs.map(() => newEssayThread());
    const settled = new Set<number>();
    const current = getCachedApplicationDraft(seq);
    logEssayEvents(inputs.map((input, i) => ({ seq, question: input.question, type: "draft_requested" as const, threadId: threads[i],
      textBefore: current?.essayAnswers.find((a) => a.source === "user_question" && a.question === input.question)?.answer || null,
      detail: { guidance: input.guidance, maxChars: input.maxChars ?? null, countSpaces: input.countSpaces, batchSize: inputs.length } })));
    const fail = (i: number, error: unknown) => {
      settled.add(i);
      logEssayEvent({ seq, question: inputs[i].question, type: "draft_failed", threadId: threads[i], detail: { error: error instanceof Error ? error.message : String(error) } });
    };
    after(() => executeApplicationTask(task.id, async (progress) => {
      try {
        const beforePlanning = JSON.stringify(getCachedApplicationDraft(seq));
        const prepared = await prepareEssayBatch(seq, inputs);
        if (JSON.stringify(getCachedApplicationDraft(seq)) !== beforePlanning)
          throw new Error("구상 중 답변이 다른 창에서 변경되어 작업을 중단했습니다.");
        let needsInfo = 0;
        let completed = 0;
        const failures: string[] = [];
        let draft = getCachedApplicationDraft(seq);
        for (let i = 0; i < inputs.length; i++) {
          const initial = JSON.stringify(getCachedApplicationDraft(seq));
          // Work is owned by the server, never by the request/selected tab's AbortSignal.
          let answer;
          try { answer = await generateCustomEssayAnswer(seq, inputs[i], undefined, prepared); }
          catch (error) {
            failures.push(`문항 ${i + 1}: ${error instanceof Error ? error.message : "작성에 실패했습니다."}`);
            fail(i, error);
            continue;
          }
          if (JSON.stringify(getCachedApplicationDraft(seq)) !== initial)
            throw new Error("작성 중 답변이 다른 창에서 변경되어 덮어쓰지 않았습니다. 완료된 문항은 저장되어 있습니다.");
          draft = persistEssay(seq, answer, threads[i]);
          settled.add(i);
          if (answer.status === "needs_info") needsInfo++;
          progress(++completed);
        }
        if (failures.length) throw new Error(`요청한 ${inputs.length}개 중 ${completed}개를 저장했습니다. ${failures.join(" / ")}`);
        if (completed !== inputs.length) throw new Error("요청한 문항 수와 저장한 답변 수가 일치하지 않습니다.");
        return { draft: draft!, needsInfo };
      } catch (error) {
        inputs.forEach((_, i) => { if (!settled.has(i)) fail(i, error); });
        throw error;
      }
    }));
    return Response.json({ task }, { status: 202 });
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : "문항을 확인해주세요." }, { status: 400 }); }
}
