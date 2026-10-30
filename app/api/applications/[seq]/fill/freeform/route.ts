import { after } from "next/server";
import { getApplicationRole, getJobBySeq } from "@/lib/db";
import { isSameOrigin } from "@/lib/request-origin";
import { readApplicantProfile } from "@/lib/applicant-profile";
import { getCachedApplicationDraft } from "@/lib/application-draft";
import { assertApplicationRole } from "@/lib/application-role";
import { buildFreeformDocument, freeformFilename, parseFreeformOptions } from "@/lib/freeform-application";
import { generateFreeformDocx } from "@/lib/freeform-document";
import { storeDocumentDownload } from "@/lib/document-download";
import { createApplicationTask, executeApplicationTask } from "@/lib/application-tasks";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request, { params }: { params: Promise<{ seq: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const { seq } = await params;
  const job = getJobBySeq(seq);
  if (!job) return Response.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  try {
    const options = parseFreeformOptions(await request.json());
    const selection = getApplicationRole(seq);
    // Snapshot exactly what is saved at the time the user starts generation.
    const document = buildFreeformDocument(job.company, selection, readApplicantProfile(), getCachedApplicationDraft(seq), options);
    const filename = freeformFilename(document, options.mode);
    const task = createApplicationTask(seq, "freeform");
    after(() => executeApplicationTask(task.id, async (_progress, signal) => {
      const bytes = await generateFreeformDocx(document, signal);
      signal.throwIfAborted();
      assertApplicationRole(seq, selection.revision);
      return { document: {
        downloadUrl: storeDocumentDownload(seq, filename, bytes), filename,
        filled: document.filled, total: document.total, skipped: document.warnings,
        note: options.mode === "blank" ? "빈 양식입니다. 대괄호 안내를 실제 내용으로 바꿔주세요."
          : "저장한 지원 정보와 이 공고의 자기소개서를 반영했습니다. 비어 있는 항목과 공고의 제출 요건을 확인해주세요.",
      } };
    }));
    return Response.json({ task }, { status: 202 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "지원서를 생성하지 못했습니다." }, { status: 400 });
  }
}
