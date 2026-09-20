import { randomBytes } from "node:crypto";

interface Download { seq: string; filename: string; bytes: Uint8Array; expiresAt: number }
const state = globalThis as typeof globalThis & { findarDocumentDownloads?: Map<string, Download> };
const downloads = state.findarDocumentDownloads ??= new Map<string, Download>();
const TTL = 30 * 60 * 1000;
const MAX_BYTES = 50 * 1024 * 1024;

function prune() {
  for (const [token, file] of downloads) if (file.expiresAt <= Date.now()) downloads.delete(token);
}

export function storeDocumentDownload(seq: string, filename: string, document: string): string {
  prune();
  const bytes = new Uint8Array(Buffer.from(document, "base64"));
  if (bytes.byteLength > MAX_BYTES) throw new Error("작성본 파일이 너무 큽니다.");
  let total = [...downloads.values()].reduce((sum, file) => sum + file.bytes.byteLength, 0);
  for (const [token, file] of downloads) {
    if (total + bytes.byteLength <= MAX_BYTES) break;
    downloads.delete(token); total -= file.bytes.byteLength;
  }
  const token = randomBytes(32).toString("hex");
  downloads.set(token, { seq, filename, bytes, expiresAt: Date.now() + TTL });
  // Release personal data even if no later requests arrive. Do not keep the process alive.
  setTimeout(() => downloads.delete(token), TTL).unref();
  return `/api/applications/${encodeURIComponent(seq)}/fill/document/download?token=${token}`;
}

export function documentDownloadResponse(seq: string, token: string | null): Response {
  prune();
  const file = token ? downloads.get(token) : undefined;
  if (!file || file.seq !== seq)
    return Response.json({ error: "다운로드가 만료되었습니다. Word 작성본을 다시 만들어주세요." }, { status: 410, headers: { "Cache-Control": "no-store" } });
  return new Response(new Uint8Array(file.bytes), { headers: {
    "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "Content-Disposition": `attachment; filename="application-filled.docx"; filename*=UTF-8''${encodeURIComponent(file.filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    "Content-Length": String(file.bytes.byteLength),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  } });
}
