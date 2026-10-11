"use client";

import { useState, useEffect, useRef } from "react";
import { detectBrowserExtension } from "@/lib/browser-extension-client";
import { characterCount, type EssayAnswer, type EssayOutline } from "@/lib/essay-contract";
import { taskActive, type ApplicationTask } from "@/lib/application-task-types";
import { FREEFORM_ESSAY_QUESTION } from "@/lib/essay-questions";
import type { ApplicationDraft } from "@/lib/application-draft";
import type { SubmissionMethodInfo } from "@/lib/application-method";
import { EssayImportForm, EssayRevisionTools, type AnswerAction, type RevisionRequest } from "./EssayRevisionTools";
import { EssayOutlineEditor, type MaterialOption } from "./EssayOutlineEditor";
import ApplicationTaskCancelButton from "./ApplicationTaskCancelButton";
import Toast, { useToast } from "./Toast";

// 작업이 끝났을 때 알릴 문구(작업 결과 종류별).
const OUTCOME_MESSAGES: Record<string, string> = {
  "pending-revision": "다시 쓴 결과가 도착했습니다. 바뀐 부분을 비교하고 반영 여부를 골라주세요.",
  feedback: "첨삭 결과가 도착했습니다. 제안을 하나씩 반영하거나 넘길 수 있습니다.",
  "needs-info": "다시 쓰려면 정보가 더 필요합니다. 답변 아래의 질문을 확인해주세요.",
};

const inputStyle = "w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200";
const buttonStyle = "rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40";

interface QuestionRow { id: string; question: string; maxChars: string; countSpaces: boolean; guidance: string; freeform: boolean }
function newRow(id: string): QuestionRow {
  return { id, question: "", maxChars: "", countSpaces: true, guidance: "", freeform: false };
}

export default function ApplicationDraftPanel({ seq, companyName, roleRevision }: { seq: string; companyName: string; roleRevision?: string | null }) {
  const [workspace, setWorkspace] = useState<"essay" | "fill">("essay");
  const [draft, setDraft] = useState<ApplicationDraft | null>(null);
  const [method, setMethod] = useState<SubmissionMethodInfo | null>(null);
  const [researchNotice, setResearchNotice] = useState<string | null>(null);
  // 구성 확인 화면의 "쓸 경험" 목록과, 화면에서 고치는 중인 구성(작성할 때 서버로 보낸다).
  const [materials, setMaterials] = useState<MaterialOption[]>([]);
  const [outlineEdits, setOutlineEdits] = useState<EssayOutline[]>([]);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false);
  // 확인하지 않은 경험 카드는 구성 확인에서 (미확인)으로 표시된다. 카드를 다시 만들면 확인 표시가 사라지므로 알린다.
  const [cardGate, setCardGate] = useState<{ unconfirmed: number; coversProfile: boolean; stale: boolean } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/experience-cards", { cache: "no-store", signal: abort.signal }).then((r) => r.json()).then((s: { cards: { user_confirmed: boolean }[]; coversProfile: boolean; stale: boolean }) =>
      setCardGate({ unconfirmed: s.cards.filter((c) => !c.user_confirmed).length, coversProfile: s.coversProfile, stale: s.stale })).catch(() => {});
    return () => abort.abort();
  }, [seq]);
  // 이 공고에서 쓴 실제 AI 사용량. 답변이 바뀔 때(작업이 끝날 때)마다 다시 읽는다.
  const [usage, setUsage] = useState<{ calls: number; inputTokens: number; cacheReadTokens: number; outputTokens: number; cacheHitRatio: number } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    fetch(`/api/ai-usage?seq=${encodeURIComponent(seq)}`, { cache: "no-store", signal: abort.signal }).then((r) => r.json())
      .then((u: { summary: NonNullable<typeof usage> }) => setUsage(u.summary.calls ? u.summary : null)).catch(() => {});
    return () => abort.abort();
  }, [seq, draft?.revision]);
  const nextRowId = useRef(1);
  const [rows, setRows] = useState<QuestionRow[]>(() => [newRow("q0")]);
  // 보낸 문항을 작업별로 기억해 두었다가, 작업이 실패·취소되면 저장되지 않은 문항을 입력란에 되돌린다.
  // 실패할 때마다 4문항을 처음부터 다시 입력해야 했다.
  const submittedRows = useRef(new Map<string, { rows: QuestionRow[]; at: number }>());
  // "이 문항 보완해서 다시 작성"으로 채운 입력란은 답변 목록보다 한참 위에 있어서, 렌더링 뒤 그 칸으로 이동시킨다.
  const focusGuidanceRowId = useRef<string | null>(null);
  useEffect(() => {
    const id = focusGuidanceRowId.current;
    if (!id) return;
    focusGuidanceRowId.current = null;
    const field = document.querySelector<HTMLTextAreaElement>(`[data-guidance-row="${id}"]`);
    field?.scrollIntoView({ behavior: "smooth", block: "center" });
    field?.focus({ preventScroll: true });
  }, [rows]);
  const [pollRevision, setPollRevision] = useState(0);
  // 저장된 구성이 바뀌면(새 제안, 작성 후 정리) 화면의 고친 구성과 맞춘다. 같은 제안을 고치는 중이면 고친 내용을 유지한다.
  useEffect(() => {
    const saved = draft?.outlines ?? [];
    setOutlineEdits((prev) => saved.map((o) => prev.find((p) => p.question === o.question && p.createdAt === o.createdAt) ?? o));
  }, [draft?.outlines]);
  const { message: toastMessage, showToast } = useToast(6000);
  // 문항별 첨삭·조사 오류는 그 답변 아래에 보여준다(위쪽 알림만으로는 놓치기 쉬움).
  const [answerErrors, setAnswerErrors] = useState<Record<string, string>>({});
  const [highlightQuestion, setHighlightQuestion] = useState<string | null>(null);
  const attention = useRef<{ question?: string; block?: string } | null>(null);
  // 이 화면이 열려 있는 동안 진행 중이던 작업만 끝났을 때 알린다 — 다시 열었을 때 지난 작업으로 화면이 튀지 않게.
  const watchedTasks = useRef(new Set<string>());
  const [tasks, setTasks] = useState<ApplicationTask[]>([]);
  const handledTasks = useRef(new Set<string>());
  const dirtyRef = useRef(false);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  const [extension, setExtension] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [documentResult, setDocumentResult] = useState<{ href: string; filename: string; filled: number; skipped: { label: string; reason: string }[]; note: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    fetch(`/api/applications/${seq}/draft`, { signal: abort.signal }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setDraft(data.draft); setMethod(data.submissionMethod); setUrl(data.siteUrl || ""); setResearchNotice(data.companyResearchNotice ?? null); setMaterials(data.materials ?? []);
    }).catch((e) => { if (!abort.signal.aborted) setError(e.message); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    const receive = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== location.origin) return;
      if (event.data?.type === "FINDAR_READY") setExtension(true);
      if (event.data?.type === "FINDAR_CONNECTED" && event.data.seq === seq) {
        if (event.data.error) setError(event.data.error);
        else setNotice("지원 사이트를 열었습니다. 실제 지원서로 이동한 뒤 확장 기능의 ‘현재 양식 채우기’를 눌러주세요.");
      }
    };
    window.addEventListener("message", receive);
    const detect = () => { void detectBrowserExtension(abort.signal).then((ready) => {
      if (!abort.signal.aborted) setExtension(ready);
    }); };
    detect();
    window.addEventListener("focus", detect);
    return () => { abort.abort(); window.removeEventListener("message", receive); window.removeEventListener("focus", detect); };
  }, [seq]);

  useEffect(() => {
    let stopped = false;
    const abort = new AbortController();
    let failures = 0;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const response = await fetch(`/api/applications/${seq}/tasks`, { cache: "no-store", signal: abort.signal });
        if (!response.ok) throw new Error("작업 상태를 불러오지 못했습니다.");
        const data: { tasks: ApplicationTask[] } = await response.json();
        // 이력 평가(tailoring) 작업은 ResumeTailoringPanel이 따로 추적한다.
        data.tasks = data.tasks.filter((t) => t.kind !== "tailoring");
        if (stopped) return;
        failures = 0;
        active = data.tasks.some(taskActive);
        setTasks(data.tasks);
        let reloadDraft = false;
        const restore: { rows: QuestionRow[]; at: number }[] = [];
        for (const task of data.tasks) {
          if (taskActive(task)) { watchedTasks.current.add(task.id); continue; }
          if (handledTasks.current.has(task.id)) continue;
          handledTasks.current.add(task.id);
          const watched = watchedTasks.current.has(task.id);
          const submitted = task.kind === "writing" && task.status !== "completed" ? submittedRows.current.get(task.id) : undefined;
          if (submitted) { restore.push(submitted); submittedRows.current.delete(task.id); }
          if (task.status === "cancelled") {
            if (task.kind !== "document") reloadDraft = true;
            if (watched) showToast(task.kind === "writing" ? `자기소개서 작성을 취소했습니다. 이미 저장한 문항 ${task.done}개는 유지됩니다.` : "작업을 취소했습니다. 기존 결과는 유지됩니다.");
            continue;
          }
          if (task.kind === "revision") {
            reloadDraft = true;
            if (!watched) continue;
            const question = task.question ?? "";
            if (task.status === "failed") {
              setAnswerErrors((prev) => ({ ...prev, [question]: task.error ?? "작업에 실패했습니다." }));
              showToast("고치기에 실패했습니다. 답변 아래에서 이유를 확인해주세요.");
            } else {
              showToast(OUTCOME_MESSAGES[task.result?.outcome ?? ""] ?? "작업을 마쳤습니다.");
            }
            attention.current = { question, block: task.status === "failed" ? "error" : task.result?.outcome };
            continue;
          }
          if (task.status === "failed") setError(task.error ?? "작업에 실패했습니다.");
          const outline = task.result?.outcome === "outline";
          if (watched && task.kind === "writing") {
            showToast(task.status === "failed" ? `${outline ? "구성 제안" : "자기소개서 작성"}에 실패했습니다. 위쪽 알림을 확인해주세요.`
              : outline ? "구성 제안이 도착했습니다. 확인하고 고친 뒤 작성해주세요." : "자기소개서 작성을 마쳤습니다.");
            attention.current = {};
          }
          if (task.kind === "writing") {
            // 실패한 묶음 작업도 앞 문항까지 저장됐을 수 있다. 조회는 전체에서 한 번만 한다.
            reloadDraft = true;
            if (task.status === "completed") setNotice(outline ? "구성 제안이 도착했습니다. 아래 구성 확인에서 핵심 메시지·문단·쓸 경험을 고친 뒤 ‘이 구성으로 작성’을 눌러주세요."
              : `문항 ${task.done}개를 작성했습니다. 답변 아래의 ‘확인’ 항목을 살펴보고, 고칠 곳은 ‘고치기’로 다듬을 수 있습니다. 작성된 답변은 자동 입력 탭에서 지원서에 넣을 수 있습니다.`);
          }
          const document = task.result?.document;
          if (document) setDocumentResult({ href: document.downloadUrl, filename: document.filename, filled: document.filled, skipped: document.skipped, note: document.note });
        }
        if (reloadDraft && !dirtyRef.current) {
          const draftResponse = await fetch(`/api/applications/${seq}/draft`, { cache: "no-store", signal: abort.signal });
          if (!draftResponse.ok) throw new Error("완성된 답변을 불러오지 못했습니다. 지원 도우미를 다시 열어주세요.");
          const current = await draftResponse.json();
          if (!stopped && !dirtyRef.current) setDraft(current.draft);
          if (!stopped) restoreUnsaved(restore, current.draft);
        } else if (!stopped) restoreUnsaved(restore, null);
      } catch (e) {
        failures++;
        if (!stopped) setError(e instanceof Error ? e.message : "작업 상태 확인 실패");
      } finally {
        // Empty or terminal task lists need no polling. Retry network errors only three times.
        if (!stopped && active && failures < 3) timer = setTimeout(refresh, 2000 * 2 ** failures);
      }
    }
    void refresh();
    return () => { stopped = true; abort.abort(); clearTimeout(timer); };
  }, [seq, pollRevision, showToast]);

  // 작업이 끝나면 결과가 놓인 곳으로 화면을 옮긴다: 첨삭·조사는 해당 답변의 첨삭 영역(잠시 강조), 문항 작성은 위쪽 알림.
  useEffect(() => {
    const target = attention.current;
    if (!target) return;
    attention.current = null;
    // 결과 블록(비교 화면·첨삭 결과·보완 질문·조사·오류)의 시작이 보이게 옮긴다. 블록이 길어도 윗부분부터 읽을 수 있다.
    const anchor = target.question !== undefined ? document.querySelector(`[data-revision-anchor="${encodeURIComponent(target.question)}"]`) : null;
    const element = target.question === undefined ? document.querySelector("[data-draft-status]")
      : anchor?.querySelector(`[data-block="${target.block}"]`) ?? anchor;
    element?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (target.question !== undefined) setHighlightQuestion(target.question);
  }, [draft, answerErrors]);
  useEffect(() => {
    if (highlightQuestion === null) return;
    const timer = setTimeout(() => setHighlightQuestion(null), 2500);
    return () => clearTimeout(timer);
  }, [highlightQuestion]);

  const writingTask = tasks.find((t) => t.kind === "writing" && taskActive(t));
  const writingBusy = busy === "writing" || !!writingTask;
  const revisionTask = tasks.find((t) => t.kind === "revision" && taskActive(t));
  const revisionBusy = busy === "revision" || !!revisionTask;
  const essayBusy = writingBusy || revisionBusy || ["save", "bank", "answer-action", "import"].includes(busy);
  const documentBusy = busy === "document";
  const progress = writingTask ? { done: writingTask.done, total: writingTask.total } : null;
  // 실패·취소된 작성 작업에서 이번에 저장되지 않은 문항만 입력란에 되돌린다(이미 입력 중인 문항은 그대로 둔다).
  function restoreUnsaved(entries: { rows: QuestionRow[]; at: number }[], saved: ApplicationDraft | null) {
    const back = entries.flatMap(({ rows: sent, at }) => sent.filter((row) => !saved?.essayAnswers.some((a) =>
      a.question === row.question.trim() && "generatedAt" in a && typeof a.generatedAt === "number" && a.generatedAt >= at)));
    if (!back.length) return;
    setRows((prev) => {
      const typing = prev.filter((r) => r.question.trim());
      const fresh = back.filter((r) => !typing.some((t) => t.question.trim() === r.question.trim()))
        .map((r) => ({ ...r, id: `q${nextRowId.current++}` }));
      return [...typing, ...fresh].length ? [...typing, ...fresh] : prev;
    });
    setNotice(`저장되지 않은 문항 ${back.length}개를 입력란에 그대로 되돌려 두었습니다. 다시 작성을 누르면 됩니다.`);
  }
  function acceptTask(task: ApplicationTask) {
    watchedTasks.current.add(task.id);
    setTasks((prev) => [...prev.filter((t) => t.id !== task.id), task]);
    // Restart after explicit creation, including tasks already completed in the POST response.
    setPollRevision((value) => value + 1);
  }

  async function api(path: string, body: unknown, method = "POST") {
    const response = await fetch(`/api/applications/${seq}/${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "요청에 실패했습니다.");
    return data;
  }
  // 저장 후의 최신 revision을 돌려준다 — 바로 이어지는 첨삭 동작이 그 값으로 충돌을 검사한다.
  async function save(): Promise<string | null> {
    if (!draft || !dirty) return draft?.revision ?? null;
    const data = await api("draft", draft, "PUT");
    setDraft(data.draft); setDirty(false);
    return data.draft.revision ?? null;
  }
  async function run(label: string, action: () => Promise<void>) {
    setBusy(label); setError(""); setNotice("");
    try { await action(); }
    catch (e) { if (!controller.current?.signal.aborted) setError(e instanceof Error ? e.message : "처리 중 오류가 발생했습니다."); }
    finally { if (!controller.current?.signal.aborted) setBusy(""); }
  }
  function addRow() { setRows((prev) => [...prev, newRow(`q${nextRowId.current++}`)]); }
  function removeRow(id: string) { setRows((prev) => (prev.length > 1 ? prev.filter((r) => r.id !== id) : prev)); }
  function updateRow(id: string, patch: Partial<QuestionRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  // 체크하면 실제 문항 텍스트에 자유기술형 안내 문구를 바로 채워 넣는다 — 이 문항을 그대로
  // 보내면 서버는 다른 문항과 똑같이 취급하고, 프롬프트 안의 "자유롭게 기술" 표현을 보고
  // 알아서 여러 주제를 엮은 하나의 글로 작성한다.
  function toggleFreeform(id: string, checked: boolean) {
    updateRow(id, { freeform: checked, question: checked ? FREEFORM_ESSAY_QUESTION : "" });
  }

  // 구성 제안: 문항 전체를 한 번에 보내 핵심 메시지·문단 구성·쓸 경험·확인 질문을 받는다.
  async function requestOutlines() {
    const filled = rows.filter((r) => r.question.trim());
    if (!filled.length || writingBusy) return;
    await run("writing", async () => {
      await save();
      const sentAt = Date.now();
      const data = await api("draft/outline", { questions: filled.map((row) => ({
        question: row.question, ...(row.maxChars ? { maxChars: Number(row.maxChars) } : {}),
        countSpaces: row.countSpaces, guidance: row.guidance,
      })) });
      submittedRows.current.set(data.task.id, { rows: filled, at: sentAt });
      acceptTask(data.task);
      setRows([newRow(`q${nextRowId.current++}`)]);
      setNotice("구성을 제안받고 있습니다. 끝나면 아래에 구성 확인 카드가 나타납니다.");
    });
  }
  // 확인·수정한 구성대로 작성한다. 여러 개면 한 번의 AI 호출로 함께 쓴다.
  async function writeOutlines(list: EssayOutline[]) {
    if (!list.length || writingBusy) return;
    await run("writing", async () => {
      await save();
      const data = await api("draft/question", { outlines: list });
      acceptTask(data.task);
      setNotice("확정한 구성대로 작성하고 있습니다. 끝나면 아래에 답변이 나타납니다.");
    });
  }
  async function removeOutline(question: string) {
    await run("outline-remove", async () => {
      const response = await fetch(`/api/applications/${seq}/draft/outline?question=${encodeURIComponent(question)}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "구성을 지우지 못했습니다.");
      setDraft(data.draft);
    });
  }
  async function startRevision(question: string, request: RevisionRequest) {
    let started = false;
    setAnswerErrors((prev) => ({ ...prev, [question]: "" }));
    await run("revision", async () => {
      await save();
      const data = await api("draft/revision", { question, mode: request.mode,
        ...(request.mode === "review" ? { focus: request.text } : { instruction: request.text, paragraphs: request.paragraphs ?? [] }) });
      acceptTask(data.task);
      started = true;
      setNotice(request.mode === "rewrite" ? "다시 쓰고 있습니다. 끝나면 답변 아래에 비교 화면이 나타납니다." : "첨삭을 시작했습니다. 끝나면 답변 아래에 평가와 제안이 나타납니다.");
    });
    return started;
  }
  async function answerAction(question: string, action: AnswerAction) {
    setAnswerErrors((prev) => ({ ...prev, [question]: "" }));
    await run("answer-action", async () => {
      const revision = await save();
      const data = await api("draft/answer-action", { question, revision, ...action });
      setDraft(data.draft);
    });
  }
  async function importAnswer(input: { question: string; maxChars?: number; countSpaces: boolean; answer: string }) {
    let imported = false;
    await run("import", async () => {
      const revision = await save();
      const data = await api("draft/import", { ...input, revision });
      setDraft(data.draft);
      imported = true;
      setNotice("직접 쓴 글을 저장했습니다. 답변 아래의 첨삭하기로 다듬을 수 있습니다.");
    });
    return imported;
  }
  function editAnswer(index: number, answer: string) {
    setDraft((prev) => prev ? { ...prev, essayAnswers: prev.essayAnswers.map((a, i) => i === index ? { ...a, answer } : a) } : prev);
    setDirty(true);
  }
  async function fillDocument() {
    if (!file) return;
    await run("document", async () => {
      await save();
      const form = new FormData(); form.append("file", file);
      const response = await fetch(`/api/applications/${seq}/fill/document`, { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      acceptTask(data.task);
      setNotice("Word 작성을 시작했습니다. 화면을 이동해도 작업이 계속됩니다.");
    });
  }
  if (loading) return <p className="py-8 text-center text-sm text-gray-400">지원 정보를 불러오는 중...</p>;
  const currentAnswers = draft?.essayAnswers.map((a, index) => ({ a, index })).filter(({ a }) => a.source === "user_question") ?? [];
  const legacyAnswers = draft?.essayAnswers.map((a, index) => ({ a, index })).filter(({ a }) => a.source !== "user_question") ?? [];

  return <div className="space-y-6">
    <nav aria-label="지원 도우미 작업" className="flex gap-2 rounded-lg bg-gray-100 p-1">
      {([['essay', '문항별 자기소개서'], ['fill', '지원서 자동 입력']] as const).map(([value, label]) => <button key={value} onClick={() => { setWorkspace(value); setError(""); setNotice(""); }} aria-pressed={workspace === value} className={`flex-1 rounded-md px-3 py-2 text-sm ${workspace === value ? "bg-white font-semibold text-blue-700 shadow-sm" : "text-gray-500"}`}>{label}</button>)}
    </nav>
    {tasks.length > 0 && <section aria-label="백그라운드 작업" className="rounded-lg border border-blue-100 p-3 text-xs space-y-2">
      <p className="font-medium">작업 현황 · 탭을 이동해도 계속 진행됩니다</p>
      <button type="button" className="text-blue-600 underline" onClick={() => setPollRevision((value) => value + 1)}>작업 상태 새로고침</button>
      {tasks.map((task) => <div key={task.id} className="flex flex-wrap items-center gap-2">
        <span>{task.kind === "writing" ? (task.result?.outcome === "outline" ? "구성 제안" : "자기소개서") : task.kind === "revision" ? "고치기" : "Word 입력"} · {task.status === "queued" ? "대기 중" : task.status === "running" ? `진행 중 ${task.done}/${task.total}` : task.status === "cancelling" ? "취소 중..." : task.status === "cancelled" ? "취소됨" : task.status === "completed" ? "완료" : "실패"}</span>
        <ApplicationTaskCancelButton task={task} onUpdate={acceptTask} onError={setError} />
        {task.error && <span className="text-red-600">{task.error}</span>}
        {task.result?.document && <a className="text-blue-600 underline" href={task.result.document.downloadUrl} download={task.result.document.filename}>{task.result.document.filename} · {task.result.document.filled}/{task.result.document.total}칸 입력 · 다운로드</a>}
      </div>)}
    </section>}
    <div data-draft-status className="space-y-2">
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {notice && <p role="status" className="rounded-lg bg-blue-50 p-3 text-sm text-blue-800">{notice}</p>}
    </div>
    <Toast message={toastMessage} />
    {workspace === "fill" && <section className="rounded-xl border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2"><h3 className="font-semibold text-gray-800">지원서에 개인정보·자기소개서 입력</h3><a className="text-xs text-blue-600 underline" href="/profile#applicant">지원 정보 수정</a></div>
      <p className="text-xs leading-5 text-gray-500">내 지원 자료에 저장한 지원 정보와 이 공고에 저장된 자기소개서 답변을 실제 양식에 채웁니다. 작성 중인 답변은 완료 후 다시 입력해주세요. 입력 결과를 확인한 뒤 제출해주세요.</p>
      {!!method?.templateAttachments.length && <div className="flex flex-wrap gap-2">{method.templateAttachments.map((a) => <a key={a.url} href={a.url} target="_blank" rel="noreferrer" className="text-xs text-blue-600 underline">{a.name} 내려받기</a>)}</div>}
      <div className="rounded-lg bg-gray-50 p-3 space-y-2">
        <h4 className="text-sm font-medium">Word 양식 작성</h4>
        <p className="text-xs text-gray-500">DOCX의 표 입력칸과 자기소개서 본문 영역을 채우고 원본 형식을 유지한 작성본을 만듭니다. DOC·HWP는 DOCX로 변환해서 올려주세요.</p>
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-3 space-y-2">
          <input ref={fileInputRef} aria-label="Word 지원서 양식" type="file" accept=".docx" disabled={documentBusy} onChange={(e) => { setFile(e.target.files?.[0] ?? null); setDocumentResult(null); }} className="hidden" />
          <button type="button" disabled={documentBusy} onClick={() => fileInputRef.current?.click()} className="inline-flex items-center gap-2 rounded-lg border border-blue-300 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-100 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-40">
            <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 7h7l2 2h9v10H3z" /><path d="M3 7V5h7l2 2" /></svg>
            {file ? "다른 Word 파일 선택" : "Word 파일 선택"}
          </button>
          <p className="break-all text-xs text-gray-600" aria-live="polite">{file ? file.name : "선택한 파일이 없습니다. DOCX 양식을 선택해주세요."}</p>
        </div>
        <button className={buttonStyle} disabled={documentBusy || !file} onClick={fillDocument}>{busy === "document" ? "양식 작성 중..." : "개인정보·답변 채운 Word 만들기"}</button>
        {documentResult && <div className="text-xs space-y-2"><a className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700" href={documentResult.href} download={documentResult.filename}>작성본 다운로드</a><p className="break-all">{documentResult.filename} · {documentResult.filled}칸 입력 · 30분 동안 다운로드 가능</p><p className="text-gray-500">{documentResult.note}</p>{documentResult.skipped.length > 0 && <details><summary>직접 확인할 항목 {documentResult.skipped.length}개</summary>{documentResult.skipped.map((s, i) => <p key={i}>{s.label}: {s.reason}</p>)}</details>}</div>}
      </div>
      <div className="rounded-lg bg-gray-50 p-3 space-y-2">
        <h4 className="text-sm font-medium">Brave · Chrome 웹 지원서 입력</h4>
        <p className="text-xs text-gray-500"><a className="text-blue-600 underline" href="/api/application-fill/extension">최신 확장 기능 다운로드</a> · 업데이트 후 압축 해제 폴더를 교체하고 브라우저 확장 프로그램 관리에서 새로고침해주세요.</p>
        <div className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-xs leading-5 text-blue-900">
          <p>Findar 화면과 지원 사이트를 모두 확장을 설치한 Brave·Chrome에서 열어주세요. cmux 등 앱 내장 브라우저에서는 Brave에 설치한 확장을 사용할 수 없습니다.</p>
          <button type="button" className="mt-1 font-medium underline underline-offset-2" onClick={() => run("copy-address", async () => {
            await navigator.clipboard.writeText(location.origin);
            setNotice("Findar 주소를 복사했습니다. 확장을 설치한 Brave·Chrome 주소창에 붙여넣고, 공고의 지원 도우미를 열어주세요.");
          })}>Brave·Chrome에서 열 Findar 주소 복사</button>
        </div>
        <label className="block text-xs text-gray-500">지원 사이트 주소<input aria-label="지원 사이트 주소" type="url" className={`${inputStyle} mt-1`} value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy === "web"} placeholder="https://..." /></label>
        <p className="text-xs text-gray-500" role="status">{extension ? "확장 기능 연결 준비 완료" : "확장 기능이 아직 감지되지 않았습니다. 연결 버튼을 누르면 다시 확인합니다."}</p>
        {!extension && <details className="text-xs text-gray-600" open><summary className="cursor-pointer font-medium">처음 한 번 브라우저 연결하기</summary><ol className="list-decimal pl-4 space-y-1 mt-2"><li><a className="text-blue-600 underline" href="/api/application-fill/extension">Findar 확장 기능 다운로드</a> 후 압축을 풉니다.</li><li>Brave의 확장 프로그램 관리에서 개발자 모드를 켜고 ‘압축해제된 확장 프로그램을 로드합니다’로 해당 폴더를 선택합니다.</li><li>이 페이지를 새로고침합니다. Chrome도 같은 방식으로 설치합니다.</li></ol></details>}
        <button className={buttonStyle} disabled={busy === "web" || !/^https?:\/\//.test(url.trim())} onClick={() => run("web", async () => {
          const ready = await detectBrowserExtension(controller.current?.signal);
          if (controller.current?.signal.aborted) return;
          setExtension(ready);
          if (!ready) throw new Error("현재 Findar 페이지에서 확장에 연결할 수 없습니다. cmux 등 앱 내장 브라우저를 사용 중이면 아래 ‘Findar 주소 복사’로 주소를 복사해 Brave·Chrome에서 Findar 자체를 열어주세요. 이미 Brave·Chrome이라면 동일 프로필의 확장 활성화와 localhost 사이트 접근 권한을 확인해주세요.");
          await save();
          const data = await api("fill/web", {});
          window.postMessage({ type: "FINDAR_CONNECT", token: data.token, seq, url: url.trim() }, location.origin);
          setNotice("브라우저 연결 요청을 보냈습니다. 열린 지원서에서 확장 기능을 실행해주세요.");
        })}>{busy === "web" ? "브라우저 연결 확인 중..." : "웹 지원서 연결"}</button>
        <p className="text-xs text-gray-500">실제 지원서 페이지에서 확장 기능의 ‘현재 양식 채우기’를 실행합니다. 입력된 값과 채우지 못한 항목을 확인할 수 있습니다.</p>
      </div>
    </section>}

    {workspace === "essay" && cardGate && (cardGate.unconfirmed > 0 || cardGate.stale) && <p className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-800">
      {cardGate.unconfirmed > 0 && <>확인하지 않은 경험 카드 {cardGate.unconfirmed}개는 구성 확인에서 ‘(미확인)’으로 표시됩니다. 내용이 맞는지 한 번 확인해 두면 좋습니다. </>}
      {cardGate.stale && <>경험 자료가 바뀌어 카드를 다시 만들어야 합니다. </>}
      <a href="/profile#experience" className="underline">내 지원 자료 → 경험 카드</a>에서 확인해주세요.
    </p>}
    {workspace === "essay" && researchNotice && <p className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-800">{researchNotice}</p>}
    {workspace === "essay" && usage && <p className="text-xs text-gray-400" title="이 공고에서 구성 제안·작성·고치기에 쓴 AI 사용량입니다.">
      이 공고 AI 사용: {usage.calls.toLocaleString()}회 · 새로 처리한 입력 {usage.inputTokens.toLocaleString()} · 캐시에서 읽은 입력 {usage.cacheReadTokens.toLocaleString()}({Math.round(usage.cacheHitRatio * 100)}%) · 출력 {usage.outputTokens.toLocaleString()} 토큰
    </p>}
    {workspace === "essay" && <><section className="space-y-3">
      <div><h3 className="font-semibold text-gray-800">실제 문항에 맞춰 자기소개서 작성</h3><p className="mt-1 text-xs leading-5 text-gray-500">① 문항을 넣고 구성 제안을 받으면 ② 문항마다 핵심 메시지·문단 구성·쓸 경험·확인 질문이 나옵니다. 고친 뒤 ③ 그 구성대로 작성합니다. 문항이 여러 개면 한꺼번에 제안받고 한꺼번에 작성할 수 있습니다.</p></div>
      {rows.map((row, i) => <div key={row.id} className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-1.5 text-xs text-gray-600"><input type="checkbox" checked={row.freeform} disabled={essayBusy} onChange={(e) => toggleFreeform(row.id, e.target.checked)} />자유 문항</label>
          {rows.length > 1 && <button type="button" disabled={essayBusy} className="text-xs text-gray-400 hover:text-red-500" onClick={() => removeRow(row.id)}>삭제</button>}
        </div>
        <label className="block text-xs font-medium text-gray-700">지원서 문항<textarea className={`${inputStyle} mt-1`} rows={4} value={row.question} maxLength={8000} disabled={essayBusy} onChange={(e) => {
          updateRow(row.id, { question: e.target.value, countSpaces: /공백\s*제외/.test(e.target.value) ? false : row.countSpaces });
        }} placeholder={`문항 ${i + 1} — 실제 지원서에서 묻는 문항을 그대로 붙여넣어주세요. 하위 질문과 작성 조건도 함께 넣어주세요.`} /></label>
        <div className="flex items-center gap-4"><label className="text-xs text-gray-600">최대 글자 수<input aria-label={`문항 ${i + 1} 최대 글자 수`} className={`${inputStyle} mt-1 max-w-40`} type="number" min={1} max={10000} value={row.maxChars} onChange={(e) => updateRow(row.id, { maxChars: e.target.value })} disabled={essayBusy} placeholder="문항에 있으면 자동 반영" /></label><label className="text-xs text-gray-600 flex items-center gap-2"><input type="checkbox" checked={row.countSpaces} onChange={(e) => updateRow(row.id, { countSpaces: e.target.checked })} disabled={essayBusy} />공백 포함</label></div>
        <label className="block text-xs text-gray-600">이번 문항의 추가 자료·관점·수정 요청 <span className="text-gray-400">(선택)</span><textarea data-guidance-row={row.id} className={`${inputStyle} mt-1`} rows={3} maxLength={6000} value={row.guidance} onChange={(e) => updateRow(row.id, { guidance: e.target.value })} disabled={essayBusy} placeholder="구체적인 경험, 본인의 견해, 참고할 자료의 본문과 출처, 수정 요청 등을 적어주세요." /></label>
      </div>)}
      <div className="flex items-center gap-2">
        <button type="button" disabled={essayBusy} className="rounded-lg bg-gray-100 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-200 disabled:opacity-40" onClick={addRow}>+ 문항 추가</button>
        <button className={buttonStyle} disabled={essayBusy || !rows.some((r) => r.question.trim())} onClick={requestOutlines}>
          {writingBusy ? (progress && progress.total > 1 ? `작성 중 ${progress.done}/${progress.total}...` : "AI가 작업 중...") : "구성 제안 받기"}
        </button>
      </div>
      {writingBusy && <p className="text-xs text-gray-500" role="status">AI 호출 1번으로 처리합니다. 보통 1~2분 걸립니다.</p>}
      <EssayImportForm disabled={essayBusy} onImport={importAnswer} />
    </section>
    {!!outlineEdits.length && <section aria-label="구성 확인" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-gray-800">구성 확인 {outlineEdits.length}개</h3>
        {outlineEdits.length > 1 && <button type="button" className={buttonStyle} disabled={essayBusy} onClick={() => void writeOutlines(outlineEdits)}>구성 {outlineEdits.length}개 모두 작성</button>}
      </div>
      {outlineEdits.map((o) => <EssayOutlineEditor key={`${o.question}-${o.createdAt}`} outline={o} materials={materials} disabled={essayBusy}
        onChange={(next) => setOutlineEdits((prev) => prev.map((x) => (x.question === o.question ? next : x)))}
        onWrite={() => void writeOutlines([o])} onRemove={() => void removeOutline(o.question)} />)}
    </section>}
    {currentAnswers.map(({ a, index }) => {
      const answer = a as EssayAnswer;
      const count = characterCount(answer.answer, answer.countSpaces);
      return <section key={index} className="rounded-xl border border-gray-200 p-4 space-y-3">
        <h4 className="whitespace-pre-wrap text-sm font-semibold text-gray-800">{answer.question}</h4>
        <p className="text-xs leading-5 text-gray-500">{answer.intent}</p>
        {roleRevision != null && answer.roleRevision !== roleRevision && <p className="text-xs text-amber-700">현재 지원 직무로 생성된 답변이 아닙니다. 기존 답변을 검토하거나 다시 작성해주세요.</p>}
        {answer.targetRole && <p className="text-xs text-gray-500">작성 기준 직무: {answer.targetRole}</p>}
        {answer.status === "needs_info" ? <div className="bg-amber-50 p-3 rounded-lg text-sm text-amber-800"><p className="font-medium">답변에 필요한 정보를 보완해주세요</p><ul className="mt-2 list-disc pl-4">{answer.missingInfo.map((info, i) => <li key={i}>{info}</li>)}</ul></div> : <>
          <textarea aria-label={`${answer.question} 답변`} className={inputStyle} rows={12} value={answer.answer} onChange={(e) => editAnswer(index, e.target.value)} disabled={essayBusy} />
          <p className={`text-xs ${answer.maxChars && count > answer.maxChars ? "text-red-600" : "text-gray-400"}`}>{count.toLocaleString()}자{answer.maxChars ? ` / ${answer.maxChars.toLocaleString()}자` : ""} · 공백 {answer.countSpaces ? "포함" : "제외"}{dirty ? " · 수정 내용 저장 필요" : ""}</p>
        </>}
        {answer.reviewNotes.some((n) => n.startsWith("확인:")) && <ul className="space-y-1 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
          {answer.reviewNotes.filter((n) => n.startsWith("확인:")).map((n, i) => <li key={i}>{n}</li>)}
        </ul>}
        {answer.outline && <details className="text-xs text-gray-600">
          <summary className="cursor-pointer">작성 구성</summary>
          <div className="mt-2 space-y-1">
            <p className="font-medium">핵심 메시지: {answer.outline.message || "(없음)"}</p>
            <ol className="list-decimal pl-4 space-y-1">{answer.outline.paragraphs.map((p, i) => <li key={i}>{p.role || "(역할 없음)"}{p.materials.length ? ` — ${p.materials.map((id) => materials.find((m) => m.id === id)?.label ?? id).join(", ")}` : ""}</li>)}</ol>
          </div>
        </details>}
        {answer.reviewNotes.some((n) => !n.startsWith("확인:")) && <details className="text-xs text-gray-500"><summary className="cursor-pointer">문체 점검과 검토 메모</summary><div className="mt-2 space-y-1">{answer.reviewNotes.filter((n) => !n.startsWith("확인:")).map((n, i) => <p key={i}>{n}</p>)}{answer.evidenceStale && <p className="text-amber-700">직접 수정·제안 반영·버전 복원 이후의 본문이라 위 메모가 현재 글과 다를 수 있습니다.</p>}</div></details>}
        <div className="flex flex-wrap gap-3 text-xs">
          <button type="button" disabled={essayBusy} className="rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1 font-medium text-blue-700 transition hover:bg-blue-100 active:scale-95 active:bg-blue-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 disabled:pointer-events-none disabled:opacity-40" onClick={() => {
            const id = `q${nextRowId.current++}`;
            focusGuidanceRowId.current = id;
            setRows([{ id, question: answer.question, maxChars: answer.maxChars?.toString() ?? "", countSpaces: answer.countSpaces, guidance: answer.guidance, freeform: answer.question === FREEFORM_ESSAY_QUESTION }]);
            setNotice("위 문항 입력란에서 필요한 요청을 보완한 뒤 ‘구성 제안 받기’를 눌러주세요. 지금 글을 다듬으려면 ‘고치기’를 이용해주세요.");
          }} title="구성 제안부터 다시 받습니다. 지금 글은 버전 기록에 남습니다.">구성부터 다시</button>
          {answer.answer && <><button disabled={essayBusy} className="text-gray-500" onClick={() => run("copy", async () => { await navigator.clipboard.writeText(answer.answer); setNotice("답변을 복사했습니다."); })}>답변 복사</button><button disabled={essayBusy} className="text-gray-500" onClick={() => run("bank", async () => {
            await save();
            const response = await fetch("/api/essay-bank", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seq, company: companyName, question: answer.question, answer: answer.answer }) });
            if (!response.ok) throw new Error("확정 답변을 경험 자료로 저장하지 못했습니다.");
            setNotice("검토한 답변을 다음 작성에 참고할 자료로 저장했습니다.");
          })}>검토한 답변을 자료로 저장</button></>}
        </div>
        <EssayRevisionTools answer={answer} disabled={essayBusy} revising={revisionBusy} error={answerErrors[answer.question] || undefined}
          highlight={highlightQuestion === answer.question}
          onRevise={(request) => startRevision(answer.question, request)}
          onAction={(action) => void answerAction(answer.question, action)} />
      </section>;
    })}
    {!!legacyAnswers.length && <details className="rounded-lg border border-gray-200 p-3"><summary className="text-xs text-gray-500 cursor-pointer">이전 방식으로 작성한 답변 {legacyAnswers.length}개 보관됨</summary><p className="my-2 text-xs text-gray-400">자동으로 만든 공통 답변입니다. 실제 문항에 대한 새 답변과 구분해 보관합니다.</p>{legacyAnswers.map(({ a, index }) => <div key={index} className="mt-3"><p className="text-xs font-medium mb-1">{a.question}</p><textarea aria-label={`이전 답변 ${a.question}`} rows={5} value={a.answer} className={inputStyle} onChange={(e) => editAnswer(index, e.target.value)} disabled={essayBusy} /></div>)}</details>}
    {draft && <button className={buttonStyle} disabled={essayBusy || !dirty} onClick={() => run("save", async () => { await save(); setNotice("수정한 답변을 저장했습니다."); })}>{busy === "save" ? "저장 중..." : dirty ? "수정한 답변 저장" : "답변 저장됨"}</button>}
    </>}
  </div>;
}
