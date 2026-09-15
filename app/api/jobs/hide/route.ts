import { getHiddenSeqs, setJobHidden } from "@/lib/db";

export async function GET() {
  return Response.json({ seqs: getHiddenSeqs() });
}

export async function POST(request: Request) {
  const { seq, hidden } = await request.json();
  if (!seq || typeof hidden !== "boolean") {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  setJobHidden(seq, hidden);
  return Response.json({ ok: true });
}
