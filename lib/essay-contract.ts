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

// 예전 문단 다시 쓰기의 결과. 이제 만들지 않지만, 저장된 답변에 남아 있으면 작성 기록 보충(essay-log)이 읽는다.
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

// 예전 고쳐쓰기의 보완 질문. PendingRevision과 같은 이유로 타입만 남긴다.
export interface RevisionNeedsInfo { instruction: string; questions: string[]; createdAt: number; threadId?: string }

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
  origin?: "generated" | "imported";
  versions?: EssayVersion[];
  // 직접 수정·제안 반영·버전 복원 뒤에는 evidence가 현재 본문을 검토한 결과가 아니다.
  evidenceStale?: boolean;
  feedback?: EssayFeedback;
  pendingRevision?: PendingRevision; // 예전 기능의 기록(새로 만들지 않음)
  revisionNeedsInfo?: RevisionNeedsInfo; // 예전 기능의 기록(새로 만들지 않음)
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
