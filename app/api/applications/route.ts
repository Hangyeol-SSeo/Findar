import { after } from "next/server";
import { upsertApplicationStatus } from "@/lib/db";
import { isApplicationStatus } from "@/lib/application-status";
import { syncApplicationToSheet } from "@/lib/sheet-sync";

export async function POST(request: Request) {
  const { seq, status, notes } = await request.json();
  if (!seq || typeof seq !== "string" || !isApplicationStatus(status)) {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  if (notes !== undefined && typeof notes !== "string") {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  upsertApplicationStatus(seq, status, notes);
  // 시트 기록은 응답을 막지 않는다. 실패하면 재시도 큐에 남는다.
  after(() => syncApplicationToSheet(seq));
  return Response.json({ ok: true });
}
