import { isSameOrigin } from "@/lib/request-origin";
import { getProfileStatus } from "@/lib/profile";
import { deleteResumeFile, listResumeFiles, MAX_RESUME_FILES, saveResumeFile } from "@/lib/resume-files";

export const runtime = "nodejs";

function snapshot() {
  return { files: listResumeFiles(), ...getProfileStatus() };
}

// 업로드된 이력서 목록 + 분석 캐시 상태. AI 호출 없음.
export async function GET() {
  return Response.json(snapshot(), { headers: { "Cache-Control": "private, no-store" } });
}

// multipart/form-data, 필드명 "files"(여러 개 가능). 파일만 저장하고 분석은 하지 않는다 —
// 분석은 /api/profile/resume/analyze 또는 다음 공고 새로고침 때 한 번만 돈다.
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  let files: File[];
  try {
    const form = await request.formData();
    files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  } catch {
    return Response.json({ error: "업로드 요청을 읽지 못했습니다." }, { status: 400 });
  }
  if (files.length === 0) return Response.json({ error: "올릴 PDF 파일을 선택해주세요." }, { status: 400 });
  if (files.length > MAX_RESUME_FILES)
    return Response.json({ error: `한 번에 최대 ${MAX_RESUME_FILES}개까지 올릴 수 있습니다.` }, { status: 400 });

  const saved: string[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      saved.push(saveResumeFile(file.name, new Uint8Array(await file.arrayBuffer())));
    } catch (e) {
      errors.push(e instanceof Error ? e.message : `${file.name}: 저장 실패`);
    }
  }
  return Response.json({ ...snapshot(), saved, errors }, { status: saved.length ? 200 : 400 });
}

export async function DELETE(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const name = new URL(request.url).searchParams.get("name") ?? "";
  if (!deleteResumeFile(name)) return Response.json({ error: "파일을 찾을 수 없습니다." }, { status: 404 });
  return Response.json(snapshot());
}
