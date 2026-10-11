import { throwIfAIAborted } from "./ai-operation";
import { assertApplicationRole } from "./application-role";
import { getApplicationDraftRow, saveApplicationDraft } from "./db";
import { withVersion, type EssayAnswer, type EssayOutline } from "./essay-contract";
import { logEssayEvent } from "./essay-log";
export type { EssayAnswer } from "./essay-contract";

// 공고별 자기소개서 저장소. 작성·문단 다시 쓰기·첨삭 받기는 lib/essay-writer.ts가, 첨삭 결과 반영·버전·직접 수정은
// lib/essay-revision.ts가 다룬다.
export interface ApplicationDraft {
  seq: string;
  essayAnswers: (EssayAnswer | { question: string; answer: string; source?: undefined })[];
  // 작성 전 구성 확인 단계에서 AI가 제안했고 아직 작성하지 않은 구성. 작성하면 그 문항의 답변 outline으로 옮겨진다.
  outlines?: EssayOutline[];
  personalFields: { label: string; value: string }[]; // Preserve old records; no longer generated or shown.
  notesForUser: string[];
  model: string;
  generatedAt: number;
  revision?: string;
}

export function getCachedApplicationDraft(seq: string): ApplicationDraft | null {
  const row = getApplicationDraftRow(seq);
  if (!row) return null;
  try { return JSON.parse(row.draftJson) as ApplicationDraft; } catch { return null; }
}

function emptyDraft(seq: string, model: string): ApplicationDraft {
  return { seq, essayAnswers: [], personalFields: [], notesForUser: [], model, generatedAt: Date.now() };
}

// 읽고-고쳐-저장한다. 매번 revision을 바꿔 화면의 충돌 검사(다른 창에서 바뀐 답변)가 동작하게 한다.
export function updateApplicationDraft(seq: string, model: string, update: (draft: ApplicationDraft) => ApplicationDraft): ApplicationDraft {
  throwIfAIAborted();
  const next = { ...update(getCachedApplicationDraft(seq) ?? emptyDraft(seq, model)), revision: crypto.randomUUID() };
  saveApplicationDraft(seq, JSON.stringify(next), next.model || model);
  return next;
}

// 작성한 답변을 문항에 저장한다. 같은 문항의 이전 글은 버전 기록에 남고, 그 문항의 남은 구성 제안은 지운다.
export function persistEssay(seq: string, generated: EssayAnswer, model: string, threadId?: string): ApplicationDraft {
  throwIfAIAborted();
  if (generated.roleRevision !== undefined) assertApplicationRole(seq, generated.roleRevision);
  let previous: EssayAnswer | undefined;
  const draft = updateApplicationDraft(seq, model, (current) => {
    previous = current.essayAnswers.find((a): a is EssayAnswer => a.source === "user_question" && a.question === generated.question);
    const versions = previous ? (generated.answer ? withVersion(previous, generated.answer, "ai_draft", "새로 쓰기") : previous.versions)
      : generated.answer ? withVersion(generated, generated.answer, "ai_draft") : undefined;
    const answer: EssayAnswer = { ...generated, origin: "generated", versions };
    return {
      ...current, model, generatedAt: Date.now(),
      essayAnswers: [...current.essayAnswers.filter((a) => !(a.source === "user_question" && a.question === answer.question)), answer],
      outlines: (current.outlines ?? []).filter((o) => o.question !== answer.question),
    };
  });
  // 새로 쓰기는 이전 답변의 열린 첨삭 결과·수정본을 함께 대체하므로, 무엇이 사라졌는지도 남긴다.
  logEssayEvent({ seq, question: generated.question, type: "draft_generated", threadId, textBefore: previous?.answer || null, textAfter: generated.answer || null, detail: {
    status: generated.status, model, guidance: generated.guidance, maxChars: generated.maxChars ?? null, intent: generated.intent,
    missingInfo: generated.missingInfo, reviewNotes: generated.reviewNotes,
    ...(generated.outline ? { outline: { message: generated.outline.message, paragraphs: generated.outline.paragraphs } } : {}),
    ...(previous?.pendingRevision ? { replacedPendingRevision: previous.pendingRevision.instruction } : {}),
    ...(previous?.feedback ? { replacedFeedback: previous.feedback.suggestions.filter((x) => x.status === "pending").length } : {}),
  } });
  return draft;
}
