import { execFileSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, extname, join } from "path";

// 설정 → "과거 자소서·면접" 탭에서 올린 원본 저장소. 이력서(lib/resume-files.ts)와 같은 방식으로 gitignore된
// data/ 아래에 두고, 종류별 하위 폴더로 나눈다. 분석(문항·답변 추출)은 lib/essay-bank.ts가 파일별로 한다.
// Read 도구가 읽을 수 있는 PDF·텍스트만 보관하고, DOCX·HWPX는 올릴 때 텍스트로 바꿔 .txt로 저장한다.

export const ESSAY_SOURCE_KINDS = ["cover_letter", "interview"] as const;
export type EssaySourceKind = (typeof ESSAY_SOURCE_KINDS)[number];
export const ESSAY_SOURCE_KIND_LABEL: Record<EssaySourceKind, string> = { cover_letter: "자기소개서", interview: "면접 대본" };

const ROOT = join(process.cwd(), "data", "essay-sources");
const KIND_DIR: Record<EssaySourceKind, string> = { cover_letter: join(ROOT, "cover-letters"), interview: join(ROOT, "interviews") };
// 예전에는 repo 루트의 cover-letters/에 직접 넣어야 했다. 처음 한 번 새 저장소로 옮긴다.
const LEGACY_COVER_LETTER_DIR = join(process.cwd(), "cover-letters");

export const MAX_ESSAY_SOURCE_BYTES = 20 * 1024 * 1024;
export const MAX_ESSAY_SOURCES_PER_KIND = 30;
export const MAX_PASTED_CHARS = 100_000;
const STORED_EXTENSIONS = [".pdf", ".txt", ".md"];

export interface EssaySourceFile {
  kind: EssaySourceKind;
  name: string;
  path: string;
  size: number;
  uploadedAt: number;
}

export const isEssaySourceKind = (value: unknown): value is EssaySourceKind => ESSAY_SOURCE_KINDS.includes(value as EssaySourceKind);
export const essaySourceKey = (file: Pick<EssaySourceFile, "kind" | "name">) => `${file.kind}/${file.name}`;

// 업로드할 때 사용자가 적은 "이 글을 낸 회사·직무". AI 추출보다 우선하는 출처 정보라, 다른 회사 이름 차단(application-harness)이
// 모델이 회사명을 놓쳐도 동작한다. data/essay-sources/meta.json에 파일 키별로 둔다.
export interface EssaySourceMeta { company: string; role: string }
const META_PATH = join(ROOT, "meta.json");

function readMetaStore(): Record<string, EssaySourceMeta> {
  if (!existsSync(META_PATH)) return {};
  try { return JSON.parse(readFileSync(META_PATH, "utf8")); } catch { return {}; }
}

function writeMetaStore(store: Record<string, EssaySourceMeta>): void {
  mkdirSync(ROOT, { recursive: true });
  const tmp = `${META_PATH}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, META_PATH);
}

export function getEssaySourceMeta(file: Pick<EssaySourceFile, "kind" | "name">): EssaySourceMeta | null {
  return readMetaStore()[essaySourceKey(file)] ?? null;
}

export function parseEssaySourceMeta(company: unknown, role: unknown): EssaySourceMeta | null {
  const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 100) : "");
  const meta = { company: clean(company), role: clean(role) };
  return meta.company || meta.role ? meta : null;
}

// 값이 있으면 기록하고, 다시 올리면서 비워 두면 이전 기록을 유지한다.
function setMeta(kind: EssaySourceKind, name: string, meta: EssaySourceMeta | null): void {
  if (!meta) return;
  const store = readMetaStore();
  store[essaySourceKey({ kind, name })] = meta;
  writeMetaStore(store);
}

// 이미 올린 파일의 회사·직무를 나중에 적거나 고친다. 둘 다 비우면 기록을 지운다.
export function updateEssaySourceMeta(kind: EssaySourceKind, name: string, meta: EssaySourceMeta | null): EssaySourceFile {
  const target = listEssaySources(kind).find((f) => f.name === name);
  if (!target) throw new Error("파일을 찾을 수 없습니다.");
  const store = readMetaStore();
  if (meta) store[essaySourceKey(target)] = meta;
  else delete store[essaySourceKey(target)];
  writeMetaStore(store);
  return target;
}

function migrateLegacyCoverLetters(): void {
  if (!existsSync(LEGACY_COVER_LETTER_DIR)) return;
  try {
    mkdirSync(KIND_DIR.cover_letter, { recursive: true });
    for (const name of readdirSync(LEGACY_COVER_LETTER_DIR)) {
      if (!STORED_EXTENSIONS.includes(extname(name).toLowerCase())) continue;
      const target = join(KIND_DIR.cover_letter, name);
      if (!existsSync(target)) renameSync(join(LEGACY_COVER_LETTER_DIR, name), target);
    }
  } catch (error) {
    console.error("[essay-sources] cover-letters/ 파일을 옮기지 못했습니다:", error);
  }
}
migrateLegacyCoverLetters();

export function listEssaySources(kind?: EssaySourceKind): EssaySourceFile[] {
  return (kind ? [kind] : [...ESSAY_SOURCE_KINDS]).flatMap((k) => {
    const dir = KIND_DIR[k];
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => STORED_EXTENSIONS.includes(extname(name).toLowerCase()))
      .sort()
      .map((name) => {
        const path = join(dir, name);
        const s = statSync(path);
        return { kind: k, name, path, size: s.size, uploadedAt: s.mtimeMs };
      });
  });
}

// 파일 이름 + 내용 + 사용자가 적은 회사·직무 기준 — 같은 파일을 다시 올려도 재분석하지 않고, 회사·직무를 고치면 다시 분석한다.
export function hashEssaySource(file: EssaySourceFile): string {
  const content = createHash("sha256").update(readFileSync(file.path)).digest("hex");
  const meta = getEssaySourceMeta(file);
  // 회사·직무를 적지 않은 파일은 이전과 같은 해시를 유지해, 기능 추가만으로 기존 파일이 다시 분석되지 않게 한다.
  return createHash("sha256").update(`${file.kind}\0${file.name}\0${content}${meta ? `\0${JSON.stringify(meta)}` : ""}`).digest("hex");
}

// 경로 구분자·제어문자를 지우고 지정한 확장자를 붙인다. 순수 함수라 테스트에서 그대로 검증한다.
export function sanitizeEssaySourceName(raw: string, extension: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const stem = Array.from(base.replace(/\.(pdf|txt|md|docx|hwpx|hwp)$/i, ""))
    .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f && !'<>:"|?*'.includes(c))
    .join("")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 100);
  return `${stem || "자료"}${extension}`;
}

const decodeXml = (text: string) => text
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, "&");

// DOCX(word/document.xml)와 HWPX(Contents/section*.xml)의 본문 XML에서 문단 텍스트만 꺼낸다. 표 안의 문단도
// 같은 문단 태그라 함께 나온다. prefix는 w(DOCX) 또는 hp(HWPX).
export function xmlParagraphsToText(xml: string, prefix: "w" | "hp"): string {
  const paragraphs = xml.split(new RegExp(`</${prefix}:p>`));
  const runText = new RegExp(`<${prefix}:t(?:\\s[^>]*)?>([\\s\\S]*?)</${prefix}:t>|<${prefix}:tab\\b[^>]*/>|<${prefix}:(?:br|lineBreak)\\b[^>]*/>`, "g");
  const inlineTab = new RegExp(`<${prefix}:tab\\b[^>]*/>`, "g");
  const inlineBreak = new RegExp(`<${prefix}:(?:br|lineBreak)\\b[^>]*/>`, "g");
  return paragraphs
    .map((p) => {
      let line = "";
      for (const m of p.matchAll(runText)) {
        // HWPX는 탭·줄바꿈이 글자 요소 안에 들어 있다.
        if (m[1] !== undefined) line += decodeXml(m[1].replace(inlineTab, "\t").replace(inlineBreak, "\n").replace(/<[^>]+>/g, ""));
        else line += m[0].includes(":tab") ? "\t" : "\n";
      }
      return line.trimEnd();
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function zipDocumentText(bytes: Uint8Array, extension: ".docx" | ".hwpx"): string {
  const tmp = join(tmpdir(), `findar-${randomUUID()}${extension}`);
  writeFileSync(tmp, bytes);
  try {
    // 시스템 unzip 사용(lib/dart.ts와 같은 이유: 로컬 전용 도구라 npm 의존성을 늘리지 않는다).
    const entries = execFileSync("unzip", ["-Z1", tmp], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").map((s) => s.trim()).filter(Boolean);
    const targets = extension === ".docx"
      ? entries.filter((e) => e === "word/document.xml")
      : entries.filter((e) => /^Contents\/section\d+\.xml$/.test(e)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
    if (!targets.length) throw new Error("본문을 찾지 못했습니다");
    return targets
      .map((entry) => xmlParagraphsToText(execFileSync("unzip", ["-p", tmp, entry], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }), extension === ".docx" ? "w" : "hp"))
      .join("\n\n");
  } finally {
    rmSync(tmp, { force: true });
  }
}

function writeSource(kind: EssaySourceKind, name: string, data: Uint8Array | string): string {
  const existing = new Set(listEssaySources(kind).map((f) => f.name));
  if (!existing.has(name) && existing.size >= MAX_ESSAY_SOURCES_PER_KIND)
    throw new Error(`${ESSAY_SOURCE_KIND_LABEL[kind]} 파일은 최대 ${MAX_ESSAY_SOURCES_PER_KIND}개까지 올릴 수 있습니다.`);
  mkdirSync(KIND_DIR[kind], { recursive: true });
  writeFileSync(join(KIND_DIR[kind], name), data);
  return name;
}

// 같은 이름이면 교체한다. DOCX·HWPX는 텍스트로 바꿔 "<이름>.txt"로 저장한다.
export function saveEssaySourceFile(kind: EssaySourceKind, rawName: string, bytes: Uint8Array, meta: EssaySourceMeta | null = null): string {
  const name = writeSourceFile(kind, rawName, bytes);
  setMeta(kind, name, meta);
  return name;
}

function writeSourceFile(kind: EssaySourceKind, rawName: string, bytes: Uint8Array): string {
  const extension = extname(rawName).toLowerCase();
  if (bytes.length > MAX_ESSAY_SOURCE_BYTES) throw new Error(`${rawName}: 파일당 20MB까지 올릴 수 있습니다.`);
  if (extension === ".hwp") throw new Error(`${rawName}: HWP는 읽을 수 없습니다. 한글에서 PDF나 HWPX로 저장해 올려주세요.`);
  if (extension === ".pdf") {
    if (!(bytes.length >= 5 && [0x25, 0x50, 0x44, 0x46, 0x2d].every((b, i) => bytes[i] === b)))
      throw new Error(`${rawName}: PDF 파일이 아닙니다.`);
    return writeSource(kind, sanitizeEssaySourceName(rawName, ".pdf"), bytes);
  }
  if (extension === ".txt" || extension === ".md") {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (!text.trim()) throw new Error(`${rawName}: 내용이 비어 있습니다.`);
    return writeSource(kind, sanitizeEssaySourceName(rawName, extension), text);
  }
  if (extension === ".docx" || extension === ".hwpx") {
    let text: string;
    try { text = zipDocumentText(bytes, extension); }
    catch { throw new Error(`${rawName}: 문서에서 글을 읽지 못했습니다. PDF로 저장해 올려주세요.`); }
    if (!text.trim()) throw new Error(`${rawName}: 문서에 글이 없습니다.`);
    return writeSource(kind, sanitizeEssaySourceName(rawName, ".txt"), text);
  }
  throw new Error(`${rawName}: PDF, TXT, MD, DOCX, HWPX 파일만 올릴 수 있습니다.`);
}

// 메모장·노션 등에 적어둔 면접 대본을 그대로 붙여넣는 경우.
export function saveEssaySourceText(kind: EssaySourceKind, title: string, text: string, meta: EssaySourceMeta | null = null): string {
  if (!text.trim()) throw new Error("붙여넣을 내용을 입력해주세요.");
  if (text.length > MAX_PASTED_CHARS) throw new Error(`붙여넣기는 ${MAX_PASTED_CHARS.toLocaleString()}자까지 가능합니다.`);
  const name = writeSource(kind, sanitizeEssaySourceName(title.trim() || `붙여넣기 ${new Date().toISOString().slice(0, 10)}`, ".txt"), text.trim());
  setMeta(kind, name, meta);
  return name;
}

export function deleteEssaySource(kind: EssaySourceKind, name: string): boolean {
  // 목록에 실제로 있는 이름만 허용 — 임의 경로 삭제 방지.
  const target = listEssaySources(kind).find((f) => f.name === basename(name) && f.name === name);
  if (!target) return false;
  unlinkSync(target.path);
  const store = readMetaStore();
  if (store[essaySourceKey(target)]) { delete store[essaySourceKey(target)]; writeMetaStore(store); }
  return true;
}
