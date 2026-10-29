import { sniffImage } from "./company-homepage";
import type { InputImage } from "./codex-ai";
import { zipDocumentText } from "./essay-sources";
import { transcribePostingImages } from "./posting-image-text";
import type { WatchContent } from "./watch-adapters";
import type { WatchFetcher } from "./watch-fetch";

// 채용 사이트 공고 본문이 얇을 때 채운다. 국내 공고는 본문을 이미지 한 장으로 올리거나(코리아에셋·하나자산신탁),
// 채용공고 PDF를 첨부하고 본문에는 한두 줄만 쓰는 경우가 많다(신영자산운용 "2026년 하반기 신입사원 채용공고.pdf").
// 그대로 요약하면 모집 직무·자격요건이 비어 매칭이 제목만 보고 이뤄진다.
//  1. 첨부파일: 이름이 입사지원서·동의서 같은 양식이 아닌 PDF·DOCX·HWPX의 글을 붙인다(AI 없음). HWP(구형 바이너리)는 읽지 못한다.
//  2. 그래도 얇으면 본문 이미지를 "공고 이미지 판독" 모델로 옮겨 적는다(AI 호출, 공고마다 한 번 — 저장된 공고는 다시 열지 않는다).
// 실패해도 원래 글로 저장한다(요약 실패처럼 공고를 버리지 않는다).

const THIN_CHARS = 300;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_FILES = 3;
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_SIDE = 8000; // 모델이 받는 한 변 최대. 더 긴 이미지는 조각내야 해서 건너뛴다.
const MIN_IMAGE_SIDE = 200;
const MAX_ADDED_CHARS = 20_000;
const FORM_FILE = /입사\s*지원서|지원서\s*양식|양식|서식|동의서|개인정보|자기소개서|이력서|경력기술서|form/i;

export interface WatchContentDeps {
  transcribe: (images: InputImage[]) => Promise<string>;
  pdfText: (bytes: Uint8Array) => Promise<string>;
  zipText: (bytes: Uint8Array, extension: ".docx" | ".hwpx") => string;
}

async function unpdfText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  try {
    const { text } = await extractText(pdf, { mergePages: true });
    return text.trim();
  } finally {
    await pdf.destroy();
  }
}

const defaultDeps: WatchContentDeps = {
  transcribe: (images) => transcribePostingImages(images),
  pdfText: unpdfText,
  zipText: zipDocumentText,
};

/** 제목·공백을 뺀 실제 본문 글자 수. */
function bodyLength(text: string, title: string): number {
  return text.split(title).join("").replace(/\s+/g, "").length;
}

type FileKind = "pdf" | "docx" | "hwpx";

// 이름·확장자보다 파일 앞부분을 믿는다(하나자산신탁 첨부 링크는 이름 없이 key=44&type=attach-file1).
function fileKind(bytes: Uint8Array, name: string): FileKind | null {
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "pdf"; // %PDF
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) { // ZIP: DOCX·HWPX
    if (/\.hwpx$/i.test(name)) return "hwpx";
    if (/\.docx$/i.test(name)) return "docx";
    const head = Buffer.from(bytes.slice(0, 4000)).toString("latin1");
    if (head.includes("word/")) return "docx";
    if (/Contents\/|hwpml/i.test(head)) return "hwpx";
  }
  return null;
}

async function filesText(files: WatchContent["files"], fetcher: WatchFetcher, deps: WatchContentDeps): Promise<string[]> {
  const parts: string[] = [];
  let read = 0;
  for (const file of files) {
    if (read >= MAX_FILES || !fetcher.bytes) break;
    if (FORM_FILE.test(file.name) || /\.hwp(?:$|[?#\s])/i.test(file.name)) continue;
    try {
      const got = await fetcher.bytes(file.url, MAX_FILE_BYTES);
      const name = got.filename || file.name;
      if (FORM_FILE.test(name)) continue;
      const kind = fileKind(got.bytes, name);
      if (!kind) continue;
      read += 1;
      const text = kind === "pdf" ? await deps.pdfText(got.bytes) : deps.zipText(got.bytes, `.${kind}`);
      if (text.trim()) parts.push(`[첨부: ${name || "공고 파일"}]\n${text.trim()}`);
    } catch (error) {
      console.error(`[watch-content] 첨부 ${file.url}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return parts;
}

async function imagesText(urls: string[], fetcher: WatchFetcher, deps: WatchContentDeps): Promise<string> {
  if (!fetcher.bytes) return "";
  const images: InputImage[] = [];
  for (const url of urls) {
    if (images.length >= MAX_IMAGES) break;
    try {
      const got = await fetcher.bytes(url, MAX_IMAGE_BYTES);
      const image = sniffImage(got.bytes);
      if (!image) continue;
      const side = Math.max(image.width ?? 0, image.height ?? 0);
      if (image.width !== undefined && (side < MIN_IMAGE_SIDE || side > MAX_IMAGE_SIDE)) continue;
      images.push({ mediaType: image.mediaType, data: Buffer.from(got.bytes).toString("base64") });
    } catch (error) {
      console.error(`[watch-content] 이미지 ${url}: ${error instanceof Error ? error.message : error}`);
    }
  }
  if (images.length === 0) return "";
  try {
    return (await deps.transcribe(images)).trim();
  } catch (error) {
    console.error(`[watch-content] 이미지 판독 실패: ${error instanceof Error ? error.message : error}`);
    return "";
  }
}

/** 본문이 얇으면 첨부파일 글과(그래도 얇으면) 본문 이미지 판독 결과를 덧붙인 글. */
export async function completeWatchContent(
  content: WatchContent,
  title: string,
  fetcher: WatchFetcher,
  deps: Partial<WatchContentDeps> = {},
): Promise<string> {
  const d = { ...defaultDeps, ...deps };
  let text = content.text;
  if (bodyLength(text, title) >= THIN_CHARS) return text;

  const fromFiles = await filesText(content.files, fetcher, d);
  if (fromFiles.length) text = `${text}\n\n${fromFiles.join("\n\n").slice(0, MAX_ADDED_CHARS)}`.trim();
  if (bodyLength(text, title) >= THIN_CHARS) return text;

  const fromImages = await imagesText(content.images, fetcher, d);
  if (fromImages) text = `${text}\n\n[본문 이미지 판독]\n${fromImages.slice(0, MAX_ADDED_CHARS)}`.trim();
  return text;
}
