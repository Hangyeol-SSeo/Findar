"use client";

import { useState } from "react";
import { characterCount, type EssayAnswer, type EssayVersionKind } from "@/lib/essay-contract";

const inputStyle = "w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200";
const primaryButton = "rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-700 active:scale-95 disabled:pointer-events-none disabled:opacity-40";
const secondaryButton = "rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 transition hover:bg-gray-50 active:scale-95 disabled:pointer-events-none disabled:opacity-40";

const VERSION_LABELS: Record<EssayVersionKind, string> = {
  ai_draft: "AI 초안", user_import: "직접 쓴 글", user_edit: "직접 수정", ai_revision: "다시 쓰기 반영", suggestion: "첨삭 제안 반영", restore: "버전 복원",
};

export type AnswerAction =
  | { action: "close-feedback" }
  | { action: "apply-suggestion" | "dismiss-suggestion"; suggestionId: string }
  | { action: "restore-version"; versionId: string };

// 답변 카드 하나의 첨삭 도구: 첨삭 받기, 제안 반영/넘기기, 버전 기록. 글을 다시 쓰는 일은 대화 세션에서 한다.
export function EssayReviewTools({ answer, disabled, reviewing, error, highlight, onReview, onAction }: {
  answer: EssayAnswer;
  disabled: boolean;
  reviewing: boolean;
  error?: string;
  highlight: boolean;
  onReview: (focus: string) => Promise<boolean>;
  onAction: (action: AnswerAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState("");
  const feedback = answer.feedback;
  const versions = answer.versions ?? [];
  const hasText = !!answer.answer.trim();

  return <div data-revision-anchor={encodeURIComponent(answer.question)} className={`space-y-3 rounded-lg transition-shadow duration-500 ${highlight ? "ring-2 ring-violet-400 ring-offset-4" : ""}`}>
    {error && <p role="alert" data-block="error" className="scroll-mt-24 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    {hasText && <div className="space-y-2">
      <button type="button" disabled={disabled} aria-expanded={open} onClick={() => setOpen((v) => !v)}
        className="rounded-md border border-violet-200 bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700 transition hover:bg-violet-100 active:scale-95 disabled:pointer-events-none disabled:opacity-40">
        {reviewing ? "첨삭 중..." : open ? "첨삭 닫기" : "첨삭 받기"}
      </button>
      {open && <div className="space-y-2 rounded-lg border border-violet-100 bg-violet-50/40 p-3">
        <p className="text-xs leading-5 text-gray-500">글을 고치지 않고 평가와 구절별 수정 제안을 받습니다. 제안은 하나씩 반영하거나 넘길 수 있고, 반영할 때는 AI를 다시 부르지 않습니다.</p>
        <input aria-label="중점적으로 봐줄 부분" className={inputStyle} maxLength={500} value={focus} disabled={disabled}
          onChange={(e) => setFocus(e.target.value)} placeholder="중점적으로 봐줄 부분 (선택) — 예: 지원동기가 설득력 있는지" />
        <button type="button" className={primaryButton} disabled={disabled} onClick={async () => { if (await onReview(focus)) setOpen(false); }}>첨삭 받기</button>
        <p className="text-[11px] text-gray-400">AI 호출 1번이 듭니다(응답 형식이 깨졌을 때만 1번 더).</p>
      </div>}
    </div>}

    {feedback && <div data-block="feedback" className="scroll-mt-24 space-y-3 rounded-lg border border-violet-200 bg-white p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-violet-900">첨삭 결과{feedback.focus ? ` · ${feedback.focus}` : ""}</p>
        <button type="button" className="text-xs text-gray-400 hover:text-gray-600" disabled={disabled} onClick={() => onAction({ action: "close-feedback" })}>닫기</button>
      </div>
      <p className="text-sm leading-6 text-gray-700">{feedback.summary}</p>
      {!!feedback.strengths.length && <div className="text-xs"><p className="font-medium text-green-700">잘 된 점</p><ul className="list-disc pl-4 text-gray-600">{feedback.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul></div>}
      {!!feedback.issues.length && <div className="text-xs"><p className="font-medium text-amber-700">보완할 점</p><ul className="list-disc pl-4 text-gray-600">{feedback.issues.map((s, i) => <li key={i}>{s}</li>)}</ul></div>}
      {feedback.suggestions.length === 0 && <p className="text-xs text-gray-500">바로 바꿔 넣을 구절 제안은 없습니다.</p>}
      {feedback.suggestions.map((s) => {
        const applicable = answer.answer.includes(s.original);
        return <div key={s.id} className={`space-y-1.5 rounded-lg border p-2.5 text-xs ${s.status === "pending" ? "border-gray-200" : "border-gray-100 opacity-60"}`}>
          <div className="flex items-center gap-2"><span className="rounded bg-violet-100 px-1.5 py-0.5 text-violet-700">{s.category}</span>
            {s.status === "applied" && <span className="text-green-700">반영함</span>}{s.status === "dismissed" && <span className="text-gray-400">넘김</span>}</div>
          <p className="whitespace-pre-wrap text-red-600 line-through decoration-red-300">{s.original}</p>
          <p className="whitespace-pre-wrap text-green-800">{s.replacement || "(이 구절 삭제)"}</p>
          {s.reason && <p className="text-gray-500">{s.reason}</p>}
          {s.status === "pending" && <div className="flex items-center gap-2">
            <button type="button" className={primaryButton} disabled={disabled || !applicable} onClick={() => onAction({ action: "apply-suggestion", suggestionId: s.id })}>반영</button>
            <button type="button" className={secondaryButton} disabled={disabled} onClick={() => onAction({ action: "dismiss-suggestion", suggestionId: s.id })}>넘기기</button>
            {!applicable && <span className="text-amber-700">원문 구절이 바뀌어 반영할 수 없습니다.</span>}
          </div>}
        </div>;
      })}
    </div>}

    {versions.length > 1 && <details className="text-xs text-gray-600">
      <summary className="cursor-pointer">버전 기록 {versions.length}개</summary>
      <ol className="mt-2 space-y-2">{versions.map((v, i) => ({ v, i })).reverse().map(({ v, i }) => {
        const current = v.answer === answer.answer;
        return <li key={v.id} className="rounded-lg border border-gray-100 p-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">v{i + 1} · {VERSION_LABELS[v.kind]}</span>
            <span className="text-gray-400">{new Date(v.createdAt).toLocaleString("ko-KR")}</span>
            {current && <span className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-700">현재</span>}
          </div>
          {v.note && <p className="mt-1 text-gray-500">{v.note}</p>}
          <details className="mt-1"><summary className="cursor-pointer text-gray-500">내용 보기 · {characterCount(v.answer, answer.countSpaces).toLocaleString()}자</summary>
            <p className="mt-1 whitespace-pre-wrap leading-5">{v.answer}</p>
            {!current && <button type="button" className={`${secondaryButton} mt-2`} disabled={disabled} onClick={() => onAction({ action: "restore-version", versionId: v.id })}>이 버전으로 되돌리기</button>}
          </details>
        </li>;
      })}</ol>
    </details>}
  </div>;
}

// 자기소개서 저장: 대화 세션에서 쓴 글을 문항과 함께 저장한다. AI 호출 없음.
export function EssayImportForm({ disabled, defaultOpen, onImport }: {
  disabled: boolean;
  defaultOpen: boolean;
  onImport: (input: { question: string; maxChars?: number; countSpaces: boolean; answer: string }) => Promise<boolean>;
}) {
  const [question, setQuestion] = useState("");
  const [maxChars, setMaxChars] = useState("");
  const [countSpaces, setCountSpaces] = useState(true);
  const [answer, setAnswer] = useState("");
  return <details className="rounded-lg border border-gray-200 p-3" open={defaultOpen || undefined}>
    <summary className="cursor-pointer text-sm font-medium text-gray-700">자기소개서 저장</summary>
    <div className="mt-3 space-y-2">
      <p className="text-xs leading-5 text-gray-500">쓴 글을 문항과 함께 저장합니다. 같은 문항이 이미 있으면 새 글로 바뀌고, 이전 글은 버전 기록에 남습니다.</p>
      <label className="block text-xs font-medium text-gray-700">지원서 문항<textarea className={`${inputStyle} mt-1`} rows={2} maxLength={8000} value={question} disabled={disabled}
        onChange={(e) => { setQuestion(e.target.value); if (/공백\s*제외/.test(e.target.value)) setCountSpaces(false); }} /></label>
      <div className="flex items-center gap-4">
        <label className="text-xs text-gray-600">최대 글자 수<input className={`${inputStyle} mt-1 max-w-40`} type="number" min={1} max={10000} value={maxChars} disabled={disabled} onChange={(e) => setMaxChars(e.target.value)} placeholder="선택" /></label>
        <label className="flex items-center gap-2 text-xs text-gray-600"><input type="checkbox" checked={countSpaces} disabled={disabled} onChange={(e) => setCountSpaces(e.target.checked)} />공백 포함</label>
      </div>
      <label className="block text-xs font-medium text-gray-700">내가 쓴 답변<textarea className={`${inputStyle} mt-1`} rows={8} maxLength={30000} value={answer} disabled={disabled} onChange={(e) => setAnswer(e.target.value)} /></label>
      <p className="text-xs text-gray-400">{characterCount(answer, countSpaces).toLocaleString()}자{maxChars ? ` / ${Number(maxChars).toLocaleString()}자` : ""}</p>
      <button type="button" className={primaryButton} disabled={disabled || !question.trim() || !answer.trim()} onClick={async () => {
        if (await onImport({ question, ...(maxChars ? { maxChars: Number(maxChars) } : {}), countSpaces, answer })) { setQuestion(""); setMaxChars(""); setAnswer(""); }
      }}>저장</button>
    </div>
  </details>;
}
