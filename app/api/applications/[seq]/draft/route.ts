import { isSameOrigin } from "@/lib/request-origin";
import { getCachedApplicationDraft } from "@/lib/application-draft";
import { saveApplicationDraft, getJobBySeq } from "@/lib/db";
import { detectSubmissionMethod } from "@/lib/application-method";

export async function GET(_request: Request, { params }: { params: Promise<{ seq: string }> }) {
  const { seq } = await params;
  const job = getJobBySeq(seq);
  if (!job) return Response.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  return Response.json({ draft: getCachedApplicationDraft(seq), siteUrl: job.siteUrl,
    submissionMethod: detectSubmissionMethod(job.attachments, job.rawContent, job.siteUrl) });
}

export async function POST() {
  return Response.json({ error: "실제 지원서 문항을 입력한 뒤 문항별 작성을 이용해주세요." }, { status: 400 });
}

export async function PUT(request: Request, { params }: { params: Promise<{ seq: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const { seq } = await params;
  try {
    const body = await request.json();
    const current = getCachedApplicationDraft(seq);
    if (!current) return Response.json({ error: "저장된 답변이 없습니다." }, { status: 404 });
    if ((body.revision ?? null) !== (current.revision ?? null))
      return Response.json({ error: "다른 창에서 답변이 바뀌었습니다. 현재 내용을 별도로 보관한 뒤 다시 열어주세요." }, { status: 409 });
    if (!Array.isArray(body.essayAnswers) || body.essayAnswers.length !== current.essayAnswers.length ||
      body.essayAnswers.some((a: { question?: unknown; answer?: unknown }, i: number) => !a || a.question !== current.essayAnswers[i].question || typeof a.answer !== "string" || a.answer.length > 30000))
      return Response.json({ error: "저장할 답변이 올바르지 않습니다." }, { status: 400 });
    const draft = { ...current, revision: crypto.randomUUID(), essayAnswers: current.essayAnswers.map((a, i) => ({ ...a, answer: body.essayAnswers[i].answer })) };
    saveApplicationDraft(seq, JSON.stringify(draft), current.model);
    return Response.json({ draft });
  } catch { return Response.json({ error: "저장 요청을 읽지 못했습니다." }, { status: 400 }); }
}
