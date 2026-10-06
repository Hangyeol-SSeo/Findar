import { after } from "next/server";
import { isSameOrigin } from "@/lib/request-origin";
import { ensureEssayBank, getEssayBankProgress, getEssaySourceStatus } from "@/lib/essay-bank";

export const runtime = "nodejs";
export const maxDuration = 3600;

// 설정 화면의 "지금 분석" — 자기소개서 작성을 기다리지 않고 새로 올린 파일만 분석한다. 파일이 많으면 몇 분 걸리므로
// 백그라운드로 돌리고, 화면은 GET /api/essay-sources의 progress를 본다. 바뀐 파일이 없으면 AI 호출이 없다.
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const { retryFailed } = await request.json().catch(() => ({}));
  const run = ensureEssayBank({ retryFailed: retryFailed === true });
  after(() => run.catch((error) => console.error("[essay-sources] 분석 실패:", error)));
  return Response.json({ files: getEssaySourceStatus(), progress: getEssayBankProgress() }, { status: 202 });
}
