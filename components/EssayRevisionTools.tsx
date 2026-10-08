"use client";

import { useState } from "react";
import { characterCount, type EssayAnswer, type EssayVersionKind, type IndustryResearch } from "@/lib/essay-contract";
import { diffSentences } from "@/lib/essay-diff";

const inputStyle = "w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200";
const primaryButton = "rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-700 active:scale-95 disabled:pointer-events-none disabled:opacity-40";
const secondaryButton = "rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 transition hover:bg-gray-50 active:scale-95 disabled:pointer-events-none disabled:opacity-40";

const VERSION_LABELS: Record<EssayVersionKind, string> = {
  ai_draft: "AI 초안", user_import: "직접 쓴 글", user_edit: "직접 수정", ai_revision: "고쳐쓰기 반영", suggestion: "첨삭 제안 반영", restore: "버전 복원",
};
const QUICK_REQUESTS = ["글자 수 제한에 맞게 줄여주세요.", "경험 부분을 더 구체적으로 다듬어주세요.", "첫 문장을 문항에 바로 답하도록 바꿔주세요.", "어색하거나 상투적인 표현을 자연스럽게 다듬어주세요."];

export type AnswerAction =
  | { action: "accept-revision" | "discard-revision" | "close-feedback" | "dismiss-needs-info" | "close-research" }
  | { action: "apply-suggestion" | "dismiss-suggestion"; suggestionId: string }
  | { action: "restore-version"; versionId: string };

function DiffView({ before, after }: { before: string; after: string }) {
  return <p className="whitespace-pre-wrap rounded-lg border border-gray-200 bg-white p-3 text-sm leading-6 text-gray-700">
    {diffSentences(before, after).map((part, i) => part.type === "same" ? <span key={i}>{part.text}</span>
      : part.type === "removed" ? <del key={i} className="bg-red-50 text-red-600 decoration-red-400">{part.text}</del>
      : <ins key={i} className="bg-green-50 text-green-800 no-underline">{part.text}</ins>)}
  </p>;
}

export type ResearchRequest =
  | { step: "scope"; instruction: string; topic: string }
  | { step: "collect"; selectedIds: string[]; direction: string };

const CONDITIONAL_REQUEST = "특정 기관명·시점·현황은 단정하지 말고, 자료 없이 쓸 수 있는 조건부 논의와 판단 기준·상충관계 중심으로 고쳐주세요.";

// 업계 사례 조사 패널. 후보 찾기 → (사용자가 자료·구성 방향 선택) → 자료 정리 → 고른 발췌로 고쳐쓰기.
// 선택 상태는 조사 결과가 바뀔 때마다(key) 초기화된다.
function ResearchPanel({ research, disabled, onResearch, onRevise, onClose }: {
  research: IndustryResearch;
  disabled: boolean;
  onResearch: (request: ResearchRequest) => Promise<boolean>;
  onRevise: (instruction: string, findingIds: string[]) => Promise<boolean>;
  onClose: () => void;
}) {
  const [view, setView] = useState<"candidates" | "findings">(research.stage === "collected" ? "findings" : "candidates");
  const [picked, setPicked] = useState<string[]>(research.selectedIds.length ? research.selectedIds : research.candidates.slice(0, 3).map((c) => c.id));
  const [direction, setDirection] = useState(research.direction);
  const [findingIds, setFindingIds] = useState<string[]>(research.findings.map((f) => f.id));
  const [instruction, setInstruction] = useState(research.instruction);
  const [topic, setTopic] = useState(research.topic);
  const [retopic, setRetopic] = useState(false);
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  return <div data-block="research" className="scroll-mt-24 space-y-3 rounded-lg border border-indigo-200 bg-indigo-50/40 p-3 text-xs">
    <div className="flex items-center justify-between gap-2">
      <p className="text-sm font-medium text-indigo-900">업계 사례 조사 · {view === "candidates" ? "1. 읽을 자료와 구성 방향 고르기" : "2. 쓸 자료 고르고 고쳐쓰기"}</p>
      <button type="button" className="text-gray-400 hover:text-gray-600" disabled={disabled} onClick={onClose}>조사 닫기</button>
    </div>
    <p className="text-gray-600">조사 내용: {research.topic}</p>
    {view === "candidates" ? <>
      <p className="text-gray-500">검색으로 찾은 후보입니다. 읽고 정리할 자료를 최대 5개 골라주세요. 고른 자료만 열어서 사실과 원문을 정리합니다.</p>
      <ul className="space-y-2">{research.candidates.map((c) => <li key={c.id} className="flex gap-2 rounded-lg border border-gray-200 bg-white p-2">
        <input type="checkbox" aria-label={`${c.title} 선택`} checked={picked.includes(c.id)} disabled={disabled || (!picked.includes(c.id) && picked.length >= 5)} onChange={() => setPicked((v) => toggle(v, c.id))} />
        <div className="space-y-0.5"><a href={c.url} target="_blank" rel="noopener noreferrer" className="font-medium text-blue-700 underline">{c.title}</a>
          <p className="text-gray-400">{[c.publisher, c.date].filter(Boolean).join(" · ")}</p><p className="text-gray-600">{c.summary}</p></div>
      </li>)}</ul>
      {!!research.directionQuestions.length && <div className="space-y-1"><p className="font-medium text-gray-700">어떤 방향으로 구성할까요?</p><ul className="list-disc pl-4 text-gray-600">{research.directionQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul></div>}
      <textarea aria-label="구성 방향" className={inputStyle} rows={2} maxLength={1000} value={direction} disabled={disabled} onChange={(e) => setDirection(e.target.value)} placeholder="예: 국내 사례 중심으로, 2문단의 비용·시간 비교 논지에 연결해주세요." />
      <div className="flex flex-wrap gap-2">
        <button type="button" className={primaryButton} disabled={disabled || !picked.length} onClick={() => void onResearch({ step: "collect", selectedIds: picked, direction })}>선택한 자료 {picked.length}개 읽고 정리하기</button>
        {research.stage === "collected" && <button type="button" className={secondaryButton} disabled={disabled} onClick={() => setView("findings")}>정리한 자료로 돌아가기</button>}
        <button type="button" className={secondaryButton} disabled={disabled} onClick={() => setRetopic((v) => !v)}>조사 내용 바꿔 다시 찾기</button>
      </div>
      <p className="text-[11px] text-gray-400">자료 정리는 고른 자료 수만큼 페이지를 엽니다(AI 조사 1회).</p>
    </> : <>
      {research.direction && <p className="text-gray-600">구성 방향: {research.direction}</p>}
      <p className="text-gray-500">웹에서 정리한 사실과 원문 발췌입니다. 반영 전에 링크에서 내용을 확인하고, 쓸 자료만 남겨주세요.</p>
      <ul className="space-y-2">{research.findings.map((f) => <li key={f.id} className="flex gap-2 rounded-lg border border-gray-200 bg-white p-2">
        <input type="checkbox" aria-label={`${f.fact} 사용`} checked={findingIds.includes(f.id)} disabled={disabled} onChange={() => setFindingIds((v) => toggle(v, f.id))} />
        <div className="space-y-1"><p className="text-gray-800">{f.fact}</p><blockquote className="whitespace-pre-wrap border-l-2 border-indigo-200 pl-2 text-gray-500">{f.quote}</blockquote>
          <a href={f.url} target="_blank" rel="noopener noreferrer" className="text-blue-700 underline">{f.title}</a>{f.date && <span className="text-gray-400"> · {f.date}</span>}</div>
      </li>)}</ul>
      <label className="block text-gray-700">고쳐쓰기 요청<textarea className={`${inputStyle} mt-1`} rows={2} maxLength={2000} value={instruction} disabled={disabled} onChange={(e) => setInstruction(e.target.value)} /></label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={primaryButton} disabled={disabled || !findingIds.length || !instruction.trim()}
          onClick={() => void onRevise(`${instruction}${research.direction ? `\n[구성 방향] ${research.direction}` : ""}\n고른 조사 자료(research.*)를 근거로 사용해주세요.`, findingIds)}>이 자료로 고쳐쓰기</button>
        <button type="button" className={secondaryButton} disabled={disabled} onClick={() => setView("candidates")}>다른 자료 고르기</button>
      </div>
    </>}
    {retopic && <div className="space-y-2 rounded-lg bg-white p-2">
      <textarea aria-label="조사할 내용" className={inputStyle} rows={3} maxLength={2000} value={topic} disabled={disabled} onChange={(e) => setTopic(e.target.value)} />
      <button type="button" className={primaryButton} disabled={disabled || !topic.trim()} onClick={() => void onResearch({ step: "scope", instruction: research.instruction, topic })}>다시 찾기</button>
    </div>}
    {!!research.notes.length && <ul className="list-disc pl-4 text-gray-400">{research.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
  </div>;
}

// 답변 카드 하나의 첨삭 도구: 첨삭 요청, 보완 질문, 업계 사례 조사, 고쳐쓰기 비교·반영, 첨삭 제안 반영, 버전 기록.
export function EssayRevisionTools({ answer, disabled, revising, error, highlight, onRevise, onResearch, onAction }: {
  answer: EssayAnswer;
  disabled: boolean;
  revising: boolean;
  error?: string;
  highlight: boolean;
  onRevise: (mode: "rewrite" | "review", text: string, findingIds?: string[]) => Promise<boolean>;
  onResearch: (request: ResearchRequest) => Promise<boolean>;
  onAction: (action: AnswerAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const [extraInfo, setExtraInfo] = useState("");
  const [researchForm, setResearchForm] = useState<{ instruction: string; topic: string } | null>(null);
  const needsInfo = answer.revisionNeedsInfo;
  const research = answer.industryResearch;
  const startResearchForm = (instruction: string, questions: string[] = []) =>
    setResearchForm({ instruction, topic: [instruction, ...questions].filter(Boolean).join("\n") });
  const [mode, setMode] = useState<"rewrite" | "review">("rewrite");
  const [instruction, setInstruction] = useState("");
  const [focus, setFocus] = useState("");
  const pending = answer.pendingRevision;
  const feedback = answer.feedback;
  const versions = answer.versions ?? [];
  const hasText = !!answer.answer.trim();
  const pendingCount = pending ? characterCount(pending.answer, answer.countSpaces) : 0;

  return <div data-revision-anchor={encodeURIComponent(answer.question)} className={`space-y-3 rounded-lg transition-shadow duration-500 ${highlight ? "ring-2 ring-violet-400 ring-offset-4" : ""}`}>
    {error && <p role="alert" data-block="error" className="scroll-mt-24 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    {hasText && <div className="space-y-2">
      <button type="button" disabled={disabled} aria-expanded={open} onClick={() => setOpen((v) => !v)}
        className="rounded-md border border-violet-200 bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700 transition hover:bg-violet-100 active:scale-95 active:bg-violet-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 disabled:pointer-events-none disabled:opacity-40">
        {revising ? "첨삭 중..." : open ? "첨삭 닫기" : "첨삭하기"}
      </button>
      {open && <div className="space-y-3 rounded-lg border border-violet-100 bg-violet-50/40 p-3">
        <div className="flex gap-1 rounded-md bg-white p-1 text-xs">
          {([["rewrite", "요청대로 고쳐쓰기"], ["review", "첨삭 받기"]] as const).map(([value, label]) =>
            <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}
              className={`flex-1 rounded px-2 py-1.5 ${mode === value ? "bg-violet-100 font-semibold text-violet-800" : "text-gray-500 hover:bg-gray-50"}`}>{label}</button>)}
        </div>
        {mode === "rewrite" ? <>
          <p className="text-xs leading-5 text-gray-500">현재 글에서 요청한 부분만 고친 수정본을 만듭니다. 바뀐 부분을 비교한 뒤 반영 여부를 고를 수 있습니다. 새 경험을 넣으려면 그 내용을 함께 적어주세요.</p>
          <div className="flex flex-wrap gap-1.5">{QUICK_REQUESTS.map((text) =>
            <button key={text} type="button" disabled={disabled} className={secondaryButton} onClick={() => setInstruction((v) => (v ? `${v}\n${text}` : text))}>{text.replace(/주세요\.$/, "")}</button>)}</div>
          <textarea aria-label="수정 요청" className={inputStyle} rows={3} maxLength={2000} value={instruction} disabled={disabled}
            onChange={(e) => setInstruction(e.target.value)} placeholder="예: 2문단의 협업 경험을 더 구체적으로, 마지막 문단은 입사 후 첫 1년 계획 중심으로 바꿔주세요." />
          <div className="flex flex-wrap gap-2">
            <button type="button" className={primaryButton} disabled={disabled || !instruction.trim()}
              onClick={() => void onRevise("rewrite", instruction)}>고쳐쓰기 요청</button>
            <button type="button" className={secondaryButton} disabled={disabled || !instruction.trim()} onClick={() => startResearchForm(instruction)}
              title="요청에 업계 사례나 제도 현황이 필요할 때 웹에서 먼저 찾아봅니다.">업계 사례 먼저 조사하기</button>
          </div>
        </> : <>
          <p className="text-xs leading-5 text-gray-500">글을 고치지 않고 평가와 구절별 수정 제안을 받습니다. 제안은 하나씩 반영하거나 넘길 수 있고, 반영할 때는 AI를 다시 부르지 않습니다.</p>
          <input aria-label="중점적으로 봐줄 부분" className={inputStyle} maxLength={500} value={focus} disabled={disabled}
            onChange={(e) => setFocus(e.target.value)} placeholder="중점적으로 봐줄 부분 (선택) — 예: 지원동기가 설득력 있는지" />
          <button type="button" className={primaryButton} disabled={disabled} onClick={() => void onRevise("review", focus)}>첨삭 받기</button>
        </>}
        <p className="text-[11px] text-gray-400">첨삭 1회에 AI 호출 1번이 듭니다(형식 오류 시에만 1번 더).</p>
      </div>}
    </div>}

    {needsInfo && <div data-block="needs-info" className="scroll-mt-24 space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-amber-900">고쳐쓰기에 정보가 더 필요합니다</p>
        <button type="button" className="text-gray-400 hover:text-gray-600" disabled={disabled} onClick={() => onAction({ action: "dismiss-needs-info" })}>닫기</button>
      </div>
      <p className="text-amber-800">요청: {needsInfo.instruction}</p>
      <p className="text-amber-800">자료에 없는 사실은 지어내지 않기 때문에, 아래 내용을 알려주시거나 다른 방법을 골라주세요. 글은 바뀌지 않았습니다.</p>
      <ul className="list-disc space-y-1 pl-4 text-amber-900">{needsInfo.questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
      <textarea aria-label="보완 정보" className={inputStyle} rows={3} maxLength={1800} value={extraInfo} disabled={disabled} onChange={(e) => setExtraInfo(e.target.value)} placeholder="답변이나 기사·보고서 본문과 출처 링크를 붙여넣어주세요." />
      <div className="flex flex-wrap gap-2">
        <button type="button" className={primaryButton} disabled={disabled || !extraInfo.trim()}
          onClick={() => void onRevise("rewrite", `${needsInfo.instruction}\n[추가 정보]\n${extraInfo}`)}>답변 추가해서 다시 고쳐쓰기</button>
        <button type="button" className={secondaryButton} disabled={disabled} onClick={() => void onRevise("rewrite", `${needsInfo.instruction}\n${CONDITIONAL_REQUEST}`)}>자료 없이 조건부로 진행</button>
        <button type="button" className={secondaryButton} disabled={disabled} onClick={() => startResearchForm(needsInfo.instruction, needsInfo.questions)}>업계 사례 조사하기</button>
      </div>
    </div>}

    {researchForm && <div className="space-y-2 rounded-lg border border-indigo-200 bg-indigo-50/40 p-3 text-xs">
      <p className="text-sm font-medium text-indigo-900">업계 사례 조사 시작</p>
      <p className="text-gray-500">웹 검색으로 후보 자료와 구성 방향 질문을 먼저 받아옵니다(검색 최대 3회, 이 단계에서는 페이지를 열지 않음). 후보를 보고 읽을 자료와 방향을 고른 뒤 정리를 이어갑니다.</p>
      <textarea aria-label="조사할 내용" className={inputStyle} rows={4} maxLength={2000} value={researchForm.topic} disabled={disabled} onChange={(e) => setResearchForm({ ...researchForm, topic: e.target.value })} />
      <div className="flex gap-2">
        <button type="button" className={primaryButton} disabled={disabled || !researchForm.topic.trim()} onClick={async () => {
          if (await onResearch({ step: "scope", ...researchForm })) setResearchForm(null);
        }}>후보 찾기</button>
        <button type="button" className={secondaryButton} disabled={disabled} onClick={() => setResearchForm(null)}>취소</button>
      </div>
    </div>}

    {research && <ResearchPanel key={research.updatedAt} research={research} disabled={disabled} onResearch={onResearch}
      onRevise={(instruction, ids) => onRevise("rewrite", instruction, ids)} onClose={() => onAction({ action: "close-research" })} />}

    {pending && <div data-block="pending-revision" className="scroll-mt-24 space-y-2 rounded-lg border border-green-200 bg-green-50/50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-green-900">고쳐쓰기 결과</p>
        <span className="text-xs text-gray-500">{pendingCount.toLocaleString()}자{answer.maxChars ? ` / ${answer.maxChars.toLocaleString()}자` : ""}</span>
      </div>
      <p className="text-xs text-gray-600">요청: {pending.instruction}</p>
      {!!pending.changeSummary.length && <ul className="list-disc pl-4 text-xs text-gray-600">{pending.changeSummary.map((c, i) => <li key={i}>{c}</li>)}</ul>}
      {answer.answer !== pending.baseText && <p className="text-xs text-amber-700">첨삭을 요청한 뒤 글이 바뀌어 반영할 수 없습니다. 버리고 다시 요청해주세요.</p>}
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

// 내 글 가져오기: 직접 쓴 자기소개서를 문항에 저장해 첨삭을 시작한다. AI 호출 없음.
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
      <p className="text-xs leading-5 text-gray-500">이미 써 둔 글을 문항과 함께 저장하고 첨삭하기로 다듬을 수 있습니다. 같은 문항의 답변이 있으면 이전 글은 버전 기록에 남습니다.</p>
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
