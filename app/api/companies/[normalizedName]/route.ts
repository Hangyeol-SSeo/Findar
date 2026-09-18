import { getCompany, getCompanySections, upsertCompanySeen } from "@/lib/db";

// AI 호출 없는 순수 조회. 회사 리서치 탭을 열 때마다 비용 걱정 없이 호출해도 된다.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ normalizedName: string }> }
) {
  const { normalizedName } = await params;
  const { searchParams } = new URL(request.url);
  const displayName = searchParams.get("displayName");
  if (displayName) upsertCompanySeen(displayName);

  return Response.json({
    company: getCompany(normalizedName) ?? null,
    sections: getCompanySections(normalizedName),
  });
}
