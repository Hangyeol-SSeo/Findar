import { spawn } from "node:child_process";
import { join } from "node:path";
import type { FreeformDocument } from "./freeform-application";

/** Same Python 3 requirement as employer-provided DOCX filling; stdlib only. */
export function generateFreeformDocx(document: FreeformDocument, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const proc = spawn(process.env.FINDAR_PYTHON || "python3", [join(process.cwd(), "scripts/generate-application-docx.py")], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0, settled = false;
    const finish = (error?: Error, result?: string) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => { proc.kill(); finish(new DOMException("작업을 취소했습니다.", "AbortError")); };
    const timeout = setTimeout(() => { proc.kill(); finish(new Error("지원서 생성 시간이 초과되었습니다.")); }, 30000);
    signal?.addEventListener("abort", abort, { once: true });
    proc.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 20 * 1024 * 1024) { proc.kill(); finish(new Error("생성한 지원서가 너무 큽니다.")); }
      else chunks.push(chunk);
    });
    proc.stderr.resume();
    proc.stdin.on("error", () => {});
    proc.on("error", () => finish(new Error("지원서 생성에는 Python 3가 필요합니다. FINDAR_PYTHON 경로를 확인해주세요.")));
    proc.on("close", (code) => {
      if (settled) return;
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString());
        if (code !== 0 || result.error || typeof result.document !== "string") throw new Error(result.error || "지원서를 만들지 못했습니다.");
        finish(undefined, result.document);
      } catch (e) { finish(e instanceof Error ? e : new Error("지원서 생성 결과를 읽지 못했습니다.")); }
    });
    proc.stdin.end(JSON.stringify(document));
  });
}
