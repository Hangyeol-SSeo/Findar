import { getCodexConnectionStatus } from "@/lib/codex-ai";

export const runtime = "nodejs";

export async function GET() {
  return Response.json(await getCodexConnectionStatus(), { headers: { "Cache-Control": "no-store" } });
}
