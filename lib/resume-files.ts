import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { basename, join } from "path";

// 웹(/settings → 이력서 탭)에서 올린 이력서/포트폴리오 PDF 저장소. 예전에는 repo 루트의
// resume/ 디렉터리에 직접 파일을 넣어야 했지만, 이제는 gitignore된 data/ 아래에서 앱이
// 직접 관리한다. 옛 resume/ 파일은 lib/profile.ts가 최초 1회 이쪽으로 옮긴다.
export const RESUME_DIR = join(process.cwd(), "data", "resume");
export const LEGACY_RESUME_DIR = join(process.cwd(), "resume");

export const MAX_RESUME_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_RESUME_FILES = 10;

export interface ResumeFileInfo {
  name: string;
  size: number;
  uploadedAt: number;
}

export function listPdfsIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .map((f) => join(dir, f))
    .sort();
}

export function listResumePdfs(): string[] {
  return listPdfsIn(RESUME_DIR);
}

export function listResumeFiles(): ResumeFileInfo[] {
  return listResumePdfs().map((p) => {
    const s = statSync(p);
    return { name: basename(p), size: s.size, uploadedAt: s.mtimeMs };
  });
}

// 파일 이름 + 내용 기준 해시 — 경로/수정시각과 무관해서, 같은 파일을 다시 올려도
// 이력서 재분석(=토큰 소모)이 일어나지 않는다. Profile.sourcesHash로 쓰인다.
export function hashResumeSources(paths: string[]): string {
  const h = createHash("sha256");
  for (const p of [...paths].sort()) {
    const content = createHash("sha256").update(readFileSync(p)).digest("hex");
    h.update(`${basename(p)}\0${content}\n`);
  }
  return h.digest("hex");
}

// 업로드 파일명 정리 — 경로 구분자/제어문자 제거, 확장자는 항상 .pdf.
// 순수 함수라 scripts/tests에서 그대로 검증한다.
export function sanitizeResumeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const stem = Array.from(base.replace(/\.pdf$/i, ""))
    .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f && !'<>:"|?*'.includes(c))
    .join("")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 100);
  return `${stem || "resume"}.pdf`;
}

export function isPdfBytes(bytes: Uint8Array): boolean {
  // "%PDF-" 매직 넘버. 확장자만 .pdf인 다른 파일을 걸러낸다.
  return bytes.length >= 5 && [0x25, 0x50, 0x44, 0x46, 0x2d].every((b, i) => bytes[i] === b);
}

// 같은 이름이면 교체한다 — "새 버전 이력서를 같은 이름으로 다시 올리기"가 자연스러운 갱신 방법이라서.
export function saveResumeFile(rawName: string, bytes: Uint8Array): string {
  if (!isPdfBytes(bytes)) throw new Error(`${rawName}: PDF 파일만 올릴 수 있습니다.`);
  if (bytes.length > MAX_RESUME_FILE_BYTES) throw new Error(`${rawName}: 파일당 20MB까지 올릴 수 있습니다.`);
  const name = sanitizeResumeFileName(rawName);
  const existing = new Set(listResumeFiles().map((f) => f.name));
  if (!existing.has(name) && existing.size >= MAX_RESUME_FILES)
    throw new Error(`이력서/포트폴리오는 최대 ${MAX_RESUME_FILES}개까지 올릴 수 있습니다.`);
  mkdirSync(RESUME_DIR, { recursive: true });
  writeFileSync(join(RESUME_DIR, name), bytes);
  return name;
}

export function deleteResumeFile(name: string): boolean {
  // 목록에 실제로 있는 이름만 허용 — 임의 경로 삭제 방지.
  const target = listResumePdfs().find((p) => basename(p) === name);
  if (!target) return false;
  unlinkSync(target);
  return true;
}
