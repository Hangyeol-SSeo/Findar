export interface EssayRequest {
  question: string;
  maxChars?: number;
  countSpaces: boolean;
  guidance: string;
}

export interface EssayEvidence { sourceId: string; quote: string; usedFor: string }
export interface EssayAnswer extends EssayRequest {
  answer: string;
  intent: string;
  evidence: EssayEvidence[];
  missingInfo: string[];
  reviewNotes: string[];
  status: "draft" | "needs_info";
  source: "user_question";
  generatedAt: number;
}
export interface EssaySource { id: string; text: string }

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
  value: Record<string, unknown>, request: EssayRequest, sources: EssaySource[], forbiddenNames: string[]
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
  if (!answer || !evidence.length) throw new Error("근거 없는 답변은 저장하지 않습니다.");
  if (request.maxChars && characterCount(answer, request.countSpaces) > request.maxChars)
    throw new Error("답변이 글자 수 제한을 초과했습니다.");
  if (forbiddenNames.some((name) => name && answer.toLowerCase().includes(name.toLowerCase())) || /\[비공개[^\]]*\]/.test(answer))
    throw new Error("답변에 제외 대상 고유명사가 포함되어 있습니다.");
  // A numeric claim must occur in the quoted evidence. Semantic equivalence is checked by the editor.
  const numbers = (s: string) => s.replace(/(\d),(?=\d)/g, "$1").match(/\d+(?:\.\d+)?/g) ?? [];
  const supported = new Set(evidence.flatMap((e) => numbers(e.quote)));
  if (numbers(answer).some((n) => !supported.has(n))) throw new Error("근거에서 확인되지 않는 수치가 포함되어 있습니다.");
  return { ...request, answer, intent: value.intent as string, evidence, missingInfo, reviewNotes, status: "draft", source: "user_question", generatedAt: Date.now() };
}
