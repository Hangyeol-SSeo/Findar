"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Kind = "cover_letter" | "interview";
const KIND_LABEL: Record<Kind, string> = { cover_letter: "자기소개서", interview: "면접 대본" };
// 받침에 따라 달라지는 조사: 자기소개서를/로, 면접 대본을/으로.
const KIND_OBJECT: Record<Kind, string> = { cover_letter: "자기소개서를", interview: "면접 대본을" };
const KIND_AS: Record<Kind, string> = { cover_letter: "자기소개서로", interview: "면접 대본으로" };

interface SourceEntry { id: string; company: string; question: string; answer: string; context: string; verbatim: boolean | null }
interface SourceFile {
  kind: Kind; name: string; size: number; uploadedAt: number;
  status: "not-analyzed" | "stale" | "failed" | "ready";
  entryCount: number; analyzedAt: number | null; error: string; entries: SourceEntry[];
}
interface SourceState {
  files: SourceFile[];
  progress: { running: boolean; done: number; total: number; current: string };
}

const STATUS_TEXT: Record<SourceFile["status"], { label: string; style: string }> = {
  "not-analyzed": { label: "분석 전", style: "bg-amber-100 text-amber-800" },
  stale: { label: "다시 분석 필요", style: "bg-amber-100 text-amber-800" },
  failed: { label: "분석 실패", style: "bg-red-100 text-red-700" },
  ready: { label: "분석 완료", style: "bg-emerald-100 text-emerald-800" },
};

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export default function EssaySourceUploadForm({ showToast }: { showToast: (msg: string) => void }) {
  const [state, setState] = useState<SourceState | null>(null);
  const [kind, setKind] = useState<Kind>("cover_letter");
  const [busy, setBusy] = useState<"" | "upload" | "paste" | "analyze" | "delete">("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteText, setPasteText] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const wasRunning = useRef(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/essay-sources", { cache: "no-store" });
    const body = await res.json();
    if (body.files) setState(body);
    return body as SourceState;
  }, []);

  useEffect(() => {
    load().catch(() => setError("과거 자료 목록을 불러오지 못했습니다."));
  }, [load]);

  // 분석은 서버에서 백그라운드로 돈다. 도는 동안만 진행 상황을 다시 읽는다.
  const running = !!state?.progress.running;
  useEffect(() => {
    if (!running) {
      if (wasRunning.current) {
        wasRunning.current = false;
        const failed = state?.files.filter((f) => f.status === "failed").length ?? 0;
        showToast(failed ? `분석을 마쳤습니다 · ${failed}개 파일은 실패했습니다` : "과거 자료 분석을 마쳤습니다");
      }
      return;
    }
    wasRunning.current = true;
    const timer = setInterval(() => { load().catch(() => {}); }, 3000);
    return () => clearInterval(timer);
  }, [running, load, showToast, state?.files]);

  const apply = useCallback((res: Response, body: SourceState & { saved?: string[]; errors?: string[]; error?: string }) => {
    if (body.files) setState(body);
    if (body.errors?.length) setError(body.errors.join("\n"));
    else if (!res.ok) setError(body.error || "저장하지 못했습니다.");
    return body.saved?.length ?? 0;
  }, []);

  const upload = useCallback(async (list: FileList | File[]) => {
    const files = Array.from(list);
    if (!files.length) return;
    setBusy("upload");
    setError("");
    try {
      const form = new FormData();
      form.append("kind", kind);
      files.forEach((f) => form.append("files", f));
      const res = await fetch("/api/essay-sources", { method: "POST", body: form });
      const saved = apply(res, await res.json());
      if (saved) showToast(`${KIND_LABEL[kind]} ${saved}개를 올렸습니다`);
    } catch {
      setError("업로드에 실패했습니다.");
    } finally {
      setBusy("");
      if (inputRef.current) inputRef.current.value = "";
    }
  }, [kind, apply, showToast]);

  async function savePaste() {
    setBusy("paste");
    setError("");
    try {
      const res = await fetch("/api/essay-sources", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, title: pasteTitle, text: pasteText }),
      });
      if (apply(res, await res.json())) {
        setPasteTitle(""); setPasteText("");
        showToast(`${KIND_OBJECT[kind]} 저장했습니다`);
      }
    } catch {
      setError("저장하지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  async function remove(file: SourceFile) {
    if (!window.confirm(`${file.name} 파일을 삭제할까요? 이 파일에서 추출한 ${file.entryCount}개 항목도 더 이상 쓰이지 않습니다.`)) return;
    setBusy("delete");
    setError("");
    try {
      const res = await fetch(`/api/essay-sources?kind=${file.kind}&name=${encodeURIComponent(file.name)}`, { method: "DELETE" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setState(body);
      showToast("삭제했습니다");
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "삭제에 실패했습니다.");
    } finally {
      setBusy("");
    }
  }

  async function analyze(retryFailed = false) {
    setBusy("analyze");
    setError("");
    try {
      const res = await fetch("/api/essay-sources/analyze", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ retryFailed }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setState(body);
      if (!body.progress?.running) showToast("새로 분석할 파일이 없습니다");
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "분석을 시작하지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  if (!state) return error ? <p className="text-sm text-red-600">{error}</p> : <p className="text-sm text-gray-400">불러오는 중...</p>;

  const needsAnalysis = state.files.some((f) => f.status === "not-analyzed" || f.status === "stale");
  const hasFailed = state.files.some((f) => f.status === "failed");
  const { progress } = state;

  return (
    <div className="space-y-4">
      <div className="flex gap-2" role="radiogroup" aria-label="올릴 자료 종류">
        {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
            className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${kind === k ? "border-blue-500 bg-blue-50 font-medium text-blue-700" : "border-gray-200 text-gray-500 hover:text-gray-700"}`}>
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); void upload(e.dataTransfer.files); }}
        className={`rounded-xl border-2 border-dashed p-6 text-center transition-colors ${dragging ? "border-blue-400 bg-blue-50" : "border-gray-200 bg-white"}`}
      >
        <input ref={inputRef} type="file" multiple className="hidden" aria-label={`${KIND_LABEL[kind]} 파일 선택`}
          accept=".pdf,.txt,.md,.docx,.hwpx,application/pdf,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={(e) => e.target.files && upload(e.target.files)} />
        <p className="text-sm text-gray-600">{KIND_LABEL[kind]} 파일을 여기로 끌어다 놓거나</p>
        <button type="button" onClick={() => inputRef.current?.click()} disabled={!!busy}
          className="mt-3 rounded-lg border border-blue-300 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-40">
          {busy === "upload" ? "올리는 중..." : "파일 선택"}
        </button>
        <p className="mt-3 text-xs text-gray-400">
          PDF · TXT · MD · DOCX · HWPX · 파일당 20MB · 종류별 최대 30개 · 같은 이름이면 교체됩니다. HWP는 PDF나 HWPX로 저장해 올려주세요.
          파일은 이 컴퓨터의 data/essay-sources 폴더에만 저장됩니다.
        </p>
      </div>

      <details className="rounded-xl border border-gray-100 bg-white p-4">
        <summary className="cursor-pointer text-sm font-medium text-gray-700">텍스트로 붙여넣기</summary>
        <div className="mt-3 space-y-2">
          <input value={pasteTitle} onChange={(e) => setPasteTitle(e.target.value)} placeholder="제목 (예: OO증권 1차 면접 준비)"
            className="w-full rounded-lg border border-gray-200 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200" />
          <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} rows={8}
            placeholder={kind === "interview" ? "Q. 질문\nA. 답변 형식이면 가장 정확하게 나뉩니다." : "문항과 답변을 그대로 붙여넣어 주세요."}
            className="w-full rounded-lg border border-gray-200 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200" />
          <button type="button" onClick={savePaste} disabled={!!busy || !pasteText.trim()}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40">
            {busy === "paste" ? "저장 중..." : `${KIND_AS[kind]} 저장`}
          </button>
        </div>
      </details>

      {error && <p role="alert" className="whitespace-pre-line rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <div className="rounded-xl border border-gray-100 bg-white p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-gray-700">올린 자료</h3>
          <div className="flex flex-wrap items-center gap-2">
            {progress.running && (
              <span className="text-xs text-gray-500" aria-live="polite">
                분석 중 {Math.min(progress.done + 1, progress.total)}/{progress.total}{progress.current && ` · ${progress.current}`}
              </span>
            )}
            {hasFailed && !progress.running && (
              <button onClick={() => analyze(true)} disabled={!!busy}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40">
                실패한 파일 다시 분석
              </button>
            )}
            {state.files.length > 0 && (
              <button onClick={() => analyze()} disabled={!!busy || progress.running || !needsAnalysis}
                title={!needsAnalysis ? "새로 올리거나 바뀐 파일이 없습니다" : undefined}
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40">
                {progress.running ? "분석 중..." : "지금 분석"}
              </button>
            )}
          </div>
        </div>

        {state.files.length === 0 ? (
          <p className="text-sm text-gray-400">아직 올린 자료가 없습니다.</p>
        ) : (
          (Object.keys(KIND_LABEL) as Kind[]).map((k) => {
            const files = state.files.filter((f) => f.kind === k);
            if (!files.length) return null;
            return (
              <section key={k} className="space-y-1">
                <h4 className="text-xs font-semibold text-gray-500">{KIND_LABEL[k]} {files.length}개</h4>
                <ul className="divide-y divide-gray-100">
                  {files.map((f) => {
                    const status = STATUS_TEXT[f.status];
                    const unverified = f.entries.filter((e) => e.verbatim === false).length;
                    return (
                      <li key={`${f.kind}/${f.name}`} className="py-2">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm text-gray-800">{f.name}</p>
                            <p className="text-xs text-gray-400">
                              {formatSize(f.size)} · {new Date(f.uploadedAt).toLocaleDateString("ko-KR")}
                              <span className={`ml-2 rounded px-1.5 py-0.5 font-medium ${status.style}`}>
                                {status.label}{f.status === "ready" && ` · ${f.entryCount}개 항목`}
                              </span>
                            </p>
                            {f.error && <p className="mt-1 text-xs text-red-600">{f.error}</p>}
                          </div>
                          <button onClick={() => remove(f)} disabled={!!busy || progress.running}
                            className="shrink-0 text-xs text-gray-400 hover:text-red-600 disabled:opacity-40">삭제</button>
                        </div>
                        {f.entries.length > 0 && (
                          <details className="mt-2 text-xs">
                            <summary className="cursor-pointer text-gray-500">
                              추출한 {k === "interview" ? "질문·답변" : "문항·답변"} 보기
                              {unverified > 0 && <span className="ml-1 text-amber-700">· {unverified}개는 원문과 달라 확인 필요</span>}
                            </summary>
                            <ol className="mt-2 space-y-3">
                              {f.entries.map((e) => (
                                <li key={e.id} className="rounded-lg bg-gray-50 p-3">
                                  <p className="font-medium text-gray-700">{e.question || "(문항 없음)"}</p>
                                  {(e.company || e.context) && <p className="mt-0.5 text-gray-400">{[e.company, e.context].filter(Boolean).join(" · ")}</p>}
                                  <p className="mt-2 whitespace-pre-wrap leading-5 text-gray-600">{e.answer}</p>
                                  {e.verbatim === false && <p className="mt-1 text-amber-700">원문과 글자가 다르게 옮겨졌습니다. 원본 파일과 비교해 확인해주세요.</p>}
                                </li>
                              ))}
                            </ol>
                          </details>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })
        )}

        <p className="text-xs leading-5 text-gray-400">
          분석은 파일마다 한 번만 돌고, 새로 올리거나 바뀐 파일만 다시 분석합니다. 지금 분석하지 않아도 다음 자기소개서 작성 때 자동으로 분석됩니다.
          문항·답변은 요약하지 않고 원문 그대로 옮겨 자기소개서 작성의 참고 자료로 씁니다.
        </p>
      </div>
    </div>
  );
}
