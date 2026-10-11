export interface EssayRequest {
  question: string;
  maxChars?: number;
  countSpaces: boolean;
  guidance: string;
}

export interface EssayEvidence { sourceId: string; quote: string; usedFor: string }

// 한 문항 답변의 변천. versions의 마지막 항목이 현재 본문과 같다(새 버전을 쌓을 때마다 함께 맞춘다).
export type EssayVersionKind = "ai_draft" | "user_import" | "user_edit" | "ai_revision" | "suggestion" | "restore";
export interface EssayVersion { id: string; answer: string; kind: EssayVersionKind; note: string; createdAt: number }
export const MAX_ESSAY_VERSIONS = 10;

// 문단 다시 쓰기의 결과. 바로 적용하지 않고 사용자가 비교 화면에서 반영/버리기를 고른다.
export interface PendingRevision {
  instruction: string; baseText: string; answer: string; changeSummary: string[];
  evidence: EssayEvidence[]; reviewNotes: string[]; createdAt: number;
  threadId?: string; // 작성 기록(essay-log)에서 요청·결과·반영을 잇는 id
}
// 첨삭 B(첨삭 받기)의 결과. 제안은 원문 구절을 바꾸는 단순 치환이라 반영할 때 AI를 다시 부르지 않는다.
export interface EssaySuggestion {
  id: string; original: string; replacement: string; category: string; reason: string;
  status: "pending" | "applied" | "dismissed";
}
export interface EssayFeedback {
  focus: string; baseText: string; summary: string; strengths: string[]; issues: string[];
  suggestions: EssaySuggestion[]; createdAt: number;
  threadId?: string;
}

// 고쳐쓰기 요청이 자료에 없는 사실을 필요로 할 때 모델이 돌려준 질문. 오류가 아니라 사용자가 답할 보완 요청이다.
export interface RevisionNeedsInfo { instruction: string; questions: string[]; createdAt: number; threadId?: string }

// 작성 전 구성 확인 단계. AI가 문항마다 핵심 메시지·문단 구성·쓸 경험·회사 근거·확인 질문을 제안하고, 사용자가 고친 뒤
// 그 구성대로 작성한다. materials는 작성 자료 목록(essay-writer.ts listEssayMaterials)의 id다.
export interface OutlineParagraph { role: string; materials: string[]; note: string }
export interface OutlineQuestion { question: string; answer: string }
export interface EssayOutline extends EssayRequest {
  message: string;
  paragraphs: OutlineParagraph[];
  companyFacts: { text: string; use: boolean }[];
  questions: OutlineQuestion[];
  createdAt: number;
}

export interface EssayAnswer extends EssayRequest {
  answer: string;
  intent: string;
  evidence: EssayEvidence[];
  missingInfo: string[];
  reviewNotes: string[];
  status: "draft" | "needs_info";
  source: "user_question";
  generatedAt: number;
  targetRole?: string;
  roleRevision?: string;
  outline?: EssayOutline; // 이 답변을 쓸 때 확정한 구성
  origin?: "generated" | "imported";
  versions?: EssayVersion[];
  // 직접 수정·제안 반영·버전 복원 뒤에는 evidence가 현재 본문을 검토한 결과가 아니다.
  evidenceStale?: boolean;
  pendingRevision?: PendingRevision;
  feedback?: EssayFeedback;
  revisionNeedsInfo?: RevisionNeedsInfo;
}

// 기존 답변(versions 도입 전)도 현재 본문을 첫 버전으로 보고 이어서 쌓는다.
export function withVersion(answer: EssayAnswer, text: string, kind: EssayVersionKind, note = ""): EssayVersion[] {
  const versions = answer.versions?.length ? [...answer.versions]
    : answer.answer ? [{ id: crypto.randomUUID(), answer: answer.answer, kind: answer.origin === "imported" ? "user_import" as const : "ai_draft" as const, note: "", createdAt: answer.generatedAt }]
    : [];
  if (versions.at(-1)?.answer === text) return versions;
  return [...versions, { id: crypto.randomUUID(), answer: text, kind, note, createdAt: Date.now() }].slice(-MAX_ESSAY_VERSIONS);
}

// 반말 종결 검사. 인용한 말(따옴표 안)은 제외한다.
export function hasBanmalEnding(text: string): boolean {
  const narration = text.replace(/“[^”]*”|「[^」]*」|"[^"\n]*"/g, "");
  return /(?:한다|했다|된다|됐다|이다|였다|있다|없다|겠다|느꼈다|배웠다|깨달았다|이해했다|바꿨다|늘었다|복구했다)(?=[.!?。！？](?:\s|$)|\s*$)/m.test(narration);
}

export function containsForbiddenName(text: string, forbiddenNames: string[]): boolean {
  return forbiddenNames.some((name) => name && text.toLowerCase().includes(name.toLowerCase())) || /\[비공개[^\]]*\]/.test(text);
}

export function extractNumbers(text: string): string[] {
  return text.replace(/(\d),(?=\d)/g, "$1").match(/\d+(?:\.\d+)?/g) ?? [];
}
export interface EssaySource { id: string; text: string; links?: { title: string; url: string }[]; generatedAt?: number; status?: string; contentJson?: unknown }

export function characterCount(text: string, countSpaces = true): number {
  return Array.from(countSpaces ? text : text.replace(/\s/g, "")).length;
}

export function parseEssayRequest(value: unknown): EssayRequest {
  if (!value || typeof value !== "object") throw new Error("문항을 입력해주세요.");
  const v = value as Record<string, unknown>;
  if (typeof v.question !== "string" || !v.question.trim() || v.question.length > 8000)
    throw new Error("문항은 1~8,000자로 입력해주세요.");
  // An explicit limit wins; otherwise honor a limit included in the pasted question.
  const inferred = v.question.match(/([\d,]+)\s*자\s*(?:이내|이하|내외|제한)/);
  const maxChars = v.maxChars ?? (inferred ? Number(inferred[1].replaceAll(",", "")) : undefined);
  if (maxChars !== undefined && (!Number.isInteger(maxChars) || Number(maxChars) < 1 || Number(maxChars) > 10000))
    throw new Error("글자 수 제한은 1~10,000 사이의 정수로 입력해주세요.");
  if (v.guidance !== undefined && (typeof v.guidance !== "string" || v.guidance.length > 6000))
    throw new Error("추가 요청은 6,000자 이내로 입력해주세요.");
  return {
    question: v.question.trim(), maxChars: maxChars as number | undefined,
    countSpaces: typeof v.countSpaces === "boolean" ? v.countSpaces : !/공백\s*제외/.test(v.question),
    guidance: typeof v.guidance === "string" ? v.guidance.trim() : "",
  };
}

export class ModelJsonSyntaxError extends Error {
  constructor(cause: unknown) {
    super("AI 응답의 JSON 형식이 올바르지 않습니다. 문자열 안의 큰따옴표·줄바꿈을 이스케이프하고 쉼표와 괄호를 확인해주세요.", { cause });
    this.name = "ModelJsonSyntaxError";
  }
}

export function parseModelJson(text: string): Record<string, unknown> {
  const clean = text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  let value: unknown;
  try { value = JSON.parse(clean); }
  catch (error) { throw new ModelJsonSyntaxError(error); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("작성 결과 형식이 올바르지 않습니다.");
  return value as Record<string, unknown>;
}

// 빈 줄로 나뉜 문단(빈 줄이 없으면 줄 단위). 문단 다시 쓰기가 고칠 문단을 고르고, 다시 붙일 때 원래 구분을 쓴다.
export function splitParagraphs(text: string): { paragraphs: string[]; separator: string } {
  const blank = /\n\s*\n/.test(text);
  return { paragraphs: text.split(blank ? /\n\s*\n/ : /\n/).map((p) => p.trim()).filter(Boolean), separator: blank ? "\n\n" : "\n" };
}

export const FIT_LENGTH_REQUEST = "글자 수 제한에 맞게 줄여주세요. 핵심 경험과 주장은 남기고 덜 중요한 문장부터 덜어내주세요.";
