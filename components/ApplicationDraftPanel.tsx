"use client";

import { useState, useEffect, useRef } from "react";
import { detectBrowserExtension } from "@/lib/browser-extension-client";
import { characterCount, type EssayAnswer } from "@/lib/essay-contract";
import { taskActive, type ApplicationTask } from "@/lib/application-task-types";
import type { ApplicationDraft } from "@/lib/application-draft";
import type { SubmissionMethodInfo } from "@/lib/application-method";
import { EssayImportForm, EssayReviewTools, type AnswerAction } from "./EssayReviewTools";
import ApplicationTaskCancelButton from "./ApplicationTaskCancelButton";
import Toast, { useToast } from "./Toast";

const inputStyle = "w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200";
const buttonStyle = "rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40";

// 이 공고에서 "최종본으로 저장"해 과거 자소서 자료에 들어간 글.
interface FinalEssay { question: string; answer: string; savedAt: number }

// 자기소개서는 대화 세션에서 쓰고, 여기서는 저장·직접 수정·버전 기록·첨삭 받기·최종본 저장만 한다.
export default function ApplicationDraftPanel({ seq, roleRevision }: { seq: string; roleRevision?: string | null }) {
  const [workspace, setWorkspace] = useState<"essay" | "fill">("essay");
  const [draft, setDraft] = useState<ApplicationDraft | null>(null);
  const [finals, setFinals] = useState<FinalEssay[]>([]);
  const [method, setMethod] = useState<SubmissionMethodInfo | null>(null);
  const [researchNotice, setResearchNotice] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false);
  // 이 공고에서 쓴 실제 AI 사용량(첨삭). 답변이 바뀔 때(작업이 끝날 때)마다 다시 읽는다.
  const [usage, setUsage] = useState<{ calls: number; inputTokens: number; cacheReadTokens: number; outputTokens: number; cacheHitRatio: number } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    fetch(`/api/ai-usage?seq=${encodeURIComponent(seq)}`, { cache: "no-store", signal: abort.signal }).then((r) => r.json())
      .then((u: { summary: NonNullable<typeof usage> }) => setUsage(u.summary.calls ? u.summary : null)).catch(() => {});
    return () => abort.abort();
  }, [seq, draft?.revision]);
  const [pollRevision, setPollRevision] = useState(0);
  const { message: toastMessage, showToast } = useToast(6000);
  // 문항별 첨삭 오류는 그 답변 아래에 보여준다(위쪽 알림만으로는 놓치기 쉬움).
  const [answerErrors, setAnswerErrors] = useState<Record<string, string>>({});
  const [highlightQuestion, setHighlightQuestion] = useState<string | null>(null);
  const attention = useRef<{ question: string; block: string } | null>(null);
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
      setDraft(data.draft); setFinals(data.finals ?? []); setMethod(data.submissionMethod); setUrl(data.siteUrl || ""); setResearchNotice(data.companyResearchNotice ?? null);
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
        for (const task of data.tasks) {
          if (taskActive(task)) { watchedTasks.current.add(task.id); continue; }
          if (handledTasks.current.has(task.id)) continue;
          handledTasks.current.add(task.id);
          const watched = watchedTasks.current.has(task.id);
          if (task.status === "cancelled") {
            if (task.kind !== "document") reloadDraft = true;
            if (watched) showToast("작업을 취소했습니다. 기존 결과는 유지됩니다.");
            continue;
          }
          if (task.kind === "revision") {
            reloadDraft = true;
            if (!watched) continue;
            const question = task.question ?? "";
            if (task.status === "failed") {
              setAnswerErrors((prev) => ({ ...prev, [question]: task.error ?? "작업에 실패했습니다." }));
              showToast("첨삭에 실패했습니다. 답변 아래에서 이유를 확인해주세요.");
            } else {
              showToast("첨삭 결과가 도착했습니다. 제안을 하나씩 반영하거나 넘길 수 있습니다.");
            }
            attention.current = { question, block: task.status === "failed" ? "error" : "feedback" };
            continue;
          }
          if (task.status === "failed") setError(task.error ?? "작업에 실패했습니다.");
          const document = task.result?.document;
          if (document) setDocumentResult({ href: document.downloadUrl, filename: document.filename, filled: document.filled, skipped: document.skipped, note: document.note });
        }
        if (reloadDraft && !dirtyRef.current) {
          const draftResponse = await fetch(`/api/applications/${seq}/draft`, { cache: "no-store", signal: abort.signal });
          if (!draftResponse.ok) throw new Error("첨삭 결과를 불러오지 못했습니다. 지원 도우미를 다시 열어주세요.");
          const current = await draftResponse.json();
          if (!stopped && !dirtyRef.current) setDraft(current.draft);
        }
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

  // 첨삭이 끝나면 그 답변의 첨삭 결과(또는 오류)로 화면을 옮기고 잠시 강조한다.
  useEffect(() => {
    const target = attention.current;
    if (!target) return;
    attention.current = null;
    const anchor = document.querySelector(`[data-revision-anchor="${encodeURIComponent(target.question)}"]`);
    (anchor?.querySelector(`[data-block="${target.block}"]`) ?? anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setHighlightQuestion(target.question);
  }, [draft, answerErrors]);
  useEffect(() => {
    if (highlightQuestion === null) return;
    const timer = setTimeout(() => setHighlightQuestion(null), 2500);
    return () => clearTimeout(timer);
  }, [highlightQuestion]);

  const reviewTask = tasks.find((t) => t.kind === "revision" && taskActive(t));
  const reviewBusy = busy === "review" || !!reviewTask;
  const essayBusy = reviewBusy || ["save", "final", "answer-action", "import"].includes(busy);
  const documentBusy = busy === "document";
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
  // 저장 후의 최신 revision을 돌려준다 — 바로 이어지는 동작이 그 값으로 충돌을 검사한다.
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
  async function startReview(question: string, focus: string) {
    let started = false;
    setAnswerErrors((prev) => ({ ...prev, [question]: "" }));
    await run("review", async () => {
      await save();
      const data = await api("draft/review", { question, focus });
      acceptTask(data.task);
      started = true;
      setNotice("첨삭을 시작했습니다. 끝나면 답변 아래에 평가와 제안이 나타납니다.");
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
  // 최종본으로 저장: 고친 내용을 먼저 저장하고, 그 본문을 과거 자소서 자료에 넣는다.
  async function saveFinal(question: string) {
    await run("final", async () => {
      const revision = await save();
      const data = await api("draft/final", { question, revision });
      setFinals(data.finals);
      setNotice("최종본을 과거 자소서 자료에 저장했습니다. 다음 자기소개서와 경험 카드에 쓰입니다.");
    });
  }
  async function importAnswer(input: { question: string; maxChars?: number; countSpaces: boolean; answer: string }) {
    let imported = false;
    await run("import", async () => {
      const revision = await save();
      const data = await api("draft/import", { ...input, revision });
      setDraft(data.draft);
      imported = true;
      setNotice("자기소개서를 저장했습니다. 고칠 곳은 직접 고치거나 첨삭을 받을 수 있고, 다 되면 ‘최종본으로 저장’을 눌러주세요.");
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
        <span>{task.kind === "revision" ? "첨삭" : "Word 입력"} · {task.status === "queued" ? "대기 중" : task.status === "running" ? `진행 중 ${task.done}/${task.total}` : task.status === "cancelling" ? "취소 중..." : task.status === "cancelled" ? "취소됨" : task.status === "completed" ? "완료" : "실패"}</span>
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


    {workspace === "essay" && researchNotice && <p className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-800">{researchNotice}</p>}
    {workspace === "essay" && usage && <p className="text-xs text-gray-400" title="이 공고에서 첨삭에 쓴 AI 사용량입니다.">
      이 공고 AI 사용: {usage.calls.toLocaleString()}회 · 새로 처리한 입력 {usage.inputTokens.toLocaleString()} · 캐시에서 읽은 입력 {usage.cacheReadTokens.toLocaleString()}({Math.round(usage.cacheHitRatio * 100)}%) · 출력 {usage.outputTokens.toLocaleString()} 토큰
    </p>}
    {workspace === "essay" && <><section className="space-y-3">
      <div><h3 className="font-semibold text-gray-800">자기소개서</h3><p className="mt-1 text-xs leading-5 text-gray-500">대화에서 쓴 글을 문항과 함께 저장해 두세요. 저장한 글은 직접 고치고, 첨삭을 받고, 이전 버전으로 되돌릴 수 있습니다. 다 되면 ‘최종본으로 저장’을 누르세요. 따로 파일을 올리지 않아도 과거 자소서 자료에 들어가 다음 자기소개서와 경험 카드에 쓰입니다.</p></div>
      <EssayImportForm disabled={essayBusy} defaultOpen={!currentAnswers.length} onImport={importAnswer} />
    </section>
    {currentAnswers.map(({ a, index }) => {
      const answer = a as EssayAnswer;
      const count = characterCount(answer.answer, answer.countSpaces);
      const final = finals.find((f) => f.question === answer.question);
      const finalCurrent = !!final && final.answer === answer.answer.trim() && !dirty;
      return <section key={index} className="rounded-xl border border-gray-200 p-4 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h4 className="whitespace-pre-wrap text-sm font-semibold text-gray-800">{answer.question}</h4>
          {final && <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${finalCurrent ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}
            title={`${new Date(final.savedAt).toLocaleString("ko-KR")}에 저장`}>{finalCurrent ? "최종본 저장됨" : "최종본 저장 후 바뀜"}</span>}
        </div>
        {answer.intent && <p className="text-xs leading-5 text-gray-500">{answer.intent}</p>}
        {roleRevision != null && answer.roleRevision && answer.roleRevision !== roleRevision && <p className="text-xs text-amber-700">지금 고른 지원 직무와 다른 직무 기준으로 저장한 답변입니다.</p>}
        {answer.targetRole && <p className="text-xs text-gray-500">지원 직무: {answer.targetRole}</p>}
        {answer.status === "needs_info" ? <div className="bg-amber-50 p-3 rounded-lg text-sm text-amber-800"><p className="font-medium">예전 AI 작성이 정보 부족으로 멈춘 문항입니다</p><ul className="mt-2 list-disc pl-4">{answer.missingInfo.map((info, i) => <li key={i}>{info}</li>)}</ul><p className="mt-2 text-xs">대화에서 쓴 글을 위 ‘자기소개서 저장’에 같은 문항으로 저장하면 이 내용이 바뀝니다.</p></div> : <>
          <textarea aria-label={`${answer.question} 답변`} className={inputStyle} rows={12} value={answer.answer} onChange={(e) => editAnswer(index, e.target.value)} disabled={essayBusy} />
          <p className={`text-xs ${answer.maxChars && count > answer.maxChars ? "text-red-600" : "text-gray-400"}`}>{count.toLocaleString()}자{answer.maxChars ? ` / ${answer.maxChars.toLocaleString()}자` : ""} · 공백 {answer.countSpaces ? "포함" : "제외"}{dirty ? " · 수정 내용 저장 필요" : ""}</p>
        </>}
        {answer.reviewNotes.some((n) => n.startsWith("확인:")) && <ul className="space-y-1 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
          {answer.reviewNotes.filter((n) => n.startsWith("확인:")).map((n, i) => <li key={i}>{n}</li>)}
        </ul>}
        {answer.reviewNotes.some((n) => !n.startsWith("확인:")) && <details className="text-xs text-gray-500"><summary className="cursor-pointer">문체 점검</summary><div className="mt-2 space-y-1">{answer.reviewNotes.filter((n) => !n.startsWith("확인:")).map((n, i) => <p key={i}>{n}</p>)}{answer.evidenceStale && <p className="text-amber-700">이전 글을 점검한 결과라 지금 글과 다를 수 있습니다. 저장하면 다시 점검합니다.</p>}</div></details>}
        {answer.answer && <div className="flex flex-wrap items-center gap-3 text-xs">
          <button type="button" disabled={essayBusy || finalCurrent} className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 font-medium text-emerald-700 transition hover:bg-emerald-100 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
            title="지금 글을 과거 자소서 자료에 저장합니다. 같은 문항을 다시 저장하면 새 글로 바뀝니다." onClick={() => void saveFinal(answer.question)}>
            {busy === "final" ? "저장 중..." : final ? "최종본 다시 저장" : "최종본으로 저장"}
          </button>
          <button disabled={essayBusy} className="text-gray-500" onClick={() => run("copy", async () => { await navigator.clipboard.writeText(answer.answer); setNotice("답변을 복사했습니다."); })}>답변 복사</button>
        </div>}
        <EssayReviewTools answer={answer} disabled={essayBusy} reviewing={reviewBusy} error={answerErrors[answer.question] || undefined}
          highlight={highlightQuestion === answer.question}
          onReview={(focus) => startReview(answer.question, focus)}
          onAction={(action) => void answerAction(answer.question, action)} />
      </section>;
    })}
    {!!legacyAnswers.length && <details className="rounded-lg border border-gray-200 p-3"><summary className="text-xs text-gray-500 cursor-pointer">이전 방식으로 작성한 답변 {legacyAnswers.length}개 보관됨</summary><p className="my-2 text-xs text-gray-400">자동으로 만든 공통 답변입니다. 실제 문항에 대한 새 답변과 구분해 보관합니다.</p>{legacyAnswers.map(({ a, index }) => <div key={index} className="mt-3"><p className="text-xs font-medium mb-1">{a.question}</p><textarea aria-label={`이전 답변 ${a.question}`} rows={5} value={a.answer} className={inputStyle} onChange={(e) => editAnswer(index, e.target.value)} disabled={essayBusy} /></div>)}</details>}
    {draft && <button className={buttonStyle} disabled={essayBusy || !dirty} onClick={() => run("save", async () => { await save(); setNotice("수정한 답변을 저장했습니다."); })}>{busy === "save" ? "저장 중..." : dirty ? "수정한 답변 저장" : "답변 저장됨"}</button>}
    </>}
  </div>;
}
