"use client";

import { useState, useEffect, useRef } from "react";
import { characterCount, type EssayAnswer } from "@/lib/essay-contract";
import { FREEFORM_ESSAY_QUESTION } from "@/lib/essay-questions";
import type { ApplicationDraft } from "@/lib/application-draft";
import type { SubmissionMethodInfo } from "@/lib/application-method";

const inputStyle = "w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200";
const buttonStyle = "rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40";

interface QuestionRow { id: string; question: string; maxChars: string; countSpaces: boolean; guidance: string; freeform: boolean }
function newRow(id: string): QuestionRow {
  return { id, question: "", maxChars: "", countSpaces: true, guidance: "", freeform: false };
}

export default function ApplicationDraftPanel({ seq, companyName }: { seq: string; companyName: string }) {
  const [workspace, setWorkspace] = useState<"essay" | "fill">("essay");
  const [draft, setDraft] = useState<ApplicationDraft | null>(null);
  const [method, setMethod] = useState<SubmissionMethodInfo | null>(null);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false);
  const nextRowId = useRef(1);
  const [rows, setRows] = useState<QuestionRow[]>(() => [newRow("q0")]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
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
      setDraft(data.draft); setMethod(data.submissionMethod); setUrl(data.siteUrl || "");
    }).catch((e) => { if (!abort.signal.aborted) setError(e.message); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    const receive = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== location.origin) return;
      if (event.data?.type === "FINDAR_READY") setExtension(true);
      if (event.data?.type === "FINDAR_CONNECTED") {
        setBusy("");
        if (event.data.error) setError(event.data.error);
        else setNotice("지원 사이트를 열었습니다. 실제 지원서로 이동한 뒤 확장 기능의 ‘현재 양식 채우기’를 눌러주세요.");
      }
    };
    window.addEventListener("message", receive);
    window.postMessage({ type: "FINDAR_PING" }, location.origin);
    return () => { abort.abort(); window.removeEventListener("message", receive); };
  }, [seq]);

  async function api(path: string, body: unknown, method = "POST") {
    const response = await fetch(`/api/applications/${seq}/${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.current?.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "요청에 실패했습니다.");
    return data;
  }
  async function save() {
    if (!draft || !dirty) return;
    const data = await api("draft", draft, "PUT");
    setDraft(data.draft); setDirty(false);
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

  // 문항이 여러 개면 한 번에 순서대로 작성한다 — 병렬로 돌리지 않는 이유는, 뒤 문항이
  // collectContext에서 앞 문항의 저장된 답변을 otherAnswers로 보고 같은 경험을 피해야
  // 하기 때문이다(병렬로 돌리면 서로의 결과를 못 봐서 같은 에피소드가 겹칠 수 있다).
  // 대신 문항마다 근거 검증·편집 검토를 그대로 거치므로 지원자를 관통하는 톤은 유지된다.
  async function generateAll() {
    const filled = rows.filter((r) => r.question.trim());
    if (!filled.length) return;
    await run("writing", async () => {
      await save();
      let needsInfo = 0;
      try {
        for (let i = 0; i < filled.length; i++) {
          setProgress({ done: i, total: filled.length });
          const row = filled[i];
          const data = await api("draft/question", {
            question: row.question,
            ...(row.maxChars ? { maxChars: Number(row.maxChars) } : {}),
            countSpaces: row.countSpaces,
            guidance: row.guidance,
          });
          setDraft(data.draft); setDirty(false);
          if (data.answer.status === "needs_info") needsInfo++;
        }
      } finally { setProgress(null); }
      setRows([newRow(`q${nextRowId.current++}`)]);
      const summary = filled.length > 1
        ? `문항 ${filled.length}개의 답변을 순서대로 작성하고 저장했습니다.`
        : "문항별 답변을 작성하고 저장했습니다.";
      setNotice(needsInfo > 0 ? `${summary} 이 중 ${needsInfo}개는 경험 보완이 필요합니다 — 아래에서 확인해주세요.` : summary);
    });
  }
  function editAnswer(index: number, answer: string) {
    setDraft((prev) => prev ? { ...prev, essayAnswers: prev.essayAnswers.map((a, i) => i === index ? { ...a, answer } : a) } : prev);
    setDirty(true);
  }
  async function fillDocument() {
    if (!file) return;
    await run("document", async () => {
      const form = new FormData(); form.append("file", file);
      const response = await fetch(`/api/applications/${seq}/fill/document`, { method: "POST", body: form, signal: controller.current?.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setDocumentResult({ href: data.downloadUrl, filename: data.filename, filled: data.filled, skipped: data.skipped, note: data.note });
    });
  }
  if (loading) return <p className="py-8 text-center text-sm text-gray-400">지원 정보를 불러오는 중...</p>;
  const currentAnswers = draft?.essayAnswers.map((a, index) => ({ a, index })).filter(({ a }) => a.source === "user_question") ?? [];
  const legacyAnswers = draft?.essayAnswers.map((a, index) => ({ a, index })).filter(({ a }) => a.source !== "user_question") ?? [];

  return <div className="space-y-6">
    <nav aria-label="지원 도우미 작업" className="flex gap-2 rounded-lg bg-gray-100 p-1">
      {([['essay', '문항별 자기소개서'], ['fill', '지원서 자동 입력']] as const).map(([value, label]) => <button key={value} disabled={!!busy} onClick={() => { setWorkspace(value); setError(""); setNotice(""); }} aria-pressed={workspace === value} className={`flex-1 rounded-md px-3 py-2 text-sm ${workspace === value ? "bg-white font-semibold text-blue-700 shadow-sm" : "text-gray-500"}`}>{label}</button>)}
    </nav>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    {notice && <p role="status" className="rounded-lg bg-blue-50 p-3 text-sm text-blue-800">{notice}</p>}
    {workspace === "fill" && <section className="rounded-xl border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2"><h3 className="font-semibold text-gray-800">지원서에 개인정보 입력</h3><a className="text-xs text-blue-600 underline" href="/settings">저장 정보 수정</a></div>
      <p className="text-xs leading-5 text-gray-500">설정에 저장한 정보를 실제 양식의 빈칸에 채웁니다. 입력 결과를 확인한 뒤 제출해주세요.</p>
      {!!method?.templateAttachments.length && <div className="flex flex-wrap gap-2">{method.templateAttachments.map((a) => <a key={a.url} href={a.url} target="_blank" rel="noreferrer" className="text-xs text-blue-600 underline">{a.name} 내려받기</a>)}</div>}
      <div className="rounded-lg bg-gray-50 p-3 space-y-2">
        <h4 className="text-sm font-medium">Word 양식 작성</h4>
        <p className="text-xs text-gray-500">DOCX 양식의 표 입력칸을 채우고 원본 형식을 유지한 작성본을 만듭니다. DOC·HWP는 DOCX로 변환해서 올려주세요.</p>
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-3 space-y-2">
          <input ref={fileInputRef} aria-label="Word 지원서 양식" type="file" accept=".docx" disabled={!!busy} onChange={(e) => { setFile(e.target.files?.[0] ?? null); setDocumentResult(null); }} className="hidden" />
          <button type="button" disabled={!!busy} onClick={() => fileInputRef.current?.click()} className="inline-flex items-center gap-2 rounded-lg border border-blue-300 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-100 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-40">
            <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 7h7l2 2h9v10H3z" /><path d="M3 7V5h7l2 2" /></svg>
            {file ? "다른 Word 파일 선택" : "Word 파일 선택"}
          </button>
          <p className="break-all text-xs text-gray-600" aria-live="polite">{file ? file.name : "선택한 파일이 없습니다. DOCX 양식을 선택해주세요."}</p>
        </div>
        <button className={buttonStyle} disabled={!!busy || !file} onClick={fillDocument}>{busy === "document" ? "양식 작성 중..." : "개인정보 채운 Word 만들기"}</button>
        {documentResult && <div className="text-xs space-y-2"><a className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700" href={documentResult.href} download={documentResult.filename}>작성본 다운로드</a><p className="break-all">{documentResult.filename} · {documentResult.filled}칸 입력 · 30분 동안 다운로드 가능</p><p className="text-gray-500">{documentResult.note}</p>{documentResult.skipped.length > 0 && <details><summary>직접 확인할 항목 {documentResult.skipped.length}개</summary>{documentResult.skipped.map((s, i) => <p key={i}>{s.label}: {s.reason}</p>)}</details>}</div>}
      </div>
      <div className="rounded-lg bg-gray-50 p-3 space-y-2">
        <h4 className="text-sm font-medium">Brave · Chrome 웹 지원서 입력</h4>
        <label className="block text-xs text-gray-500">지원 사이트 주소<input aria-label="지원 사이트 주소" type="url" className={`${inputStyle} mt-1`} value={url} onChange={(e) => setUrl(e.target.value)} disabled={!!busy} placeholder="https://..." /></label>
        {!extension && <details className="text-xs text-gray-600" open><summary className="cursor-pointer font-medium">처음 한 번 브라우저 연결하기</summary><ol className="list-decimal pl-4 space-y-1 mt-2"><li><a className="text-blue-600 underline" href="/api/application-fill/extension">Findar 확장 기능 다운로드</a> 후 압축을 풉니다.</li><li>Brave의 확장 프로그램 관리에서 개발자 모드를 켜고 ‘압축해제된 확장 프로그램을 로드합니다’로 해당 폴더를 선택합니다.</li><li>이 페이지를 새로고침합니다. Chrome도 같은 방식으로 설치합니다.</li></ol></details>}
        <button className={buttonStyle} disabled={!!busy || !extension || !/^https?:\/\//.test(url)} onClick={() => run("web", async () => {
          const data = await api("fill/web", {});
          window.postMessage({ type: "FINDAR_CONNECT", token: data.token, seq, url }, location.origin);
          setNotice("브라우저 연결 요청을 보냈습니다. 열린 지원서에서 확장 기능을 실행해주세요.");
        })}>웹 지원서 연결</button>
        <p className="text-xs text-gray-500">실제 지원서 페이지에서 확장 기능의 ‘현재 양식 채우기’를 실행합니다. 입력된 값과 채우지 못한 항목을 확인할 수 있습니다.</p>
      </div>
    </section>}

    {workspace === "essay" && <><section className="space-y-3">
      <div><h3 className="font-semibold text-gray-800">실제 문항에 맞춰 자기소개서 작성</h3><p className="mt-1 text-xs leading-5 text-gray-500">문항의 의도에 맞는 경험을 고르고, 판단과 행동이 드러나도록 작성합니다. 학교·프로젝트·창업 팀명은 본문에서 제외합니다. 문항이 여러 개면 ‘문항 추가’로 늘려서 순서대로 작성할 수 있습니다 — 앞서 작성한 문항의 답변을 참고해 같은 경험을 반복하지 않습니다.</p></div>
      {rows.map((row, i) => <div key={row.id} className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-1.5 text-xs text-gray-600"><input type="checkbox" checked={row.freeform} disabled={!!busy} onChange={(e) => toggleFreeform(row.id, e.target.checked)} />자유 문항</label>
          {rows.length > 1 && <button type="button" disabled={!!busy} className="text-xs text-gray-400 hover:text-red-500" onClick={() => removeRow(row.id)}>삭제</button>}
        </div>
        <label className="block text-xs font-medium text-gray-700">지원서 문항<textarea className={`${inputStyle} mt-1`} rows={4} value={row.question} maxLength={8000} disabled={!!busy} onChange={(e) => {
          updateRow(row.id, { question: e.target.value, countSpaces: /공백\s*제외/.test(e.target.value) ? false : row.countSpaces });
        }} placeholder={`문항 ${i + 1} — 실제 지원서에서 묻는 문항을 그대로 붙여넣어주세요. 하위 질문과 작성 조건도 함께 넣어주세요.`} /></label>
        <div className="flex items-center gap-4"><label className="text-xs text-gray-600">최대 글자 수<input aria-label={`문항 ${i + 1} 최대 글자 수`} className={`${inputStyle} mt-1 max-w-40`} type="number" min={1} max={10000} value={row.maxChars} onChange={(e) => updateRow(row.id, { maxChars: e.target.value })} disabled={!!busy} placeholder="문항에 있으면 자동 반영" /></label><label className="text-xs text-gray-600 flex items-center gap-2"><input type="checkbox" checked={row.countSpaces} onChange={(e) => updateRow(row.id, { countSpaces: e.target.checked })} disabled={!!busy} />공백 포함</label></div>
        <label className="block text-xs text-gray-600">이번 문항의 추가 경험·수정 요청 <span className="text-gray-400">(선택)</span><textarea className={`${inputStyle} mt-1`} rows={3} maxLength={6000} value={row.guidance} onChange={(e) => updateRow(row.id, { guidance: e.target.value })} disabled={!!busy} placeholder="쓸 경험의 구체적인 사실, 강조할 판단, 빼고 싶은 내용 등을 적어주세요." /></label>
      </div>)}
      <div className="flex items-center gap-2">
        <button type="button" disabled={!!busy} className="rounded-lg bg-gray-100 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-200 disabled:opacity-40" onClick={addRow}>+ 문항 추가</button>
        <button className={buttonStyle} disabled={!!busy || !rows.some((r) => r.question.trim())} onClick={generateAll}>
          {busy === "writing"
            ? (progress ? `문항 ${progress.done + 1}/${progress.total} 작성 중...` : "문항 분석 · 작성 · 편집 검토 중...")
            : rows.filter((r) => r.question.trim()).length > 1 ? "문항 전체 답변 작성" : "이 문항 답변 작성"}
        </button>
      </div>
      {busy === "writing" && <p className="text-xs text-gray-500" role="status">저장된 경험의 근거를 확인하고 별도 편집 검토를 진행합니다{rows.filter((r) => r.question.trim()).length > 1 ? " — 문항마다 순서대로 작성되어 시간이 오래 걸릴 수 있습니다" : ""}. 잠시 기다려주세요.</p>}
    </section>
    {currentAnswers.map(({ a, index }) => {
      const answer = a as EssayAnswer;
      const count = characterCount(answer.answer, answer.countSpaces);
      return <section key={index} className="rounded-xl border border-gray-200 p-4 space-y-3">
        <h4 className="whitespace-pre-wrap text-sm font-semibold text-gray-800">{answer.question}</h4>
        <p className="text-xs leading-5 text-gray-500">{answer.intent}</p>
        {answer.status === "needs_info" ? <div className="bg-amber-50 p-3 rounded-lg text-sm text-amber-800"><p className="font-medium">답변에 필요한 경험을 보완해주세요</p><ul className="mt-2 list-disc pl-4">{answer.missingInfo.map((info, i) => <li key={i}>{info}</li>)}</ul></div> : <>
          <textarea aria-label={`${answer.question} 답변`} className={inputStyle} rows={12} value={answer.answer} onChange={(e) => editAnswer(index, e.target.value)} disabled={!!busy} />
          <p className={`text-xs ${answer.maxChars && count > answer.maxChars ? "text-red-600" : "text-gray-400"}`}>{count.toLocaleString()}자{answer.maxChars ? ` / ${answer.maxChars.toLocaleString()}자` : ""} · 공백 {answer.countSpaces ? "포함" : "제외"}{dirty ? " · 수정 내용 저장 필요" : ""}</p>
        </>}
        <details className="text-xs text-gray-500"><summary className="cursor-pointer">사용한 근거와 검토 사항</summary><div className="mt-2 space-y-2">{answer.evidence.map((e, i) => <div key={i}><p className="font-medium">{e.usedFor}</p><blockquote className="whitespace-pre-wrap border-l-2 pl-2 mt-1">{e.quote}</blockquote><p className="text-gray-400">{e.sourceId}</p></div>)}{answer.reviewNotes.map((n, i) => <p key={i}>{n}</p>)}<p>직접 고친 문장은 위 생성 시점의 근거 검토에 포함되지 않습니다.</p></div></details>
        <div className="flex flex-wrap gap-3 text-xs">
          <button disabled={!!busy} className="text-blue-600 disabled:opacity-40" onClick={() => {
            setRows([{ id: `q${nextRowId.current++}`, question: answer.question, maxChars: answer.maxChars?.toString() ?? "", countSpaces: answer.countSpaces, guidance: answer.guidance, freeform: false }]);
            setNotice("위 문항 입력란에서 경험이나 수정 요청을 보완한 뒤 다시 작성해주세요.");
          }}>이 문항 보완해서 다시 작성</button>
          {answer.answer && <><button disabled={!!busy} className="text-gray-500" onClick={() => run("copy", async () => { await navigator.clipboard.writeText(answer.answer); setNotice("답변을 복사했습니다."); })}>답변 복사</button><button disabled={!!busy} className="text-gray-500" onClick={() => run("bank", async () => {
            await save();
            const response = await fetch("/api/essay-bank", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ company: companyName, question: answer.question, answer: answer.answer }), signal: controller.current?.signal });
            if (!response.ok) throw new Error("확정 답변을 경험 자료로 저장하지 못했습니다.");
            setNotice("검토한 답변을 다음 작성에 참고할 자료로 저장했습니다.");
          })}>검토한 답변을 자료로 저장</button></>}
        </div>
      </section>;
    })}
    {!!legacyAnswers.length && <details className="rounded-lg border border-gray-200 p-3"><summary className="text-xs text-gray-500 cursor-pointer">이전 방식으로 작성한 답변 {legacyAnswers.length}개 보관됨</summary><p className="my-2 text-xs text-gray-400">자동으로 만든 공통 답변입니다. 실제 문항에 대한 새 답변과 구분해 보관합니다.</p>{legacyAnswers.map(({ a, index }) => <div key={index} className="mt-3"><p className="text-xs font-medium mb-1">{a.question}</p><textarea aria-label={`이전 답변 ${a.question}`} rows={5} value={a.answer} className={inputStyle} onChange={(e) => editAnswer(index, e.target.value)} disabled={!!busy} /></div>)}</details>}
    {draft && <button className={buttonStyle} disabled={!!busy || !dirty} onClick={() => run("save", async () => { await save(); setNotice("수정한 답변을 저장했습니다."); })}>{busy === "save" ? "저장 중..." : dirty ? "수정한 답변 저장" : "답변 저장됨"}</button>}
    </>}
  </div>;
}
