import { spawn } from "node:child_process";
import { join } from "node:path";
import type { FillTarget } from "./application-fill";
interface DocxResult { targets: FillTarget[]; document?: string; filled?: number; unsupported: string }
export function processDocx(document: string, assignments?: { targetId: string; value: string }[]): Promise<DocxResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.env.FINDAR_PYTHON || "python3", [join(process.cwd(), "scripts/fill-docx.py")], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    const timeout = setTimeout(() => { proc.kill(); reject(new Error("Word 파일 처리 시간이 초과되었습니다.")); }, 30000);
    proc.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 20 * 1024 * 1024) { proc.kill(); reject(new Error("작성 결과가 너무 큽니다.")); } else chunks.push(chunk); });
    proc.stderr.resume();
    proc.stdin.on("error", () => {});
    proc.on("error", () => { clearTimeout(timeout); reject(new Error("Word 작성에는 Python 3가 필요합니다. FINDAR_PYTHON 경로를 확인해주세요.")); });
    proc.on("close", () => {
      clearTimeout(timeout);
      try { const data = JSON.parse(Buffer.concat(chunks).toString()); if (data.error) reject(new Error(data.error)); else resolve(data); }
      catch { reject(new Error("DOCX 파일을 읽지 못했습니다.")); }
    });
    proc.stdin.end(JSON.stringify({ document, ...(assignments ? { assignments } : {}) }));
  });
}
