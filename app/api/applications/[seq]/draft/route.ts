import { generateApplicationDraft, getCachedApplicationDraft } from "@/lib/application-draft";
import { saveApplicationDraft } from "@/lib/db";

// 캐시된 초안만 반환 — AI 호출 없음, 패널을 열 때마다 불러도 비용 걱정 없음.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ seq: string }> }
) {
  const { seq } = await params;
  return Response.json({ draft: getCachedApplicationDraft(seq) });
}

// 새로 생성(또는 재생성). 버튼을 눌렀을 때만 호출되는 명시적 트리거.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ seq: string }> }
) {
  const { seq } = await params;
  const draft = await generateApplicationDraft(seq);
  if (!draft) {
    return Response.json(
      { error: "이력서 프로필 또는 공고 정보를 찾을 수 없습니다." },
      { status: 400 }
    );
  }
  return Response.json({ draft });
}

// 사용자가 검토 중 직접 고친 내용을 저장. AI를 다시 부르지 않는다.
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ seq: string }> }
) {
  const { seq } = await params;
  const body = await request.json();
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  saveApplicationDraft(seq, JSON.stringify({ ...body, seq }), body.model || "user-edited");
  return Response.json({ ok: true });
}
