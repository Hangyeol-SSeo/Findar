import { InvalidAIModelSettings, readAIModelSettings, writeAIModelSettings } from "@/lib/ai-model-settings";

export const runtime = "nodejs";

export async function GET() {
  return Response.json(readAIModelSettings(), { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    return Response.json({ error: "같은 Findar 화면에서 설정을 저장해주세요." }, { status: 403 });
  try {
    return Response.json(writeAIModelSettings(await request.json()), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof InvalidAIModelSettings || error instanceof SyntaxError)
      return Response.json({ error: error instanceof InvalidAIModelSettings ? error.message : "모델 설정이 올바르지 않습니다." }, { status: 400 });
    console.error("[ai-model-settings] 설정 저장에 실패했습니다.", error);
    return Response.json({ error: "모델 설정 저장에 실패했습니다." }, { status: 500 });
  }
}
