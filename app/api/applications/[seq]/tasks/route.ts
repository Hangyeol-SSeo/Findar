import { listApplicationTasks } from "@/lib/application-tasks";
export const runtime = "nodejs";
export async function GET(_request: Request, { params }: { params: Promise<{ seq: string }> }) {
  const { seq } = await params;
  // Drafts themselves are loaded through the existing draft API; web capability results are private.
  return Response.json({ tasks: listApplicationTasks(seq).filter((t) => t.kind !== "web") }, { headers: { "Cache-Control": "private, no-store" } });
}
