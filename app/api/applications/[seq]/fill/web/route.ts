import { createFillSession, verifyFillSession, localRequest } from "@/lib/fill-session";
import { getJobBySeq } from "@/lib/db";
import { planApplicationFill, validateFillTargets } from "@/lib/application-fill";
export const maxDuration = 180;
export async function POST(request: Request, { params }: { params: Promise<{ seq: string }> }) {
  const { seq } = await params;
  if (!getJobBySeq(seq)) return Response.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token) {
    if (!localRequest(request)) return Response.json({ error: "Findar를 localhost에서 열어 연결해주세요." }, { status: 403 });
    return Response.json({ token: createFillSession(seq) });
  }
  if (!verifyFillSession(token, seq)) return Response.json({ error: "연결이 만료되었습니다. Findar에서 다시 연결해주세요." }, { status: 401 });
  try {
    const body = await request.json();
    const targets = validateFillTargets(body.targets);
    return Response.json(await planApplicationFill(targets, request.signal));
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : "입력칸 분석에 실패했습니다." }, { status: 400 }); }
}
