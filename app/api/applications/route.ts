import { upsertApplicationStatus } from "@/lib/db";
import { isApplicationStatus } from "@/lib/application-status";

export async function POST(request: Request) {
  const { seq, status, notes } = await request.json();
  if (!seq || typeof seq !== "string" || !isApplicationStatus(status)) {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  if (notes !== undefined && typeof notes !== "string") {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  upsertApplicationStatus(seq, status, notes);
  return Response.json({ ok: true });
}
