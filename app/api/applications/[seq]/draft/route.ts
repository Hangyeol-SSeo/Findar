import { isSameOrigin } from "@/lib/request-origin";
import { getCachedApplicationDraft } from "@/lib/application-draft";
import { saveApplicationDraft, getJobBySeq } from "@/lib/db";
import { detectSubmissionMethod } from "@/lib/application-method";
import { finalSummaries, recordManualEdit } from "@/lib/essay-revision";
import { companyResearchNotice } from "@/lib/company-research";
import { normalizeCompanyName } from "@/lib/company-normalize";
import { checkEssay } from "@/lib/essay-review";

export async function GET(_request: Request, { params }: { params: Promise<{ seq: string }> }) {
  const { seq } = await params;
  const job = getJobBySeq(seq);
  if (!job) return Response.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  return Response.json({ draft: getCachedApplicationDraft(seq), siteUrl: job.siteUrl,
    submissionMethod: detectSubmissionMethod(job.attachments, job.rawContent, job.siteUrl),
    companyResearchNotice: companyResearchNotice(normalizeCompanyName(job.company)),
    // 최종본으로 저장한 답변(과거 자소서 자료에 들어간 글). AI 호출 없음.
    finals: finalSummaries(seq) });
}

export async function POST() {
  return Response.json({ error: "자기소개서는 문항과 함께 저장해주세요." }, { status: 400 });
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
    // 문항별 답변은 직접 고칠 때마다 버전을 남기고 수정 성향을 기록한다. 이전 방식 공통 답변은 본문만 바꾼다.
    const draft = { ...current, revision: crypto.randomUUID(), essayAnswers: current.essayAnswers.map((a, i) => {
      const text = body.essayAnswers[i].answer as string;
      return a.source === "user_question" ? recordManualEdit(seq, a, text, (t, r) => checkEssay(seq, t, r)) : { ...a, answer: text };
    }) };
    saveApplicationDraft(seq, JSON.stringify(draft), current.model);
    return Response.json({ draft });
  } catch { return Response.json({ error: "저장 요청을 읽지 못했습니다." }, { status: 400 }); }
}
