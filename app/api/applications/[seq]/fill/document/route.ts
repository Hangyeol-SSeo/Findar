import { storeDocumentDownload } from "@/lib/document-download";
import { isSameOrigin } from "@/lib/request-origin";
import { getJobBySeq } from "@/lib/db";
import { processDocx } from "@/lib/document-fill";
import { planApplicationFill, validateFillTargets } from "@/lib/application-fill";
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
    const inspected = await processDocx(document);
    if (!inspected.targets.length) return Response.json({ error: `작성할 빈 표 입력칸을 찾지 못했습니다. ${inspected.unsupported}` }, { status: 422 });
    const plan = await planApplicationFill(validateFillTargets(inspected.targets), request.signal);
    if (!plan.assignments.length) return Response.json({ error: "설정에 저장된 정보와 일치하는 입력칸을 찾지 못했습니다.", skipped: plan.skipped }, { status: 422 });
    const result = await processDocx(document, plan.assignments);
    if (!result.document) throw new Error("작성본 파일을 만들지 못했습니다.");
    const filename = file.name.replace(/\.docx$/i, "-작성본.docx");
    const downloadUrl = storeDocumentDownload(seq, filename, result.document);
    return Response.json({ downloadUrl, filename, filled: result.filled, skipped: plan.skipped, note: result.unsupported });
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : "Word 작성에 실패했습니다." }, { status: 400 }); }
}
