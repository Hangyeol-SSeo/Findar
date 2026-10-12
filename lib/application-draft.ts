import { getApplicationDraftRow } from "./db";
import type { EssayAnswer } from "./essay-contract";
export type { EssayAnswer } from "./essay-contract";

// 공고별 자기소개서 저장소. 글은 대화 세션에서 쓰고, 여기에는 저장·직접 수정·버전·첨삭 결과만 둔다.
// 저장·수정·버전·최종본은 lib/essay-revision.ts, 첨삭 받기는 lib/essay-review.ts가 다룬다.
export interface ApplicationDraft {
  seq: string;
  essayAnswers: (EssayAnswer | { question: string; answer: string; source?: undefined })[];
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
