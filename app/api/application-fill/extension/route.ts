import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
export const runtime = "nodejs";
export async function GET() {
  try {
    const { stdout } = await promisify(execFile)(process.env.FINDAR_PYTHON || "python3", ["-c", "import io,sys,zipfile,pathlib; b=io.BytesIO(); z=zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED); [z.write(p,'findar-browser/'+p.name) for p in pathlib.Path(sys.argv[1]).iterdir() if p.is_file()]; z.close(); sys.stdout.buffer.write(b.getvalue())", join(process.cwd(), "browser-extension")], { encoding: "buffer", maxBuffer: 1024 * 1024 });
    return new Response(new Uint8Array(stdout), { headers: { "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="findar-browser.zip"' } });
  } catch { return Response.json({ error: "확장 기능 다운로드에는 Python 3가 필요합니다." }, { status: 500 }); }
}
