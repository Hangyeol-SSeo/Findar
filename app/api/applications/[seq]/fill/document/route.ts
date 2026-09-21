import { after } from "next/server";
import { storeDocumentDownload } from "@/lib/document-download";
import { isSameOrigin } from "@/lib/request-origin";
import { getJobBySeq } from "@/lib/db";
import { processDocx } from "@/lib/document-fill";
import { buildEssayFillSources, planApplicationFill, validateFillTargets } from "@/lib/application-fill";
import { getCachedApplicationDraft } from "@/lib/application-draft";
import { createApplicationTask, executeApplicationTask } from "@/lib/application-tasks";
export const runtime = "nodejs";
export const maxDuration = 180;
export async function POST(request: Request, { params }: { params: Promise<{ seq: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const { seq } = await params;
  if (!getJobBySeq(seq)) return Response.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".docx") || file.size > 10 * 1024 * 1024)
      return Response.json({ error: "10MB 이하 DOCX 양식을 올려주세요. DOC/HWP는 Word에서 DOCX로 변환해주세요." }, { status: 400 });
    const document = Buffer.from(await file.arrayBuffer()).toString("base64");
    const essays = buildEssayFillSources(getCachedApplicationDraft(seq)?.essayAnswers ?? []);
    const filename = file.name.replace(/\.docx$/i, "-작성본.docx");
    const task = createApplicationTask(seq, "document");
    after(() => executeApplicationTask(task.id, async () => {
      const inspected = await processDocx(document);
      if (!inspected.targets.length) throw new Error(`작성할 입력칸을 찾지 못했습니다. ${inspected.unsupported}`);
      const plan = await planApplicationFill(validateFillTargets(inspected.targets), undefined, essays);
      const result = await processDocx(document, plan.assignments);
      if (!result.document) throw new Error("작성본 파일을 만들지 못했습니다.");
      const downloadUrl = storeDocumentDownload(seq, filename, result.document);
      return { document: { downloadUrl, filename, filled: result.filled ?? 0, total: inspected.targets.length, skipped: plan.skipped, note: result.unsupported } };
    }));
    return Response.json({ task }, { status: 202 });
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : "Word 작성에 실패했습니다." }, { status: 400 }); }
}
