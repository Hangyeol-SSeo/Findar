import { isSameOrigin } from "@/lib/request-origin";
import { getJobBySeq } from "@/lib/db";
import { EssayConflictError, importEssay } from "@/lib/essay-revision";
import { checkEssay } from "@/lib/essay-review";

// 자기소개서 저장 — 대화 세션 등에서 쓴 글을 문항에 저장한다. 저장할 때 막지 않는 점검만 돈다. AI 호출 없음.
export async function POST(request: Request, { params }: { params: Promise<{ seq: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const { seq } = await params;
  if (!getJobBySeq(seq)) return Response.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  try {
    const body = await request.json();
    return Response.json({ draft: importEssay(seq, body, body.revision ?? null, (t, r) => checkEssay(seq, t, r)) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "가져오지 못했습니다." }, { status: e instanceof EssayConflictError ? 409 : 400 });
  }
}
