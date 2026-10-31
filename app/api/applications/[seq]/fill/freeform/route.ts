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
import { isFocus, parseComposition } from "@/lib/freeform-composition";
import { getCompositionPlan, loadCompositionCatalog, readApplicationMaterials, saveCompositionPlan, savedCompositionFocus } from "@/lib/freeform-composition-store";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request, { params }: { params: Promise<{ seq: string }> }) {
  const { seq } = await params, job = getJobBySeq(seq);
  if (!job) return Response.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  const query = new URL(request.url).searchParams, selection = getApplicationRole(seq);
  const requested = query.get("focus");
  if (requested !== null && !isFocus(requested)) return Response.json({ error: "지원서 구성 기준을 확인해주세요." }, { status: 400 });
  const catalog = loadCompositionCatalog(readApplicantProfile(), selection, job, requested ?? savedCompositionFocus(seq, selection.revision));
  return Response.json({ catalog, ...getCompositionPlan(seq, catalog, query.get("reset") === "1"), materials: readApplicationMaterials() }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request, { params }: { params: Promise<{ seq: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const { seq } = await params, job = getJobBySeq(seq);
  if (!job) return Response.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  try {
    const plan = parseComposition(await request.json());
    const catalog = loadCompositionCatalog(readApplicantProfile(), getApplicationRole(seq), job, plan.focus);
    saveCompositionPlan(seq, catalog, plan);
    return Response.json({ saved: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "구성을 저장하지 못했습니다." }, { status: 400 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ seq: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const { seq } = await params;
  const job = getJobBySeq(seq);
  if (!job) return Response.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  try {
    const options = parseFreeformOptions(await request.json());
    const selection = getApplicationRole(seq);
    const profile = readApplicantProfile();
    const catalog = options.mode === "filled" ? loadCompositionCatalog(profile, selection, job, options.composition?.focus ?? savedCompositionFocus(seq, selection.revision)) : undefined;
    if (catalog) {
      options.composition ??= getCompositionPlan(seq, catalog).plan;
      saveCompositionPlan(seq, catalog, options.composition);
    }
    // Snapshot exactly what is saved at the time the user starts generation.
    const document = buildFreeformDocument(job.company, selection, profile, getCachedApplicationDraft(seq), options, catalog);
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
          : "이 공고에서 선택한 이력과 저장한 자기소개서를 반영했습니다. 제출 전 내용과 공고의 요구 항목을 확인해주세요.",
      } };
    }));
    return Response.json({ task }, { status: 202 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "지원서를 생성하지 못했습니다." }, { status: 400 });
  }
}
