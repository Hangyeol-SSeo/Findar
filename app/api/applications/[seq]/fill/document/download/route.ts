import { documentDownloadResponse } from "@/lib/document-download";
export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ seq: string }> }) {
  const { seq } = await params;
  return documentDownloadResponse(seq, new URL(request.url).searchParams.get("token"));
}
