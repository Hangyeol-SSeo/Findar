import { isSameOrigin } from "@/lib/request-origin";
import { ensureProfile, getProfileStatus } from "@/lib/profile";
import { listResumeFiles } from "@/lib/resume-files";

export const runtime = "nodejs";
export const maxDuration = 600;

// 설정 화면의 "지금 분석" — 공고 새로고침을 기다리지 않고 바로 이력서를 분석한다.
// 파일이 안 바뀌었으면 캐시를 그대로 돌려주므로(AI 호출 없음) 여러 번 눌러도 안전하다.
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const result = await ensureProfile();
  const body = { files: listResumeFiles(), ...getProfileStatus(), result: result.status, error: result.error };
  if (result.status === "missing") return Response.json({ ...body, error: "먼저 이력서 PDF를 올려주세요." }, { status: 400 });
  if (result.status === "error") return Response.json({ ...body, error: result.error || "이력서 분석에 실패했습니다." }, { status: 500 });
  return Response.json(body);
}
