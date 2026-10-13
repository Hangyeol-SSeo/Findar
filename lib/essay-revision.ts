import { throwIfAIAborted } from "./ai-operation";
import { randomUUID } from "node:crypto";
import { getApplicationRole, getJobBySeq, saveApplicationDraft } from "./db";
import { getCachedApplicationDraft, type ApplicationDraft } from "./application-draft";
import { listFinalEssays, recordEditSignals, saveFinalEssay } from "./essay-bank";
import { changedPairs } from "./essay-diff";
import { logEssayEvent, logEssayEvents, type EssayEventInput } from "./essay-log";
import { locateInEssay } from "./essay-log-analysis";
import { parseEssayRequest, withVersion, type EssayAnswer, type EssayRequest, type EssaySuggestion } from "./essay-contract";

// 저장된 답변을 다루는 동작: 자기소개서 저장, 직접 수정, 첨삭 제안 반영/넘기기, 버전 복원, 문항 순서 변경, 최종본 저장.
// 모두 AI 호출 없이 저장된 결과만 다룬다. 글은 대화 세션에서 쓰고, AI 첨삭은 lib/essay-review.ts가 한다.

// 본문이 바뀔 때마다 도는 점검(lib/essay-review.ts checkEssay). 결과는 검토 메모로 바꿔 넣는다 — 늘 지금 글을 본 결과다.
export type EssayCheck = (text: string, request: Pick<EssayRequest, "maxChars" | "countSpaces">) => string[];

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

// 자기소개서 저장: 대화 세션 등에서 쓴 답변을 문항에 저장한다. 같은 문항이 있으면 그 자리에서 바뀌고 이전 글은 버전 기록에 남는다.
export function importEssay(seq: string, input: { question: unknown; maxChars?: unknown; countSpaces?: unknown; answer: unknown }, expectedRevision: string | null, check?: EssayCheck): ApplicationDraft {
  const request = parseEssayRequest({ question: input.question, maxChars: input.maxChars, countSpaces: input.countSpaces });
  if (typeof input.answer !== "string" || !input.answer.trim() || input.answer.length > 30000)
    throw new Error("가져올 답변을 1~30,000자로 입력해주세요.");
  const text = input.answer.trim();
  // 지원 직무를 고르기 전에도 저장할 수 있다. 고른 직무가 있으면 최종본 자료에 함께 남긴다.
  const selection = getApplicationRole(seq);
  const draft = getCachedApplicationDraft(seq);
  if ((draft?.revision ?? null) !== expectedRevision)
    throw new EssayConflictError("다른 창에서 답변이 바뀌었습니다. 지원 도우미를 다시 열어주세요.");
  const previous = draft?.essayAnswers.find((a) => isUserAnswer(a, request.question));
  const now = Date.now();
  const imported: EssayAnswer = {
    ...request, guidance: previous?.guidance ?? "", answer: text, intent: "",
    evidence: [], missingInfo: [], reviewNotes: check?.(text, request) ?? [], status: "draft", source: "user_question", generatedAt: now,
    targetRole: selection.role || undefined, roleRevision: selection.revision || undefined, origin: "imported",
    versions: previous ? withVersion(previous, text, "user_import", "직접 쓴 글 가져오기")
      : [{ id: randomUUID(), answer: text, kind: "user_import", note: "", createdAt: now }],
  };
  const next: ApplicationDraft = {
    seq, personalFields: draft?.personalFields ?? [], notesForUser: draft?.notesForUser ?? [],
    essayAnswers: previous ? (draft?.essayAnswers ?? []).map((a) => (a === previous ? imported : a)) : [...(draft?.essayAnswers ?? []), imported],
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
  | { action: "apply-suggestion"; suggestionId: string }
  | { action: "dismiss-suggestion"; suggestionId: string }
  | { action: "close-feedback" }
  | { action: "restore-version"; versionId: string }
  | { action: "move"; direction: "up" | "down" };

// 문항 순서 바꾸기: 바로 위/아래 문항과 자리를 바꾼다. 이전 방식 공통 답변은 제자리에 둔다.
function moveEssayAnswer(seq: string, question: string, direction: "up" | "down", expectedRevision: string | null): ApplicationDraft {
  const draft = getCachedApplicationDraft(seq);
  if (!draft) throw new Error("해당 문항의 답변을 찾을 수 없습니다.");
  if ((draft.revision ?? null) !== expectedRevision)
    throw new EssayConflictError("다른 창에서 답변이 바뀌었습니다. 지원 도우미를 다시 열어주세요.");
  const slots = draft.essayAnswers.flatMap((a, i) => (a.source === "user_question" ? [i] : []));
  const from = slots.findIndex((i) => isUserAnswer(draft.essayAnswers[i], question));
  if (from < 0) throw new Error("해당 문항의 답변을 찾을 수 없습니다.");
  const to = direction === "up" ? from - 1 : from + 1;
  if (to < 0 || to >= slots.length) throw new Error(direction === "up" ? "이미 첫 번째 문항입니다." : "이미 마지막 문항입니다.");
  const essayAnswers = [...draft.essayAnswers];
  [essayAnswers[slots[from]], essayAnswers[slots[to]]] = [essayAnswers[slots[to]], essayAnswers[slots[from]]];
  const next: ApplicationDraft = { ...draft, revision: randomUUID(), essayAnswers };
  saveApplicationDraft(seq, JSON.stringify(next), draft.model);
  logEssayEvent({ seq, question, type: "answer_moved", detail: { direction, from: from + 1, to: to + 1, total: slots.length } });
  return next;
}

// 화면의 즉시 처리 동작들. 모두 AI 호출 없이 저장된 결과만 다룬다.
export function applyEssayAnswerAction(seq: string, question: string, input: EssayAnswerAction, expectedRevision: string | null, check?: EssayCheck): ApplicationDraft {
  if (input.action === "move") return moveEssayAnswer(seq, question, input.direction, expectedRevision);
  const signals: Parameters<typeof recordEditSignals>[0] = [];
  const events: EssayEventInput[] = [];
  const log = (event: Omit<EssayEventInput, "seq" | "question">) => events.push({ seq, question, ...event });
  const notes = (answer: EssayAnswer, text: string) => checkedNotes(answer, text, check);
  const draft = updateEssayAnswer(seq, question, (answer) => {
    switch (input.action) {
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
          ...answer, answer: text, ...notes(answer, text),
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
      case "restore-version": {
        const versions = answer.versions ?? [];
        const index = versions.findIndex((v) => v.id === input.versionId);
        if (index < 0) throw new Error("복원할 버전을 찾을 수 없습니다.");
        const text = versions[index].answer;
        log({ type: "version_restored", textBefore: answer.answer, textAfter: text, detail: {
          versionId: versions[index].id, versionNumber: index + 1, versionKind: versions[index].kind, versionNote: versions[index].note, versionCreatedAt: versions[index].createdAt,
        } });
        return {
          ...answer, answer: text, status: "draft", missingInfo: [], ...notes(answer, text),
          versions: withVersion(answer, text, "restore", `${index + 1}번째 버전 복원`),
        };
      }
      default:
        throw new Error("지원하지 않는 동작입니다.");
    }
  }, expectedRevision);
  recordEditSignals(signals);
  logEssayEvents(events);
  return draft;
}

// 직접 고친 답변을 저장할 때: 버전을 남기고, 바뀐 문장 쌍을 수정 성향 신호로, 전후 전문을 작성 기록으로 남긴다.
export function recordManualEdit(seq: string, previous: EssayAnswer, text: string, check?: EssayCheck): EssayAnswer {
  if (previous.answer === text) return previous;
  recordEditSignals(changedPairs(previous.answer, text).slice(0, 3).map((p) => ({ kind: "manual" as const, category: "", ...p })));
  logEssayEvent({ seq, question: previous.question, type: "manual_edit", textBefore: previous.answer, textAfter: text,
    detail: { fromVersionKind: previous.versions?.at(-1)?.kind ?? (previous.origin === "imported" ? "user_import" : "ai_draft") } });
  return { ...previous, answer: text, ...checkedNotes(previous, text, check), versions: withVersion(previous, text, "user_edit") };
}

// 점검이 있으면 검토 메모를 지금 글의 점검 결과로 바꾸고, 없으면 예전 메모가 지난 글의 것임을 표시한다.
function checkedNotes(answer: EssayAnswer, text: string, check?: EssayCheck): Pick<EssayAnswer, "reviewNotes" | "evidenceStale"> {
  return check ? { reviewNotes: check(text, answer), evidenceStale: false } : { reviewNotes: answer.reviewNotes, evidenceStale: true };
}

// 최종본으로 저장: 지금 저장된 본문을 과거 자소서 자료(data/essay-bank.json)에 바로 넣는다. 파일로 다시 올릴 필요가 없다.
// 같은 공고·문항은 하나만 남기고 새 글로 바꾼다. 화면의 고친 내용은 먼저 저장한 뒤 부른다(expectedRevision으로 확인).
export function saveFinalAnswer(seq: string, question: string, expectedRevision: string | null) {
  const draft = getCachedApplicationDraft(seq);
  if ((draft?.revision ?? null) !== expectedRevision)
    throw new EssayConflictError("다른 창에서 답변이 바뀌었습니다. 지원 도우미를 다시 열어주세요.");
  const answer = findEssayAnswer(seq, question);
  if (!answer.answer.trim()) throw new Error("저장할 본문이 없습니다.");
  const role = answer.targetRole || getApplicationRole(seq).role;
  const entry = saveFinalEssay({ seq, company: getJobBySeq(seq)?.company ?? "", role, question, answer: answer.answer });
  logEssayEvent({ seq, question, type: "saved_to_bank", textBefore: answer.answer, detail: { company: entry.company, role, entryId: entry.id } });
  return entry;
}

// 이 공고에서 최종본으로 저장한 답변(화면의 "최종본 저장됨" 표시용).
export function finalSummaries(seq: string) {
  return listFinalEssays(seq).map((e) => ({ question: e.question, answer: e.answer, savedAt: e.createdAt }));
}
