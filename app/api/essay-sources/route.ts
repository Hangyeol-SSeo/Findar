import { isSameOrigin } from "@/lib/request-origin";
import { getEssayBankProgress, getEssaySourceStatus } from "@/lib/essay-bank";
import {
  deleteEssaySource, ESSAY_SOURCE_KIND_LABEL, isEssaySourceKind, MAX_ESSAY_SOURCES_PER_KIND, parseEssaySourceMeta, saveEssaySourceFile, saveEssaySourceText,
} from "@/lib/essay-sources";

export const runtime = "nodejs";

function snapshot() {
  return { files: getEssaySourceStatus(), progress: getEssayBankProgress() };
}

// 올린 과거 자소서·면접 대본 목록과 파일별 분석 결과. AI 호출 없음.
export async function GET() {
  return Response.json(snapshot(), { headers: { "Cache-Control": "private, no-store" } });
}

// multipart/form-data(kind + files 여러 개 + 선택 company·role) 또는 JSON({kind, title, text, company?, role?}: 붙여넣기).
// company·role은 그 글을 낸 회사·직무로, AI 추출보다 우선하는 출처 정보다. 저장만 하고 분석은
// /api/essay-sources/analyze 또는 다음 자기소개서 작성 때 한 번만 돈다.
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const saved: string[] = [];
  const errors: string[] = [];
  try {
    if ((request.headers.get("content-type") ?? "").includes("application/json")) {
      const { kind, title, text, company, role } = await request.json();
      if (!isEssaySourceKind(kind)) throw new Error("자료 종류를 골라주세요.");
      saved.push(saveEssaySourceText(kind, typeof title === "string" ? title : "", typeof text === "string" ? text : "", parseEssaySourceMeta(company, role)));
    } else {
      const form = await request.formData();
      const kind = form.get("kind");
      if (!isEssaySourceKind(kind)) throw new Error("자료 종류를 골라주세요.");
      const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
      const meta = parseEssaySourceMeta(form.get("company"), form.get("role"));
      if (!files.length) throw new Error("올릴 파일을 선택해주세요.");
      if (files.length > MAX_ESSAY_SOURCES_PER_KIND) throw new Error(`한 번에 최대 ${MAX_ESSAY_SOURCES_PER_KIND}개까지 올릴 수 있습니다.`);
      for (const file of files) {
        try { saved.push(saveEssaySourceFile(kind, file.name, new Uint8Array(await file.arrayBuffer()), meta)); }
        catch (e) { errors.push(e instanceof Error ? e.message : `${file.name}: 저장 실패`); }
      }
      if (saved.length) console.info(`[essay-sources] ${ESSAY_SOURCE_KIND_LABEL[kind]} ${saved.length}개 저장`);
    }
  } catch (e) {
    return Response.json({ ...snapshot(), error: e instanceof Error ? e.message : "업로드 요청을 읽지 못했습니다." }, { status: 400 });
  }
  return Response.json({ ...snapshot(), saved, errors }, { status: saved.length ? 200 : 400 });
}

export async function DELETE(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const params = new URL(request.url).searchParams;
  const kind = params.get("kind");
  if (!isEssaySourceKind(kind) || !deleteEssaySource(kind, params.get("name") ?? ""))
    return Response.json({ error: "파일을 찾을 수 없습니다." }, { status: 404 });
  // 지운 파일에서 나온 항목은 다음 분석(작성 직전 포함) 때 정리된다. 목록에서는 바로 빠진다.
  return Response.json(snapshot());
}
