import { isSameOrigin } from "@/lib/request-origin";
import { getJobBySeq } from "@/lib/db";
import { EssayConflictError, importEssay } from "@/lib/essay-revision";

// 내 글 가져오기 — 직접 쓴 자기소개서를 문항에 저장한다. AI 호출 없음.
export async function POST(request: Request, { params }: { params: Promise<{ seq: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const { seq } = await params;
  if (!getJobBySeq(seq)) return Response.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  try {
    const body = await request.json();
    return Response.json({ draft: importEssay(seq, body, body.revision ?? null) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "가져오지 못했습니다." }, { status: e instanceof EssayConflictError ? 409 : 400 });
  }
}
