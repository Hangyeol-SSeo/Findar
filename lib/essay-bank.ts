import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { createHash, randomUUID } from "crypto";
import { join } from "path";

// 과거에 실제로 썼던 자소서를 참고 자료로 축적하는 모듈. lib/profile.ts와 같은 이유로
// 원본 파일은 gitignore된 cover-letters/ 디렉터리에 두고, 에이전틱하게 읽어 구조화한다.
// resume/와 다른 점: 이 자료는 "이력서처럼 한 번 추출하고 끝"이 아니라, Findar에서 만든
// 초안을 사용자가 다듬어 확정할 때마다(appendEssayEntry) 계속 쌓여서 갈수록 더 좋은
// 참고 자료가 되도록 설계했다 — 사용자가 요청한 "피드백하며 발전 가능한 시스템"의 핵심.
const COVER_LETTER_DIR = join(process.cwd(), "cover-letters");
const DATA_DIR = join(process.cwd(), "data");
const ESSAY_BANK_PATH = join(DATA_DIR, "essay-bank.json");

mkdirSync(DATA_DIR, { recursive: true });

export interface EssayEntry {
  id: string;
  company: string; // 어느 회사에 낸(또는 낼) 답변인지 — 모르면 빈 문자열
  question: string; // 실제 문항 텍스트, 또는 COMMON_ESSAY_QUESTIONS 라벨
  answer: string;
  source: "imported" | "saved"; // 과거 파일에서 추출됐는지, 앱에서 다듬은 뒤 저장했는지
  createdAt: number;
}

export interface EssayBank {
  sourcesHash: string; // cover-letters/ 파일들의 해시 — 바뀌면 imported 항목만 재추출
  generatedAt: number;
  model: string;
  entries: EssayEntry[];
  styleNotes: string; // 문체/어조에 대한 AI 관찰 (초안 생성 시 톤 맞추는 데 사용)
  recurringThemes: string[]; // 반복적으로 등장하는 경험/에피소드 소재
}

function emptyEssayBank(): EssayBank {
  return {
    sourcesHash: "",
    generatedAt: 0,
    model: "",
    entries: [],
    styleNotes: "",
    recurringThemes: [],
  };
}

function listCoverLetterFiles(): string[] {
  if (!existsSync(COVER_LETTER_DIR)) return [];
  return readdirSync(COVER_LETTER_DIR)
    .filter((f) => /\.(pdf|txt|md)$/i.test(f))
    .map((f) => join(COVER_LETTER_DIR, f))
    .sort();
}

function hashSources(paths: string[]): string {
  const h = createHash("sha256");
  for (const p of paths) {
    const s = statSync(p);
    h.update(`${p}:${s.size}:${s.mtimeMs}\n`);
  }
  return h.digest("hex");
}

function readBank(): EssayBank {
  if (!existsSync(ESSAY_BANK_PATH)) return emptyEssayBank();
  try {
    return { ...emptyEssayBank(), ...JSON.parse(readFileSync(ESSAY_BANK_PATH, "utf-8")) };
  } catch {
    return emptyEssayBank();
  }
}

function writeBank(bank: EssayBank): void {
  writeFileSync(ESSAY_BANK_PATH, JSON.stringify(bank, null, 2));
}

const EXTRACT_MODEL = "claude-sonnet-4-6";

async function extractPastEssays(pdfPaths: string[]): Promise<{
  entries: Omit<EssayEntry, "id" | "source" | "createdAt">[];
  styleNotes: string;
  recurringThemes: string[];
}> {
  const fileList = pdfPaths.map((p) => `- ${p}`).join("\n");
  const prompt = `다음은 지원자가 과거에 실제로 제출했던 자기소개서 파일들이야. 전부 Read 도구로 읽고 분석해줘.

파일 목록:
${fileList}

모든 파일을 읽은 후, 아래 JSON 형식으로만 응답해. 마크다운이나 설명 없이 순수 JSON만.
{
  "entries": [
    {"company": "알 수 있으면 지원했던 회사명, 모르면 빈 문자열", "question": "문항(파일에 명시돼 있으면 그대로, 없으면 내용상 가장 가까운 주제로 요약)", "answer": "실제 작성된 답변 원문 (요약하지 말고 그대로)"}
  ],
  "styleNotes": "이 사람의 자소서 문체/어조에 대한 관찰 — 문장 길이, 자주 쓰는 표현, 구체성 수준, 논리 전개 방식 등을 2-3문장으로",
  "recurringThemes": ["여러 파일에 걸쳐 반복적으로 등장하는 경험/에피소드 소재 (예: 'OO 프로젝트 팀장 경험', '해외 교환학생 경험')"]
}

주의: answer는 요약하지 말고 원문 그대로 옮겨. 하나의 파일에 여러 문항이 있으면 entries에 각각 별도 항목으로 넣어.`;

  let resultText = "";
  for await (const message of query({
    prompt,
    options: { model: EXTRACT_MODEL, maxTurns: 10, allowedTools: ["Read"] },
  })) {
    if ("result" in message) resultText = message.result;
  }

  const jsonMatch =
    resultText.match(/```(?:json)?\s*([\s\S]*?)```/) || resultText.match(/(\{[\s\S]*\})/);
  const parsed = JSON.parse(jsonMatch?.[1]?.trim() || "{}");

  return {
    entries: Array.isArray(parsed.entries)
      ? parsed.entries.map((e: Record<string, unknown>) => ({
          company: typeof e.company === "string" ? e.company : "",
          question: typeof e.question === "string" ? e.question : "",
          answer: typeof e.answer === "string" ? e.answer : "",
        }))
      : [],
    styleNotes: typeof parsed.styleNotes === "string" ? parsed.styleNotes : "",
    recurringThemes: Array.isArray(parsed.recurringThemes) ? parsed.recurringThemes : [],
  };
}

// resume/profile과 같은 패턴: 파일이 안 바뀌었으면 캐시 그대로, 바뀌었으면 imported 항목만
// 새로 추출해서 교체한다. 사용자가 앱에서 저장한 "saved" 항목은 항상 그대로 보존.
export async function ensureEssayBank(opts?: {
  onProgress?: (msg: string) => void;
}): Promise<EssayBank> {
  const files = listCoverLetterFiles();
  const cached = readBank();
  if (files.length === 0) return cached;

  const currentHash = hashSources(files);
  if (cached.sourcesHash === currentHash) return cached;

  opts?.onProgress?.(`과거 자기소개서 ${files.length}개 분석 중...`);

  try {
    const extracted = await extractPastEssays(files);
    const importedEntries: EssayEntry[] = extracted.entries
      .filter((e) => e.answer)
      .map((e) => ({
        ...e,
        id: randomUUID(),
        source: "imported",
        createdAt: Date.now(),
      }));
    const savedEntries = cached.entries.filter((e) => e.source === "saved");
    const bank: EssayBank = {
      sourcesHash: currentHash,
      generatedAt: Date.now(),
      model: EXTRACT_MODEL,
      entries: [...importedEntries, ...savedEntries],
      styleNotes: extracted.styleNotes || cached.styleNotes,
      recurringThemes: extracted.recurringThemes.length
        ? extracted.recurringThemes
        : cached.recurringThemes,
    };
    writeBank(bank);
    return bank;
  } catch (e) {
    console.error("[essay-bank] 과거 자소서 추출 실패:", e);
    return cached;
  }
}

export function getCachedEssayBank(): EssayBank {
  return readBank();
}

// "지원 도우미" 탭에서 초안을 다듬어 확정한 뒤 저장할 때 호출 — 이렇게 쌓인 saved 항목이
// 다음 초안 생성부터 바로 참고 자료로 쓰인다 (사용자가 요청한 발전형 피드백 루프).
export function appendEssayEntry(company: string, question: string, answer: string): void {
  if (!answer.trim()) return;
  const bank = readBank();
  bank.entries.push({
    id: randomUUID(),
    company,
    question,
    answer,
    source: "saved",
    createdAt: Date.now(),
  });
  writeBank(bank);
}

// 프롬프트에 넣기 좋은 형태로 압축 — 전체를 다 넣으면 너무 기니 최근 것 위주로 일부만.
export function summarizeEssayBankForPrompt(bank: EssayBank, limit = 6): string {
  if (bank.entries.length === 0) return "";
  const recent = [...bank.entries].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  const lines = [
    bank.styleNotes && `문체 관찰: ${bank.styleNotes}`,
    bank.recurringThemes.length && `자주 쓰는 소재: ${bank.recurringThemes.join(", ")}`,
    "과거 작성 사례:",
    ...recent.map(
      (e) =>
        `- [${e.company || "회사 미상"}] ${e.question}\n  ${e.answer.slice(0, 300)}${e.answer.length > 300 ? "..." : ""}`
    ),
  ].filter(Boolean);
  return lines.join("\n");
}
