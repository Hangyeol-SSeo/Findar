"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface ResumeFileInfo {
  name: string;
  size: number;
  uploadedAt: number;
}

interface ResumeState {
  files: ResumeFileInfo[];
  status: "missing" | "not-analyzed" | "stale" | "ready";
  analyzing: boolean;
  profile: { name: string; experienceYears: string; skills: string[]; domains: string[]; generatedAt: number } | null;
}

const STATUS_TEXT: Record<ResumeState["status"], { label: string; style: string }> = {
  missing: { label: "이력서 없음", style: "bg-gray-100 text-gray-600" },
  "not-analyzed": { label: "분석 전", style: "bg-amber-100 text-amber-800" },
  stale: { label: "파일 또는 모델 변경됨 · 재분석 필요", style: "bg-amber-100 text-amber-800" },
  ready: { label: "분석 완료", style: "bg-emerald-100 text-emerald-800" },
};

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export default function ResumeUploadForm({ showToast }: { showToast: (msg: string) => void }) {
  const [state, setState] = useState<ResumeState | null>(null);
  const [busy, setBusy] = useState<"" | "upload" | "analyze" | "delete">("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    fetch("/api/profile/resume", { cache: "no-store" })
      .then((r) => r.json())
      .then(setState)
      .catch(() => setError("이력서 정보를 불러오지 못했습니다."));
  }, []);

  const upload = useCallback(
    async (list: FileList | File[]) => {
      const files = Array.from(list);
      if (files.length === 0) return;
      setBusy("upload");
      setError("");
      try {
        const form = new FormData();
        files.forEach((f) => form.append("files", f));
        const res = await fetch("/api/profile/resume", { method: "POST", body: form });
        const body = await res.json();
        if (body.files) setState(body);
        if (body.errors?.length) setError(body.errors.join("\n"));
        else if (!res.ok) setError(body.error || "업로드에 실패했습니다.");
        if (body.saved?.length) showToast(`${body.saved.length}개 파일을 올렸습니다`);
      } catch {
        setError("업로드에 실패했습니다.");
      } finally {
        setBusy("");
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [showToast]
  );

  async function remove(name: string) {
    if (!window.confirm(`${name} 파일을 삭제할까요?`)) return;
    setBusy("delete");
    setError("");
    try {
      const res = await fetch(`/api/profile/resume?name=${encodeURIComponent(name)}`, { method: "DELETE" });
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

  async function analyze() {
    setBusy("analyze");
    setError("");
    try {
      const res = await fetch("/api/profile/resume/analyze", { method: "POST" });
      const body = await res.json();
      if (body.files) setState(body);
      if (!res.ok) throw new Error(body.error);
      showToast(body.result === "cached" ? "이미 최신 분석 결과입니다" : "이력서 분석을 마쳤습니다");
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "이력서 분석에 실패했습니다.");
    } finally {
      setBusy("");
    }
  }

  if (!state) {
    return error ? <p className="text-sm text-red-600">{error}</p> : <p className="text-sm text-gray-400">불러오는 중...</p>;
  }

  const status = STATUS_TEXT[state.status];
  const analyzing = busy === "analyze" || state.analyzing;

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); void upload(e.dataTransfer.files); }}
        className={`rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
          dragging ? "border-blue-400 bg-blue-50" : "border-gray-200 bg-white"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="hidden"
          aria-label="이력서 PDF 선택"
          onChange={(e) => e.target.files && upload(e.target.files)}
        />
        <p className="text-sm text-gray-600">이력서·포트폴리오 PDF를 여기로 끌어다 놓거나</p>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={!!busy}
          className="mt-3 rounded-lg border border-blue-300 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-40"
        >
          {busy === "upload" ? "올리는 중..." : "파일 선택"}
        </button>
        <p className="mt-3 text-xs text-gray-400">
          PDF만 · 파일당 20MB · 최대 10개 · 같은 이름으로 올리면 교체됩니다. 파일은 이 컴퓨터의 data/resume 폴더에만 저장됩니다.
        </p>
      </div>

      {error && <p role="alert" className="whitespace-pre-line rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <div className="rounded-xl border border-gray-100 bg-white p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-gray-700">올린 파일</h3>
            <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${status.style}`}>
              {analyzing ? "분석 중..." : status.label}
            </span>
          </div>
          {state.files.length > 0 && (
            <button
              onClick={analyze}
              disabled={!!busy || state.analyzing || state.status === "ready"}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
              title={state.status === "ready" ? "파일과 분석 모델이 바뀌지 않아 다시 분석할 필요가 없습니다" : undefined}
            >
              {analyzing ? "분석 중... (1~2분)" : "지금 분석"}
            </button>
          )}
        </div>

        {state.files.length === 0 ? (
          <p className="text-sm text-gray-400">아직 올린 파일이 없습니다.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {state.files.map((f) => (
              <li key={f.name} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm text-gray-800">{f.name}</p>
                  <p className="text-xs text-gray-400">
                    {formatSize(f.size)} · {new Date(f.uploadedAt).toLocaleDateString("ko-KR")}
                  </p>
                </div>
                <button
                  onClick={() => remove(f.name)}
                  disabled={!!busy}
                  className="shrink-0 text-xs text-gray-400 hover:text-red-600 disabled:opacity-40"
                >
                  삭제
                </button>
              </li>
            ))}
          </ul>
        )}

        <p className="text-xs leading-5 text-gray-400">
          분석은 파일이나 분석 모델이 바뀌면 다시 실행됩니다. 지금 분석하지 않아도 다음 공고 새로고침 때 자동으로 분석되고, 매칭 점수도
          새 이력서 기준으로 다시 계산됩니다.
        </p>

        {state.profile && state.status !== "missing" && (
          <div className="rounded-lg bg-gray-50 p-3 text-sm">
            <p className="font-medium text-gray-700">
              {state.profile.name || "이름 미확인"}
              {state.profile.experienceYears && <span className="font-normal text-gray-500"> · {state.profile.experienceYears}</span>}
            </p>
            {state.profile.skills.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {state.profile.skills.slice(0, 20).map((s) => (
                  <span key={s} className="rounded bg-white px-1.5 py-0.5 text-xs text-gray-600 border border-gray-100">{s}</span>
                ))}
              </div>
            )}
            <p className="mt-2 text-xs text-gray-400">
              {new Date(state.profile.generatedAt).toLocaleString("ko-KR")} 분석
              {state.status === "stale" && " · 현재 파일 또는 모델 설정과 다른 이전 분석 결과입니다"}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
