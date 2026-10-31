import { isSameOrigin } from "@/lib/request-origin";
import { readApplicationMaterials, saveApplicationMaterial } from "@/lib/freeform-composition-store";

export const runtime = "nodejs";
export async function GET() {
  return Response.json({ materials: readApplicationMaterials() }, { headers: { "Cache-Control": "no-store" } });
}
export async function PUT(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  try {
    return Response.json({ material: saveApplicationMaterial(await request.json()) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "경험을 저장하지 못했습니다." }, { status: 400 });
  }
}
