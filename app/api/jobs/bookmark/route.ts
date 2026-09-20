import { setJobBookmarked } from "@/lib/db";

export async function POST(request: Request) {
  const { seq, bookmarked } = await request.json();
  if (!seq || typeof bookmarked !== "boolean") {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  setJobBookmarked(seq, bookmarked);
  return Response.json({ ok: true });
}
