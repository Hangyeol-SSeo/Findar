"use client";

import { useState } from "react";
import { characterCount, FIT_LENGTH_REQUEST, splitParagraphs, type EssayAnswer, type EssayVersionKind } from "@/lib/essay-contract";
import { diffSentences } from "@/lib/essay-diff";

const inputStyle = "w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200";
const primaryButton = "rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-700 active:scale-95 disabled:pointer-events-none disabled:opacity-40";
const secondaryButton = "rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 transition hover:bg-gray-50 active:scale-95 disabled:pointer-events-none disabled:opacity-40";

const VERSION_LABELS: Record<EssayVersionKind, string> = {
  ai_draft: "AI 초안", user_import: "직접 쓴 글", user_edit: "직접 수정", ai_revision: "다시 쓰기 반영", suggestion: "첨삭 제안 반영", restore: "버전 복원",
};
const QUICK_REQUESTS = ["경험 부분을 더 구체적으로 다듬어주세요.", "첫 문장이 문항에 바로 답하도록 바꿔주세요.", "어색하거나 상투적인 표현을 자연스럽게 다듬어주세요."];

export type AnswerAction =
  | { action: "accept-revision" | "discard-revision" | "close-feedback" | "dismiss-needs-info" }
  | { action: "apply-suggestion" | "dismiss-suggestion"; suggestionId: string }
  | { action: "restore-version"; versionId: string };

export type RevisionMode = "rewrite" | "review";
export interface RevisionRequest { mode: RevisionMode; text: string; paragraphs?: number[] }

function DiffView({ before, after }: { before: string; after: string }) {
  return <p className="whitespace-pre-wrap rounded-lg border border-gray-200 bg-white p-3 text-sm leading-6 text-gray-700">
    {diffSentences(before, after).map((part, i) => part.type === "same" ? <span key={i}>{part.text}</span>
      : part.type === "removed" ? <del key={i} className="bg-red-50 text-red-600 decoration-red-400">{part.text}</del>
      : <ins key={i} className="bg-green-50 text-green-800 no-underline">{part.text}</ins>)}
  </p>;
}

// 답변 카드 하나의 고치기 도구: 문단 다시 쓰기(고른 문단만, 비우면 글 전체), 첨삭 받기, 다시 쓴 결과 비교·반영, 제안 반영, 버전 기록.
export function EssayRevisionTools({ answer, disabled, revising, error, highlight, onRevise, onAction }: {
  answer: EssayAnswer;
  disabled: boolean;
  revising: boolean;
  error?: string;
  highlight: boolean;
  onRevise: (request: RevisionRequest) => Promise<boolean>;
  onAction: (action: AnswerAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<RevisionMode>("rewrite");
  const [instruction, setInstruction] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const [focus, setFocus] = useState("");
  const [extraInfo, setExtraInfo] = useState("");
  const needsInfo = answer.revisionNeedsInfo;
  const pending = answer.pendingRevision;
  const feedback = answer.feedback;
  const versions = answer.versions ?? [];
  const hasText = !!answer.answer.trim();
  const paragraphs = splitParagraphs(answer.answer).paragraphs;
  const overLimit = !!answer.maxChars && characterCount(answer.answer, answer.countSpaces) > answer.maxChars;
  const pendingCount = pending ? characterCount(pending.answer, answer.countSpaces) : 0;
  const toggle = (i: number) => setPicked((v) => (v.includes(i) ? v.filter((x) => x !== i) : [...v, i].sort((a, b) => a - b)));
  const submitRewrite = async (text: string, targets: number[]) => {
    if (await onRevise({ mode: "rewrite", text, paragraphs: targets })) { setInstruction(""); setPicked([]); }
  };

  return <div data-revision-anchor={encodeURIComponent(answer.question)} className={`space-y-3 rounded-lg transition-shadow duration-500 ${highlight ? "ring-2 ring-violet-400 ring-offset-4" : ""}`}>
    {error && <p role="alert" data-block="error" className="scroll-mt-24 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    {hasText && <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={disabled} aria-expanded={open} onClick={() => setOpen((v) => !v)}
          className="rounded-md border border-violet-200 bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700 transition hover:bg-violet-100 active:scale-95 disabled:pointer-events-none disabled:opacity-40">
          {revising ? "고치는 중..." : open ? "고치기 닫기" : "고치기"}
        </button>
        {overLimit && <button type="button" className={secondaryButton} disabled={disabled} onClick={() => void submitRewrite(FIT_LENGTH_REQUEST, [])}
          title="글 전체를 글자 수 제한에 맞게 줄인 수정본을 만듭니다. 비교한 뒤 반영할 수 있습니다.">글자 수에 맞게 줄이기</button>}
      </div>
      {open && <div className="space-y-3 rounded-lg border border-violet-100 bg-violet-50/40 p-3">
        <div className="flex gap-1 rounded-md bg-white p-1 text-xs">
          {([["rewrite", "문단 다시 쓰기"], ["review", "첨삭 받기"]] as const).map(([value, label]) =>
            <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}
              className={`flex-1 rounded px-2 py-1.5 ${mode === value ? "bg-violet-100 font-semibold text-violet-800" : "text-gray-500 hover:bg-gray-50"}`}>{label}</button>)}
        </div>
        {mode === "rewrite" ? <>
          <p className="text-xs leading-5 text-gray-500">고칠 문단을 고르고 요청을 적으면 그 문단만 다시 씁니다(고르지 않으면 글 전체). 나머지 문단은 그대로 두고, 바뀐 부분을 비교한 뒤 반영할 수 있습니다.</p>
          <fieldset className="space-y-1">
            <legend className="text-xs font-medium text-gray-700">고칠 문단</legend>
            {paragraphs.map((p, i) => <label key={i} className="flex items-start gap-2 rounded bg-white p-1.5 text-xs text-gray-600">
              <input type="checkbox" className="mt-0.5" checked={picked.includes(i)} disabled={disabled} onChange={() => toggle(i)} />
              <span><span className="font-medium text-gray-800">{i + 1}문단</span> {p.length > 70 ? `${p.slice(0, 70)}…` : p}</span>
            </label>)}
          </fieldset>
          <div className="flex flex-wrap gap-1.5">{QUICK_REQUESTS.map((text) =>
            <button key={text} type="button" disabled={disabled} className={secondaryButton} onClick={() => setInstruction((v) => (v ? `${v}\n${text}` : text))}>{text.replace(/주세요\.$/, "")}</button>)}</div>
          <textarea aria-label="수정 요청" className={inputStyle} rows={3} maxLength={4000} value={instruction} disabled={disabled}
            onChange={(e) => setInstruction(e.target.value)} placeholder="예: 이 문단은 지원동기가 약해요. 왜 이 회사인지로 시작해주세요." />
          <button type="button" className={primaryButton} disabled={disabled || !instruction.trim()} onClick={() => void submitRewrite(instruction, picked)}>
            {picked.length ? `${picked.map((i) => i + 1).join(", ")}문단 다시 쓰기` : "글 전체 다시 쓰기"}
          </button>
        </> : <>
          <p className="text-xs leading-5 text-gray-500">글을 고치지 않고 평가와 구절별 수정 제안을 받습니다. 제안은 하나씩 반영하거나 넘길 수 있고, 반영할 때는 AI를 다시 부르지 않습니다.</p>
          <input aria-label="중점적으로 봐줄 부분" className={inputStyle} maxLength={500} value={focus} disabled={disabled}
            onChange={(e) => setFocus(e.target.value)} placeholder="중점적으로 봐줄 부분 (선택) — 예: 지원동기가 설득력 있는지" />
          <button type="button" className={primaryButton} disabled={disabled} onClick={() => void onRevise({ mode: "review", text: focus })}>첨삭 받기</button>
        </>}
        <p className="text-[11px] text-gray-400">한 번에 AI 호출 1번이 듭니다(응답 형식이 깨졌을 때만 1번 더).</p>
      </div>}
    </div>}

    {needsInfo && <div data-block="needs-info" className="scroll-mt-24 space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-amber-900">다시 쓰려면 정보가 더 필요합니다</p>
        <button type="button" className="text-gray-400 hover:text-gray-600" disabled={disabled} onClick={() => onAction({ action: "dismiss-needs-info" })}>닫기</button>
      </div>
      <p className="text-amber-800">요청: {needsInfo.instruction}</p>
      <p className="text-amber-800">자료에 없는 사실은 지어내지 않기 때문에, 아래 내용을 알려주시면 반영해서 다시 씁니다. 글은 바뀌지 않았습니다.</p>
      <ul className="list-disc space-y-1 pl-4 text-amber-900">{needsInfo.questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
      <textarea aria-label="보완 정보" className={inputStyle} rows={3} maxLength={2000} value={extraInfo} disabled={disabled} onChange={(e) => setExtraInfo(e.target.value)} placeholder="질문에 대한 답을 적어주세요." />
      <button type="button" className={primaryButton} disabled={disabled || !extraInfo.trim()}
        onClick={async () => { if (await onRevise({ mode: "rewrite", text: `${needsInfo.instruction}\n[추가 정보]\n${extraInfo}`, paragraphs: [] })) setExtraInfo(""); }}>답을 넣어서 다시 쓰기</button>
    </div>}

    {pending && <div data-block="pending-revision" className="scroll-mt-24 space-y-2 rounded-lg border border-green-200 bg-green-50/50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-green-900">다시 쓴 결과</p>
        <span className="text-xs text-gray-500">{pendingCount.toLocaleString()}자{answer.maxChars ? ` / ${answer.maxChars.toLocaleString()}자` : ""}</span>
      </div>
      <p className="text-xs text-gray-600">요청: {pending.instruction}</p>
      {!!pending.changeSummary.length && <ul className="list-disc pl-4 text-xs text-gray-600">{pending.changeSummary.map((c, i) => <li key={i}>{c}</li>)}</ul>}
      {!!pending.reviewNotes.length && <ul className="list-disc pl-4 text-xs text-amber-800">{pending.reviewNotes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      {answer.answer !== pending.baseText && <p className="text-xs text-amber-700">요청한 뒤 글이 바뀌어 반영할 수 없습니다. 버리고 다시 요청해주세요.</p>}
      <DiffView before={pending.baseText} after={pending.answer} />
      <div className="flex gap-2">
        <button type="button" className={primaryButton} disabled={disabled || answer.answer !== pending.baseText} onClick={() => onAction({ action: "accept-revision" })}>반영</button>
        <button type="button" className={secondaryButton} disabled={disabled} onClick={() => onAction({ action: "discard-revision" })}>버리기</button>
      </div>
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

// 내 글 가져오기: 직접 쓴 자기소개서를 문항에 저장해 고치기를 시작한다. AI 호출 없음.
export function EssayImportForm({ disabled, onImport }: {
  disabled: boolean;
  onImport: (input: { question: string; maxChars?: number; countSpaces: boolean; answer: string }) => Promise<boolean>;
}) {
  const [question, setQuestion] = useState("");
  const [maxChars, setMaxChars] = useState("");
  const [countSpaces, setCountSpaces] = useState(true);
  const [answer, setAnswer] = useState("");
  return <details className="rounded-lg border border-gray-200 p-3">
    <summary className="cursor-pointer text-sm font-medium text-gray-700">직접 쓴 자기소개서 가져오기</summary>
    <div className="mt-3 space-y-2">
      <p className="text-xs leading-5 text-gray-500">이미 써 둔 글을 문항과 함께 저장하고 고치기로 다듬을 수 있습니다. 같은 문항의 답변이 있으면 이전 글은 버전 기록에 남습니다.</p>
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
      }}>가져와서 저장</button>
    </div>
  </details>;
}
