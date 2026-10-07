import { after } from "next/server";
import { isSameOrigin } from "@/lib/request-origin";
import { ensureExperienceCards, getExperienceCardStatus, setCardConfirmed } from "@/lib/experience-cards";

export const runtime = "nodejs";
export const maxDuration = 1800;

// 과거 자소서·면접 대본에서 정리한 경험 카드와 상태. AI 호출 없음.
export async function GET() {
  return Response.json(getExperienceCardStatus(), { headers: { "Cache-Control": "private, no-store" } });
}

// 카드 다시 만들기 — 과거 자료가 바뀌었거나 이전 정리가 실패했을 때만 실제로 돈다. 백그라운드로 실행한다.
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const run = ensureExperienceCards();
  after(() => run.catch((error) => console.error("[experience-cards] 정리 실패:", error)));
  return Response.json(getExperienceCardStatus(), { status: 202 });
}

// 사용자 확인/확인 취소 — 확인한 카드만 자기소개서 작성에 쓰인다.
export async function PATCH(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  try {
    const { id, confirmed } = await request.json();
    if (typeof id !== "string" || typeof confirmed !== "boolean") throw new Error("요청을 확인해주세요.");
    setCardConfirmed(id, confirmed);
    return Response.json(getExperienceCardStatus());
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "처리하지 못했습니다." }, { status: 400 });
  }
}
