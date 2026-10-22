import { getAllMemos, getJobBySeq, saveMemo } from "@/lib/db";
import { normalizeCompanyName } from "@/lib/company-normalize";
import { MEMO_MAX_CHARS, isMemoScope } from "@/lib/memo-types";
import { isSameOrigin } from "@/lib/request-origin";

// 공고·회사 메모 전체. 보드가 카드마다 메모 표시를 하려고 한 번에 받는다.
export async function GET() {
  return Response.json(getAllMemos(), { headers: { "Cache-Control": "no-store" } });
}

// {scope: "job", seq, text} 또는 {scope: "company", company, text}. 빈 text는 메모를 지운다.
// 회사 키는 서버가 normalizeCompanyName()으로 만든다 — 클라이언트가 정규화를 따로 하지 않게.
export async function PUT(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json().catch(() => null) as { scope?: unknown; seq?: unknown; company?: unknown; text?: unknown } | null;
  if (!body || !isMemoScope(body.scope) || typeof body.text !== "string") {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  if (body.text.length > MEMO_MAX_CHARS) {
    return Response.json({ error: `메모는 ${MEMO_MAX_CHARS.toLocaleString()}자까지 저장할 수 있습니다.` }, { status: 400 });
  }
  if (body.scope === "job") {
    if (typeof body.seq !== "string" || !body.seq || !getJobBySeq(body.seq)) {
      return Response.json({ error: "Invalid request" }, { status: 400 });
    }
    return Response.json({ scope: "job", key: body.seq, memo: saveMemo("job", body.seq, body.text) });
  }
  const displayName = typeof body.company === "string" ? body.company.trim() : "";
  const key = normalizeCompanyName(displayName);
  if (!key) return Response.json({ error: "Invalid request" }, { status: 400 });
  return Response.json({ scope: "company", key, memo: saveMemo("company", key, body.text, displayName) });
}
