import { throwIfAIAborted } from "./ai-operation";
import { randomUUID } from "node:crypto";
import { requireApplicationRole } from "./application-role";
import { saveApplicationDraft } from "./db";
import { getCachedApplicationDraft, type ApplicationDraft } from "./application-draft";
import { recordEditSignals } from "./essay-bank";
import { changedPairs } from "./essay-diff";
import { logEssayEvent, logEssayEvents, type EssayEventInput } from "./essay-log";
import { locateInEssay } from "./essay-log-analysis";
import { parseEssayRequest, withVersion, type EssayAnswer, type EssaySuggestion } from "./essay-contract";

// 저장된 답변을 다루는 동작: 내 글 가져오기, 문단 다시 쓰기 결과 반영/버리기, 첨삭 제안 반영/넘기기, 버전 복원, 직접 수정.
// 모두 AI 호출 없이 저장된 결과만 다룬다. AI가 쓰고 고치는 일은 lib/essay-writer.ts가 한다.

export class EssayConflictError extends Error {}

function isUserAnswer(a: ApplicationDraft["essayAnswers"][number], question: string): a is EssayAnswer {
  return a.source === "user_question" && a.question === question;
}

export function findEssayAnswer(seq: string, question: string): EssayAnswer {
  const answer = getCachedApplicationDraft(seq)?.essayAnswers.find((a) => isUserAnswer(a, question));
  if (!answer) throw new Error("해당 문항의 답변을 찾을 수 없습니다.");
  return answer;
}

// 답변 하나를 읽고-고쳐-저장한다. 화면에서 온 요청은 expectedRevision으로 다른 창의 변경을 덮어쓰지 않는다.
export function updateEssayAnswer(seq: string, question: string, update: (answer: EssayAnswer) => EssayAnswer, expectedRevision?: string | null): ApplicationDraft {
  throwIfAIAborted();
  const draft = getCachedApplicationDraft(seq);
  const index = draft?.essayAnswers.findIndex((a) => isUserAnswer(a, question)) ?? -1;
  if (!draft || index < 0) throw new Error("해당 문항의 답변을 찾을 수 없습니다.");
  if (expectedRevision !== undefined && (draft.revision ?? null) !== expectedRevision)
    throw new EssayConflictError("다른 창에서 답변이 바뀌었습니다. 지원 도우미를 다시 열어주세요.");
  const next: ApplicationDraft = {
    ...draft, revision: randomUUID(),
    essayAnswers: draft.essayAnswers.map((a, i) => (i === index ? update(a as EssayAnswer) : a)),
  };
  saveApplicationDraft(seq, JSON.stringify(next), draft.model);
  return next;
}

// 내 글 가져오기: AI 없이 직접 쓴 답변을 문항에 저장한다. 같은 문항이 있으면 이전 글은 버전 기록에 남는다.
export function importEssay(seq: string, input: { question: unknown; maxChars?: unknown; countSpaces?: unknown; answer: unknown }, expectedRevision: string | null): ApplicationDraft {
  const request = parseEssayRequest({ question: input.question, maxChars: input.maxChars, countSpaces: input.countSpaces });
  if (typeof input.answer !== "string" || !input.answer.trim() || input.answer.length > 30000)
    throw new Error("가져올 답변을 1~30,000자로 입력해주세요.");
  const text = input.answer.trim();
  const selection = requireApplicationRole(seq);
  const draft = getCachedApplicationDraft(seq);
  if ((draft?.revision ?? null) !== expectedRevision)
    throw new EssayConflictError("다른 창에서 답변이 바뀌었습니다. 지원 도우미를 다시 열어주세요.");
  const previous = draft?.essayAnswers.find((a) => isUserAnswer(a, request.question));
  const now = Date.now();
  const imported: EssayAnswer = {
    ...request, guidance: previous?.guidance ?? "", answer: text,
    intent: "직접 작성한 답변입니다. 문단 다시 쓰기나 첨삭 받기로 다듬을 수 있습니다.",
    evidence: [], missingInfo: [], reviewNotes: [], status: "draft", source: "user_question", generatedAt: now,
    targetRole: selection.role, roleRevision: selection.revision, origin: "imported",
    versions: previous ? withVersion(previous, text, "user_import", "직접 쓴 글 가져오기")
      : [{ id: randomUUID(), answer: text, kind: "user_import", note: "", createdAt: now }],
  };
  const next: ApplicationDraft = {
    seq, personalFields: draft?.personalFields ?? [], notesForUser: draft?.notesForUser ?? [], outlines: draft?.outlines,
    essayAnswers: [...(draft?.essayAnswers ?? []).filter((a) => !isUserAnswer(a, request.question)), imported],
    model: draft?.model ?? "", generatedAt: draft?.generatedAt ?? now, revision: randomUUID(),
  };
  saveApplicationDraft(seq, JSON.stringify(next), next.model);
  logEssayEvent({ seq, question: request.question, type: "answer_imported", textBefore: previous?.answer || null, textAfter: text,
    detail: { maxChars: request.maxChars ?? null, replacedPrevious: !!previous } });
  return next;
}

function suggestionDetail(s: EssaySuggestion, text: string) {
  return { suggestionId: s.id, category: s.category, original: s.original, replacement: s.replacement, reason: s.reason, location: locateInEssay(text, s.original) };
}

export type EssayAnswerAction =
  | { action: "accept-revision" }
  | { action: "discard-revision" }
  | { action: "apply-suggestion"; suggestionId: string }
  | { action: "dismiss-suggestion"; suggestionId: string }
  | { action: "close-feedback" }
  | { action: "dismiss-needs-info" }
  | { action: "restore-version"; versionId: string };

// 화면의 즉시 처리 동작들. 모두 AI 호출 없이 저장된 결과만 다룬다.
export function applyEssayAnswerAction(seq: string, question: string, input: EssayAnswerAction, expectedRevision: string | null): ApplicationDraft {
  const signals: Parameters<typeof recordEditSignals>[0] = [];
  const events: EssayEventInput[] = [];
  const log = (event: Omit<EssayEventInput, "seq" | "question">) => events.push({ seq, question, ...event });
  const draft = updateEssayAnswer(seq, question, (answer) => {
    switch (input.action) {
      case "accept-revision": {
        const pending = answer.pendingRevision;
        if (!pending) throw new Error("반영할 수정본이 없습니다.");
        if (answer.answer !== pending.baseText)
          throw new Error("수정을 요청한 뒤 글이 바뀌어 비교 결과가 맞지 않습니다. 버리고 다시 요청해주세요.");
        signals.push(...changedPairs(pending.baseText, pending.answer).slice(0, 3).map((p) => ({ kind: "accepted" as const, category: "문단 다시 쓰기", ...p })));
        log({ type: "revision_accepted", threadId: pending.threadId, textBefore: pending.baseText, textAfter: pending.answer,
          detail: { instruction: pending.instruction, proposedAt: pending.createdAt } });
        return {
          ...answer, answer: pending.answer, evidence: pending.evidence, reviewNotes: pending.reviewNotes,
          status: "draft", missingInfo: [], evidenceStale: false, pendingRevision: undefined,
          versions: withVersion(answer, pending.answer, "ai_revision", pending.instruction.slice(0, 80)),
        };
      }
      case "discard-revision": {
        const pending = answer.pendingRevision;
        if (pending) log({ type: "revision_discarded", threadId: pending.threadId, textBefore: answer.answer, detail: {
          instruction: pending.instruction, proposedAnswer: pending.answer, changeSummary: pending.changeSummary, proposedAt: pending.createdAt,
        } });
        return { ...answer, pendingRevision: undefined };
      }
      case "apply-suggestion": {
        const suggestion = answer.feedback?.suggestions.find((s) => s.id === input.suggestionId && s.status === "pending");
        if (!suggestion || !answer.feedback) throw new Error("반영할 제안을 찾을 수 없습니다.");
        const at = answer.answer.indexOf(suggestion.original);
        if (at < 0) throw new Error("제안한 원문 구절이 이미 바뀌어 반영할 수 없습니다.");
        const before = answer.answer.slice(0, at);
        let after = answer.answer.slice(at + suggestion.original.length);
        // 구절을 지우면 앞뒤 공백이 겹치므로 하나만 남긴다.
        if (!suggestion.replacement && /\s$/.test(before) && /^\s/.test(after)) after = after.replace(/^\s+/, "");
        const text = before + suggestion.replacement + after;
        signals.push({ kind: "accepted", category: suggestion.category, before: suggestion.original, after: suggestion.replacement });
        log({ type: "suggestion_applied", threadId: answer.feedback.threadId, textBefore: answer.answer, textAfter: text, detail: suggestionDetail(suggestion, answer.answer) });
        return {
          ...answer, answer: text, evidenceStale: true,
          versions: withVersion(answer, text, "suggestion", suggestion.category),
          feedback: { ...answer.feedback, suggestions: answer.feedback.suggestions.map((s) => (s.id === suggestion.id ? { ...s, status: "applied" as const } : s)) },
        };
      }
      case "dismiss-suggestion": {
        const suggestion = answer.feedback?.suggestions.find((s) => s.id === input.suggestionId);
        if (!suggestion || !answer.feedback) throw new Error("제안을 찾을 수 없습니다.");
        signals.push({ kind: "rejected", category: suggestion.category, before: suggestion.original, after: suggestion.replacement });
        log({ type: "suggestion_dismissed", threadId: answer.feedback.threadId, detail: suggestionDetail(suggestion, answer.answer) });
        return { ...answer, feedback: { ...answer.feedback, suggestions: answer.feedback.suggestions.map((s) => (s.id === suggestion.id ? { ...s, status: "dismissed" as const } : s)) } };
      }
      case "close-feedback": {
        const feedback = answer.feedback;
        // 손대지 않고 닫은 제안도 "관심 없음"이라는 신호라 원문과 함께 남긴다.
        if (feedback) log({ type: "feedback_closed", threadId: feedback.threadId, detail: {
          applied: feedback.suggestions.filter((x) => x.status === "applied").length,
          dismissed: feedback.suggestions.filter((x) => x.status === "dismissed").length,
          untouched: feedback.suggestions.filter((x) => x.status === "pending").map((x) => suggestionDetail(x, answer.answer)),
        } });
        return { ...answer, feedback: undefined };
      }
      case "dismiss-needs-info":
        if (answer.revisionNeedsInfo) log({ type: "needs_info_dismissed", threadId: answer.revisionNeedsInfo.threadId,
          detail: { instruction: answer.revisionNeedsInfo.instruction, questions: answer.revisionNeedsInfo.questions } });
        return { ...answer, revisionNeedsInfo: undefined };
      case "restore-version": {
        const versions = answer.versions ?? [];
        const index = versions.findIndex((v) => v.id === input.versionId);
        if (index < 0) throw new Error("복원할 버전을 찾을 수 없습니다.");
        const text = versions[index].answer;
        log({ type: "version_restored", textBefore: answer.answer, textAfter: text, detail: {
          versionId: versions[index].id, versionNumber: index + 1, versionKind: versions[index].kind, versionNote: versions[index].note, versionCreatedAt: versions[index].createdAt,
        } });
        return {
          ...answer, answer: text, status: "draft", missingInfo: [], evidenceStale: true,
          versions: withVersion(answer, text, "restore", `${index + 1}번째 버전 복원`),
        };
      }
    }
  }, expectedRevision);
  recordEditSignals(signals);
  logEssayEvents(events);
  return draft;
}

// 직접 고친 답변을 저장할 때: 버전을 남기고, 바뀐 문장 쌍을 수정 성향 신호로, 전후 전문을 작성 기록으로 남긴다.
export function recordManualEdit(seq: string, previous: EssayAnswer, text: string): EssayAnswer {
  if (previous.answer === text) return previous;
  recordEditSignals(changedPairs(previous.answer, text).slice(0, 3).map((p) => ({ kind: "manual" as const, category: "", ...p })));
  logEssayEvent({ seq, question: previous.question, type: "manual_edit", textBefore: previous.answer, textAfter: text,
    detail: { fromVersionKind: previous.versions?.at(-1)?.kind ?? (previous.origin === "imported" ? "user_import" : "ai_draft") } });
  return { ...previous, answer: text, evidenceStale: true, versions: withVersion(previous, text, "user_edit") };
}
