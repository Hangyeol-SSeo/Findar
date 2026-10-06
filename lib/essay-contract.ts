import type { EssayPlan } from "./essay-plan";

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

// 첨삭 A(요청대로 고쳐쓰기)의 결과. 바로 적용하지 않고 사용자가 비교 화면에서 반영/버리기를 고른다.
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

// 버튼을 눌렀을 때만 도는 업계 사례 조사. 후보 찾기(scoped) → 사용자가 자료와 구성 방향 선택 → 자료 정리(collected)
// → 그 자료로 고쳐쓰기의 단계를 거쳐, 조사 중간에 사용자가 방향을 정할 수 있다.
export interface ResearchCandidate { id: string; title: string; url: string; summary: string; publisher: string; date: string }
export interface ResearchFinding { id: string; title: string; url: string; fact: string; quote: string; date: string }
export interface IndustryResearch {
  instruction: string; topic: string; stage: "scoped" | "collected";
  directionQuestions: string[]; candidates: ResearchCandidate[];
  direction: string; selectedIds: string[]; findings: ResearchFinding[];
  notes: string[]; createdAt: number; updatedAt: number;
  threadId?: string;
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
  plan?: EssayPlan;
  researchSources?: EssaySource[];
  origin?: "generated" | "imported";
  versions?: EssayVersion[];
  // 직접 수정·제안 반영·버전 복원 뒤에는 evidence가 현재 본문을 검토한 결과가 아니다.
  evidenceStale?: boolean;
  pendingRevision?: PendingRevision;
  feedback?: EssayFeedback;
  revisionNeedsInfo?: RevisionNeedsInfo;
  industryResearch?: IndustryResearch;
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

export function parseModelJson(text: string): Record<string, unknown> {
  const clean = text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  const value = JSON.parse(clean);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("작성 결과 형식이 올바르지 않습니다.");
  return value;
}

export function validateEssay(
  value: Record<string, unknown>, request: EssayRequest, sources: EssaySource[], forbiddenNames: string[], allowReasoningOnly = false
): EssayAnswer {
  for (const key of ["answer", "intent"])
    if (typeof value[key] !== "string") throw new Error("작성 결과에 본문 또는 문항 해석이 없습니다.");
  const strings = (key: string): string[] => {
    if (!Array.isArray(value[key]) || !(value[key] as unknown[]).every((x) => typeof x === "string"))
      throw new Error("작성 결과의 검토 정보가 올바르지 않습니다.");
    return value[key] as string[];
  };
  const answer = (value.answer as string).trim();
  const missingInfo = strings("missingInfo");
  const reviewNotes = strings("reviewNotes");
  if (value.status !== "draft" && value.status !== "needs_info") throw new Error("작성 상태가 올바르지 않습니다.");
  if (!Array.isArray(value.evidence)) throw new Error("답변의 근거가 없습니다.");
  const evidence: EssayEvidence[] = value.evidence.map((item: unknown) => {
    const e = item as EssayEvidence;
    const source = e && sources.find((s) => s.id === e.sourceId);
    if (!source || typeof e.quote !== "string" || !e.quote.trim() || !source.text.includes(e.quote) || typeof e.usedFor !== "string")
      throw new Error("답변 근거가 저장된 원문과 일치하지 않습니다.");
    return { sourceId: e.sourceId, quote: e.quote, usedFor: e.usedFor };
  });
  if (value.status === "needs_info") {
    if (!missingInfo.length) throw new Error("보완할 경험을 확인하지 못했습니다.");
    return { ...request, answer: "", intent: value.intent as string, evidence, missingInfo, reviewNotes, status: "needs_info", source: "user_question", generatedAt: Date.now() };
  }
  if (!answer || (!evidence.length && !allowReasoningOnly)) throw new Error("근거 없는 답변은 저장하지 않습니다.");
  if (hasBanmalEnding(answer))
    throw new Error("답변에 반말 종결이 포함되어 있습니다. 모든 서술 문장을 존댓말로 다시 작성해주세요.");
  if (request.maxChars && characterCount(answer, request.countSpaces) > request.maxChars)
    throw new Error("답변이 글자 수 제한을 초과했습니다.");
  if (containsForbiddenName(answer, forbiddenNames))
    throw new Error("답변에 제외 대상 고유명사가 포함되어 있습니다.");
  // A numeric claim must occur in the quoted evidence. Semantic equivalence is checked by the editor.
  const supported = new Set(evidence.flatMap((e) => extractNumbers(e.quote)));
  if (extractNumbers(answer).some((n) => !supported.has(n))) throw new Error("근거에서 확인되지 않는 수치가 포함되어 있습니다.");
  return { ...request, answer, intent: value.intent as string, evidence, missingInfo, reviewNotes, status: "draft", source: "user_question", generatedAt: Date.now() };
}
