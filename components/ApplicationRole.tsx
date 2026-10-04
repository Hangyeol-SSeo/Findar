"use client";
import { useEffect, useId, useRef, useState } from "react";

// 공고 패널 헤더의 "지원 직무" 칩. 평소에는 한 줄 칩으로만 보이고, 누르면 아래에 떠 있는 편집 창이 열린다 —
// 본문(자기소개서 등) 위에 겹쳐 뜨므로 항상 자리를 차지하지 않는다.
export default function ApplicationRole({ seq, positions, onSaved }: {
  seq: string; positions: string[]; onSaved: (revision: string) => void;
}) {
  const id = useId();
  const [saved, setSaved] = useState<{ role: string; revision: string } | null>(null);
  const [role, setRole] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/applications/${seq}/role`, { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        if (controller.signal.aborted) return;
        setSaved(data); setRole(data.role); onSaved(data.revision);
      }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [seq, onSaved]);
  // 편집 창 밖을 누르거나 Esc를 누르면 저장하지 않은 입력을 되돌리고 닫는다.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const close = () => { setOpen(false); setRole(saved?.role ?? ""); setError(""); };
    const onPointer = (e: PointerEvent) => { if (!wrapperRef.current?.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [open, saved]);
  async function save() {
    if (!saved) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/applications/${seq}/role`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, revision: saved.revision }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setSaved(data); setRole(data.role); onSaved(data.revision); setOpen(false);
    } catch (e) { setError(e instanceof Error ? e.message : "저장하지 못했습니다."); }
    finally { setBusy(false); }
  }
  const options = [...new Set(positions)].filter(Boolean);
  const unchanged = !role.trim() || role.trim() === saved?.role;
  return <div ref={wrapperRef} className="relative min-w-0">
    <button type="button" onClick={() => setOpen(v => !v)} disabled={!saved} aria-expanded={open} aria-controls={`${id}-editor`}
      title={saved?.role ? "지원 직무 바꾸기" : "지원 직무 선택"}
      className={`flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition active:scale-95 disabled:opacity-50 ${saved?.role
        ? "border-gray-200 bg-gray-50 text-gray-700 hover:bg-gray-100"
        : "border-amber-300 bg-amber-50 font-medium text-amber-800 hover:bg-amber-100"}`}>
      <span className="shrink-0 text-gray-400">{saved?.role ? "지원 직무" : "!"}</span>
      <span className="truncate">{saved?.role || "지원 직무를 선택해주세요"}</span>
      <svg aria-hidden="true" viewBox="0 0 20 20" className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}><path d="M5.5 7.5 10 12l4.5-4.5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    {error && !open && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
    {open && <div id={`${id}-editor`} role="dialog" aria-label="지원 직무 설정"
      className="absolute left-0 top-full z-30 mt-2 w-80 max-w-[calc(100vw-2.5rem)] space-y-3 rounded-xl border border-gray-200 bg-white p-3 shadow-lg">
      <p className="text-xs text-gray-500">이 공고에서 지원할 직무 하나를 고르거나 입력하세요. 이력 구성과 자기소개서에 함께 반영됩니다.</p>
      {options.length > 0 && <div className="flex flex-wrap gap-1.5">
        {options.map(p => <button key={p} type="button" disabled={busy} onClick={() => setRole(p)}
          className={`rounded-full border px-2.5 py-1 text-xs transition active:scale-95 ${role.trim() === p ? "border-blue-300 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-600 hover:bg-gray-50"}`}>{p}</button>)}
      </div>}
      <input ref={inputRef} aria-label="지원 직무" value={role} maxLength={200} disabled={busy}
        onChange={e => setRole(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !unchanged) void save(); }}
        placeholder="직접 입력" className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200" />
      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" disabled={busy} onClick={() => { setOpen(false); setRole(saved?.role ?? ""); setError(""); }}
          className="rounded-lg px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50">취소</button>
        <button type="button" onClick={save} disabled={busy || unchanged}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40">{busy ? "저장 중..." : "저장"}</button>
      </div>
    </div>}
  </div>;
}
