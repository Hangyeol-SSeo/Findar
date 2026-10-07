import { randomUUID } from "node:crypto";
import { hasEssayEvents, insertEssayEvents, listApplicationDraftRows, listEssayEventRows, type EssayEventFilter, type EssayEventRow } from "./db";
import { analyzeEssayChange, ESSAY_EVENT_ACTORS, summarizeEssayEvents, type EssayEvent, type EssayEventType } from "./essay-log-analysis";
import type { EssayAnswer, EssayVersionKind } from "./essay-contract";
import { inspectEssayStyle } from "./essay-style";

export type { EssayEvent, EssayEventType } from "./essay-log-analysis";

// 자기소개서 작성 기록. 작성 요청, AI 초안, 직접 수정, 고쳐쓰기 요청과 결과(반영/버림), 첨삭 피드백과 제안별 반영/넘김,
// 버전 복원, 업계 조사를 모두 추가 전용으로 essay_events에 남긴다. 글이 바뀐 사건에는 전후 전문과
// analyzeEssayChange의 해석(바뀐 위치·성격·문체 문제 변화)을 함께 저장한다.
// 기록은 부가 기능이라 실패해도 본 작업(저장·첨삭)을 막지 않는다.

export interface EssayEventInput {
  seq: string;
  question: string;
  type: EssayEventType;
  threadId?: string | null;
  textBefore?: string | null;
  textAfter?: string | null;
  detail?: Record<string, unknown>;
  createdAt?: number;
}

function toRow(input: EssayEventInput): EssayEventRow {
  const textBefore = input.textBefore ?? null;
  const textAfter = input.textAfter ?? null;
  const analysis = textAfter !== null ? analyzeEssayChange(textBefore ?? "", textAfter) : null;
  const detail = { ...input.detail };
  // 글은 바뀌지 않았지만 특정 본문을 두고 일어난 사건(첨삭 받기 등)은 그 시점의 문체 점검 결과를 남긴다.
  if (textAfter === null && textBefore) detail.styleIssues ??= inspectEssayStyle(textBefore).map((i) => i.code);
  return {
    id: randomUUID(), seq: input.seq, question: input.question, type: input.type, actor: ESSAY_EVENT_ACTORS[input.type],
    threadId: input.threadId ?? null, textBefore, textAfter,
    detail: JSON.stringify(detail), analysis: analysis ? JSON.stringify(analysis) : null,
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function logEssayEvents(inputs: EssayEventInput[]): void {
  try { insertEssayEvents(inputs.map(toRow)); }
  catch (error) { console.error("[essay-log] 기록하지 못했습니다:", error); }
}

export function logEssayEvent(input: EssayEventInput): void {
  logEssayEvents([input]);
}

export const newEssayThread = () => randomUUID();

function fromRow(row: EssayEventRow): EssayEvent {
  const parse = <T>(text: string | null, fallback: T): T => { try { return text ? JSON.parse(text) as T : fallback; } catch { return fallback; } };
  return { ...row, type: row.type as EssayEventType, actor: row.actor as EssayEvent["actor"], detail: parse(row.detail, {}), analysis: parse(row.analysis, null) };
}

export function listEssayEvents(filter: EssayEventFilter = {}): EssayEvent[] {
  return listEssayEventRows(filter).map(fromRow);
}

export function getEssayLogSummary(filter: Omit<EssayEventFilter, "limit"> = {}) {
  return summarizeEssayEvents(listEssayEvents(filter));
}

// ---- 기록 도입 전 데이터 가져오기 ----
// 기록이 생기기 전의 답변도 versions(문항당 최근 10개)와 지금 열려 있는 첨삭 결과로 과정을 되살린다.
// 이미 기록이 있는 문항은 건너뛰므로 몇 번 실행돼도 중복되지 않는다.
const VERSION_EVENT: Record<EssayVersionKind, EssayEventType> = {
  ai_draft: "draft_generated", user_import: "answer_imported", user_edit: "manual_edit",
  ai_revision: "revision_accepted", suggestion: "suggestion_applied", restore: "version_restored",
};

export function backfillEssayLog(): number {
  let count = 0;
  for (const row of listApplicationDraftRows()) {
    let draft: { essayAnswers?: EssayAnswer[] };
    try { draft = JSON.parse(row.draftJson); } catch { continue; }
    for (const answer of draft.essayAnswers ?? []) {
      if (answer.source !== "user_question" || hasEssayEvents(row.seq, answer.question)) continue;
      const inputs: EssayEventInput[] = [];
      const versions = answer.versions?.length ? answer.versions
        : answer.answer ? [{ id: "", answer: answer.answer, kind: (answer.origin === "imported" ? "user_import" : "ai_draft") as EssayVersionKind, note: "", createdAt: answer.generatedAt }]
        : [];
      let previous: string | null = null;
      versions.forEach((v, i) => {
        inputs.push({
          seq: row.seq, question: answer.question, type: VERSION_EVENT[v.kind], textBefore: previous, textAfter: v.answer, createdAt: v.createdAt,
          detail: { backfilled: true, versionId: v.id, note: v.note, ...(i === 0 && answer.versions && answer.versions.length >= 10 ? { olderVersionsDropped: true } : {}),
            ...(v.kind === "ai_revision" ? { instruction: v.note } : {}), ...(v.kind === "suggestion" ? { category: v.note } : {}) },
        });
        previous = v.answer;
      });
      const pending = answer.pendingRevision;
      if (pending) {
        const threadId = newEssayThread();
        inputs.push(
          { seq: row.seq, question: answer.question, type: "revision_requested", threadId, textBefore: pending.baseText, createdAt: pending.createdAt - 1, detail: { backfilled: true, instruction: pending.instruction } },
          { seq: row.seq, question: answer.question, type: "revision_proposed", threadId, textBefore: pending.baseText, textAfter: pending.answer, createdAt: pending.createdAt,
            detail: { backfilled: true, changeSummary: pending.changeSummary, reviewNotes: pending.reviewNotes } },
        );
      }
      const feedback = answer.feedback;
      if (feedback) {
        const threadId = newEssayThread();
        inputs.push(
          { seq: row.seq, question: answer.question, type: "review_requested", threadId, textBefore: feedback.baseText, createdAt: feedback.createdAt - 1, detail: { backfilled: true, focus: feedback.focus } },
          { seq: row.seq, question: answer.question, type: "review_received", threadId, textBefore: feedback.baseText, createdAt: feedback.createdAt,
            detail: { backfilled: true, summary: feedback.summary, strengths: feedback.strengths, issues: feedback.issues, suggestions: feedback.suggestions } },
        );
        // 넘긴 제안은 시각이 남아 있지 않아 받은 시점 직후로 둔다(반영한 제안은 위 versions에 이미 있다).
        for (const s of feedback.suggestions.filter((x) => x.status === "dismissed"))
          inputs.push({ seq: row.seq, question: answer.question, type: "suggestion_dismissed", threadId, createdAt: feedback.createdAt + 1,
            detail: { backfilled: true, suggestionId: s.id, category: s.category, original: s.original, replacement: s.replacement, reason: s.reason } });
      }
      if (answer.revisionNeedsInfo)
        inputs.push({ seq: row.seq, question: answer.question, type: "revision_needs_info", createdAt: answer.revisionNeedsInfo.createdAt,
          detail: { backfilled: true, instruction: answer.revisionNeedsInfo.instruction, questions: answer.revisionNeedsInfo.questions } });
      logEssayEvents(inputs);
      count += inputs.length;
    }
  }
  return count;
}

// 모듈을 처음 불러올 때(=어떤 기록이 쓰이기 전) 한 번 실행한다.
const state = globalThis as typeof globalThis & { findarEssayLogBackfilled?: boolean };
if (!state.findarEssayLogBackfilled) {
  state.findarEssayLogBackfilled = true;
  try {
    const n = backfillEssayLog();
    if (n) console.log(`[essay-log] 기존 답변 기록 ${n}건을 가져왔습니다.`);
  } catch (error) { console.error("[essay-log] 기존 답변 기록을 가져오지 못했습니다:", error); }
}
