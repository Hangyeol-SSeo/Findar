import { isSameOrigin } from "@/lib/request-origin";
import { generateCustomEssayAnswer, getCachedApplicationDraft, persistEssay } from "@/lib/application-draft";
import { parseEssayRequest } from "@/lib/essay-contract";

// lib/application-draft.ts의 askModel이 호출 하나당 최대 10분(재시도 포함 최악의 경우
// 최대 3번 호출)까지 기다릴 수 있게 늘어난 것과 맞춰서 라우트 예산도 같이 늘린다 — 로컬
// 실행(npm run dev)에서는 실제로 적용되지 않지만, 서버리스 배포 시 여기서 먼저 끊기면
// 내부 타임아웃을 늘린 의미가 없어진다.
export const maxDuration = 1800;
const running = new Set<string>();

export async function POST(request: Request, { params }: { params: Promise<{ seq: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const { seq } = await params;
  let input;
  try { input = parseEssayRequest(await request.json()); }
  catch (e) { return Response.json({ error: e instanceof Error ? e.message : "문항을 확인해주세요." }, { status: 400 }); }
  if (running.has(seq)) return Response.json({ error: "이 공고의 답변을 작성 중입니다." }, { status: 409 });
  running.add(seq);
  const initial = JSON.stringify(getCachedApplicationDraft(seq));
  try {
    const answer = await generateCustomEssayAnswer(seq, input, request.signal);
    if (request.signal.aborted) return new Response(null, { status: 499 });
    if (JSON.stringify(getCachedApplicationDraft(seq)) !== initial)
      return Response.json({ error: "작성 중 저장된 답변이 변경되어 덮어쓰지 않았습니다. 다시 시도해주세요." }, { status: 409 });
    return Response.json({ answer, draft: persistEssay(seq, answer) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "답변 작성에 실패했습니다." }, { status: 502 });
  } finally { running.delete(seq); }
}
