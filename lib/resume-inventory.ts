import { query } from "./ai-query";
import { getAIModelId } from "./ai-model-settings";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { hashResumeSources, listResumePdfs } from "./resume-files";
import { extractJsonObject, type ResumeItem } from "./resume-tailoring-contract";

// 이력 취사선택 평가(lib/resume-tailoring.ts)에 쓰는 "이력서 항목 전체 목록".
// lib/profile.ts의 Profile은 매칭용 요약이라 오래된 활동·자격증·취미 같은 자잘한 항목이
// 빠져 있는데, 취사선택 평가는 바로 그런 항목들이 대상이다. 그래서 이력서를 항목 단위로
// 빠짐없이 옮긴 목록을 따로 만든다. 공고마다 PDF를 다시 읽지 않도록 Profile과 같은
// 이력서 해시로 캐시하고, 이 기능을 처음 쓸 때만 추출한다(lazy — 매칭 파이프라인과 무관).
// 원본 PDF를 읽으므로 FreeRide를 거치지 않고 항상 Anthropic API를 직접 쓴다.
const DATA_DIR = join(process.cwd(), "data");
const INVENTORY_PATH = join(DATA_DIR, "resume-inventory.json");

mkdirSync(DATA_DIR, { recursive: true });

export interface ResumeInventory {
  sourcesHash: string;
  generatedAt: number;
  model: string;
  items: ResumeItem[];
}

function readCached(): ResumeInventory | null {
  if (!existsSync(INVENTORY_PATH)) return null;
  try {
    return JSON.parse(readFileSync(INVENTORY_PATH, "utf-8")) as ResumeInventory;
  } catch {
    return null;
  }
}

async function extractInventory(pdfPaths: string[], sourcesHash: string, model: string): Promise<ResumeInventory> {
  const prompt = `다음 PDF 파일들을 모두 Read 도구로 읽고, 이력서/포트폴리오에 적힌 이력 항목을 빠짐없이 목록으로 옮겨라.

파일 목록:
${pdfPaths.map((p) => `- ${p}`).join("\n")}

규칙:
- 요약하거나 중요도로 걸러내지 마라. 오래된 활동, 짧은 경력, 사소해 보이는 자격증·수상·교육 이수·아르바이트·취미까지 적힌 것은 전부 옮긴다. 이 목록은 나중에 "무엇을 뺄지"를 판단하는 데 쓰이므로 빠진 항목이 있으면 안 된다.
- 한 항목 = 하나의 학력 / 경력(회사) / 프로젝트 / 대외활동 / 수상 / 자격증 / 어학 점수 / 교육 이수 / 기술 스택 묶음 / 자기소개 문단 등.
- 이력서와 포트폴리오에 같은 경험이 있으면 하나로 합치고 detail에 두 쪽 내용을 모두 반영한다.
- 날짜, 기간, 수치, 직함, 역할은 원문 그대로 적는다. 없는 내용을 추측해 채우지 마라.
- 이름·전화번호·이메일·주소는 제외한다. 사진, 생년월일/나이, 병역, 가족관계, 종교, 취미, 특기처럼 선택적으로 적는 개인 사항이 있으면 section을 "인적사항(선택)"으로 해서 포함한다.

모든 파일을 읽은 후 아래 JSON 형식으로만 응답해. 마크다운이나 설명 없이 순수 JSON만.

{
  "items": [
    {
      "section": "학력|경력|프로젝트|대외활동|수상|자격증|어학|교육|기술|자기소개|인적사항(선택)|기타",
      "title": "항목 제목 (예: 회사명 · 직함, 학교명 · 전공, 프로젝트명)",
      "period": "기간 또는 날짜 (없으면 빈 문자열)",
      "detail": "원문에 적힌 내용 (역할, 한 일, 성과 등)"
    }
  ]
}`;

  let resultText = "";
  for await (const message of query({
    prompt,
    inputFiles: pdfPaths,
    options: { model, maxTurns: 12, allowedTools: ["Read"] },
  })) {
    if (message.type === "result") {
      if (message.subtype !== "success" || message.is_error) throw new Error("이력서 항목 추출에 실패했습니다.");
      resultText = message.result;
    }
  }

  const parsed = extractJsonObject(resultText);
  const items: ResumeItem[] = (Array.isArray(parsed.items) ? parsed.items : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({
      section: typeof x.section === "string" ? x.section.trim() : "기타",
      title: typeof x.title === "string" ? x.title.trim() : "",
      period: typeof x.period === "string" ? x.period.trim() : "",
      detail: typeof x.detail === "string" ? x.detail.trim() : "",
    }))
    .filter((x) => x.title)
    .map((x, i) => ({ id: `r${i + 1}`, source: "resume" as const, ...x }));
  if (items.length === 0) throw new Error("이력서에서 항목을 찾지 못했습니다.");
  return { sourcesHash, generatedAt: Date.now(), model, items };
}

const state = globalThis as typeof globalThis & { findarInventoryInflight?: Map<string, Promise<ResumeInventory>> };
const inflight = (state.findarInventoryInflight ??= new Map<string, Promise<ResumeInventory>>());

// 이력서가 하나도 없으면 null — 평가는 "지원 정보" 항목만으로도 진행할 수 있다.
export async function ensureResumeInventory(): Promise<ResumeInventory | null> {
  const pdfs = listResumePdfs();
  if (pdfs.length === 0) return null;
  const hash = hashResumeSources(pdfs);
  const model = getAIModelId("resumeInventory");
  const key = JSON.stringify([hash, model]);
  const cached = readCached();
  if (cached?.sourcesHash === hash && cached.model === model) return cached;
  const running = inflight.get(key);
  if (running) return running;
  const task = extractInventory(pdfs, hash, model).then((inv) => {
    writeFileSync(INVENTORY_PATH, JSON.stringify(inv, null, 2));
    return inv;
  });
  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}

// AI 호출 없이, 현재 이력서·모델과 맞는 캐시가 있으면 돌려준다(경험 카드 상태 표시용).
export function getCachedResumeInventory(): ResumeInventory | null {
  const pdfs = listResumePdfs();
  if (!pdfs.length) return null;
  const cached = readCached();
  return cached?.sourcesHash === hashResumeSources(pdfs) && cached.model === getAIModelId("resumeInventory") ? cached : null;
}

// AI 호출 없이 현재 이력서 해시와 캐시가 맞는지만 본다(평가 결과의 "오래됨" 판정용).
export function currentResumeHash(): string {
  const pdfs = listResumePdfs();
  return pdfs.length ? hashResumeSources(pdfs) : "";
}
