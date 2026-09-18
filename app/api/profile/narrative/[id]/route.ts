import {
  readNarrativeProfile,
  updateNarrativeEpisode,
  deleteNarrativeEpisode,
  type NarrativeEpisode,
} from "@/lib/narrative-profile";

// 사용자가 목록에서 episode 하나를 직접 고친 내용 저장 — 보낸 필드만 반영.
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();

  const patch: Partial<Pick<NarrativeEpisode, "title" | "situation" | "reasoning" | "lesson" | "tags">> = {};
  if (typeof body.title === "string") patch.title = body.title;
  if (typeof body.situation === "string") patch.situation = body.situation;
  if (typeof body.reasoning === "string") patch.reasoning = body.reasoning;
  if (typeof body.lesson === "string") patch.lesson = body.lesson;
  if (Array.isArray(body.tags)) patch.tags = body.tags;

  updateNarrativeEpisode(id, patch);
  return Response.json({ profile: readNarrativeProfile() });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  deleteNarrativeEpisode(id);
  return Response.json({ profile: readNarrativeProfile() });
}
