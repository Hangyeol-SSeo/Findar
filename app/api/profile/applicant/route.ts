import { readApplicantProfile, writeApplicantProfile } from "@/lib/applicant-profile";

// 지원 정보(인적사항/학력/경력/프로젝트 등) 조회 — Claude in Chrome 등으로 실제 지원폼을
// 채울 때 이 엔드포인트에서 정확한 값을 그대로 가져다 쓰면 된다.
export async function GET() {
  return Response.json({ profile: readApplicantProfile() });
}

export async function PUT(request: Request) {
  const body = await request.json();
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  writeApplicantProfile(body);
  return Response.json({ ok: true });
}
