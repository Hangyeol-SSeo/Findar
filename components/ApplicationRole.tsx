"use client";
import { useEffect, useId, useState } from "react";

export default function ApplicationRole({ seq, positions, onSaved }: {
  seq: string; positions: string[]; onSaved: (revision: string) => void;
}) {
  const id = useId();
  const [saved, setSaved] = useState<{ role: string; revision: string } | null>(null);
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
      setSaved(data); setRole(data.role); onSaved(data.revision);
    } catch (e) { setError(e instanceof Error ? e.message : "저장하지 못했습니다."); }
    finally { setBusy(false); }
  }
  return <section className="border-b border-gray-100 px-5 py-3 space-y-2">
    <label htmlFor={id} className="block text-sm font-medium">지원 직무</label>
    <div className="flex gap-2">
      <input id={id} list={`${id}-options`} value={role} maxLength={200} disabled={!saved || busy}
        onChange={e => setRole(e.target.value)} placeholder="이 공고에서 지원할 직무 하나를 선택하거나 입력"
        className="min-w-0 flex-1 rounded border border-gray-200 px-2 py-1.5 text-sm" />
      <datalist id={`${id}-options`}>{[...new Set(positions)].filter(Boolean).map(p => <option key={p} value={p} />)}</datalist>
      <button onClick={save} disabled={!saved || busy || !role.trim() || role.trim() === saved.role}
        className="rounded bg-blue-600 px-3 text-sm text-white disabled:opacity-40">{busy ? "저장 중" : "저장"}</button>
    </div>
    <p className="text-xs text-gray-500">{saved?.role ? `저장된 직무: ${saved.role}` : "평가·작성 전에 지원 직무를 저장해주세요."} · 이력 구성과 자기소개서에 함께 반영됩니다.</p>
    {saved && role.trim() !== saved.role && <p className="text-xs text-amber-700">입력한 직무를 저장해야 적용됩니다.</p>}
    {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
  </section>;
}
