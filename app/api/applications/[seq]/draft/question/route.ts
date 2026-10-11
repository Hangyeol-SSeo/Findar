import { after } from "next/server";
import { isSameOrigin } from "@/lib/request-origin";
import { getJobBySeq } from "@/lib/db";
import { requireApplicationRole } from "@/lib/application-role";
import { createApplicationTask, executeApplicationTask } from "@/lib/application-tasks";
import { listEssayMaterials, parseOutlineInput, writeFromOutlines } from "@/lib/essay-writer";

export const runtime = "nodejs";
export const maxDuration = 1800;

// 작성: 화면에서 확인·수정한 구성대로 문항 전체를 한 번의 AI 호출로 쓴다. 답변이 빠진 문항은 구성이 남아 다시 작성할 수 있다.
export async function POST(request: Request, { params }: { params: Promise<{ seq: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const { seq } = await params;
  if (!getJobBySeq(seq)) return Response.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  try {
    const body = await request.json();
    if (!Array.isArray(body.outlines) || !body.outlines.length || body.outlines.length > 20) throw new Error("작성할 구성을 1~20개 보내주세요.");
    const materialIds = new Set(listEssayMaterials(seq).map((m) => m.id));
    const outlines = body.outlines.map((o: unknown) => parseOutlineInput(o, materialIds));
    if (new Set(outlines.map((o: { question: string }) => o.question)).size !== outlines.length)
      throw new Error("같은 문항이 중복되어 있습니다.");
    requireApplicationRole(seq);
    const task = createApplicationTask(seq, "writing", outlines.length);
    after(() => executeApplicationTask(task.id, (progress, signal) => writeFromOutlines(seq, outlines, signal, progress)));
    return Response.json({ task }, { status: 202 });
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : "구성을 확인해주세요." }, { status: 400 }); }
}
