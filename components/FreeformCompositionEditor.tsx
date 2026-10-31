"use client";

import { useEffect, useRef, useState } from "react";
import { COMPOSITION_FOCUS, type ApplicationMaterial, type CompositionCatalog, type CompositionFocus, type CompositionItem, type FreeformComposition, type MaterialChoice, type MaterialLevel } from "@/lib/freeform-composition";

const input = "w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm";
const button = "rounded border border-gray-300 px-2 py-1.5 text-xs hover:bg-gray-50 disabled:opacity-40";
type MaterialDraft = Omit<ApplicationMaterial, "id" | "updatedAt" | "status"> & { id?: string; expectedUpdatedAt?: number; status: "confirmed" | "in_progress" };
const emptyMaterial = (): MaterialDraft => ({ title: "", category: "프로젝트", period: "", summary: "", detail: "", tags: [], status: "confirmed", source: "직접 확인한 수행 내용" });
interface CatalogResponse { catalog: CompositionCatalog; plan: FreeformComposition; notice: string; materials: ApplicationMaterial[] }

export default function FreeformCompositionEditor({ seq, disabled, value, onChange, onReady }: {
  seq: string; disabled: boolean; value: FreeformComposition | null;
  onChange: (plan: FreeformComposition | null) => void; onReady: (ready: boolean) => void;
}) {
  const [data, setData] = useState<CatalogResponse | null>(null);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<MaterialDraft | null>(null);
  const abort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const current = useRef(value); current.current = value;
  const endpoint = `/api/applications/${encodeURIComponent(seq)}/fill/freeform`;

  async function load(focus?: CompositionFocus, preserve = false) {
    abort.current?.abort();
    const controller = new AbortController(); abort.current = controller;
    setLoading(true); setError(""); onReady(false);
    try {
      const response = await fetch(`${endpoint}${focus ? `?focus=${focus}&reset=1` : ""}`, { cache: "no-store", signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (controller.signal.aborted) return;
      const next = result as CatalogResponse;
      // A material edit changes the source version, but retains unrelated choices in this open form.
      if (preserve && current.current && current.current.roleRevision === next.catalog.roleRevision) {
        const previous = new Map(current.current.choices.map(c => [c.id, c]));
        next.plan = { ...next.plan, choices: next.plan.choices.map(c => previous.get(c.id) ?? c) };
      }
      setData(next); onChange(next.plan); setNotice(next.notice); onReady(true);
    } catch (e) {
      if (!controller.signal.aborted) { setError(e instanceof Error ? e.message : "구성을 불러오지 못했습니다."); onChange(null); }
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; abort.current?.abort(); };
    // The parent remounts this editor whenever the posting or role changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq]);

  function change(id: string, fields: Partial<MaterialChoice>) {
    if (value) { onChange({ ...value, choices: value.choices.map(c => c.id === id ? { ...c, ...fields } : c) }); setNotice("변경한 구성은 구성 저장 또는 지원서 생성 시 저장됩니다."); }
  }
  async function savePlan() {
    setSaving(true); setError("");
    try {
      const response = await fetch(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (mounted.current) setNotice("이 공고의 구성을 저장했습니다.");
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "구성을 저장하지 못했습니다."); }
    finally { if (mounted.current) setSaving(false); }
  }
  function openMaterial(item?: CompositionItem) {
    onReady(false);
    const saved = data?.materials.find(m => `material:${m.id}` === item?.id);
    if (saved) {
      const { id, updatedAt, ...fields } = saved;
      setEditor({ ...fields, id, expectedUpdatedAt: updatedAt, status: saved.status === "in_progress" ? "in_progress" : "confirmed" });
    } else setEditor(item ? { ...emptyMaterial(), title: item.title, category: item.category, period: item.period, summary: item.summary, detail: item.detail, tags: item.tags, source: item.source, originId: item.id.startsWith("material:card-") ? `card:${item.id.slice("material:card-".length)}` : undefined } : emptyMaterial());
    setError("");
  }
  async function saveMaterial() {
    if (!editor) return;
    setSaving(true); setError(""); onReady(false);
    try {
      const response = await fetch("/api/application-materials", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(editor) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (!mounted.current) return;
      setEditor(null);
      await load(value?.focus, true);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "경험을 저장하지 못했습니다.");
    } finally { if (mounted.current) setSaving(false); }
  }
  const choiceMap = new Map(value?.choices.map(c => [c.id, c]));
  const confirmed = data?.catalog.items.filter(i => i.status === "confirmed") ?? [];
  const candidates = data?.catalog.items.filter(i => i.status !== "confirmed") ?? [];
  const count = (level: MaterialLevel) => value?.choices.filter(c => c.level === level).length ?? 0;
  const locked = disabled || saving || loading;
  function row(item: CompositionItem) {
    const choice = choiceMap.get(item.id), level = choice?.level ?? "exclude";
    const editable = item.kind === "work" || item.kind === "experience" || item.kind === "skill";
    return <div key={item.id} className={`space-y-2 border-t border-gray-100 py-3 ${level === "exclude" ? "text-gray-500" : "text-gray-900"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{item.title || "이름 없는 항목"}{item.required && <span className="ml-2 text-xs text-amber-800">공고 필수</span>}</p><p className="mt-0.5 text-xs">{[item.category, item.period].filter(Boolean).join(" · ")}</p></div>
        <select aria-label={`${item.title} 기재 방식`} className="rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900" value={level} disabled={locked} onChange={e => change(item.id, { level: e.target.value as MaterialLevel })}>
          {(item.kind === "work" || item.kind === "experience") && item.detail && <option value="detail">상세 기재</option>}<option value="brief">한 줄 기재</option><option value="exclude" disabled={item.required}>제외</option>
        </select>
      </div>
      <p className="text-xs leading-5 text-gray-500">{item.reason}</p>
      {level !== "exclude" && <p className="whitespace-pre-line text-xs leading-5">{choice?.summary ?? item.summary}</p>}
      {editable && level !== "exclude" && <details><summary className="cursor-pointer text-xs text-blue-700">제출할 설명 확인·수정</summary><div className="mt-2 space-y-2">
        <label className="block text-xs">한 줄 설명<input className={`${input} mt-1`} maxLength={500} disabled={locked} value={choice?.summary ?? item.summary} onChange={e => change(item.id, { summary: e.target.value })} /></label>
        {level === "detail" && <label className="block text-xs">상세 수행 내용<textarea rows={5} maxLength={20000} className={`${input} mt-1`} disabled={locked} value={choice?.detail ?? item.detail} onChange={e => change(item.id, { detail: e.target.value })} /></label>}
        <p className="text-xs text-gray-500">이 설명은 이 공고에만 적용됩니다. 출처: {item.source}</p>
      </div></details>}
      {item.id.startsWith("material:") && <button type="button" className="text-xs text-blue-700 underline" disabled={locked} onClick={() => openMaterial(item)}>공통 경험 자료 수정</button>}
    </div>;
  }
  return <section className="space-y-3 border-t border-gray-200 pt-3" aria-label="지원서 이력 구성">
    <div className="flex flex-wrap items-center justify-between gap-2"><h5 className="text-sm font-semibold">공고에 맞는 이력 구성</h5><button type="button" className={button} disabled={locked} onClick={() => openMaterial()}>경험 추가</button></div>
    <p className="text-xs leading-5 text-gray-600">개발 경력은 근무 사실 위주로 남기고, 선택 직무와 관련된 경험만 자세히 표시합니다. 기본 추천을 확인한 뒤 각 항목을 조정해주세요.</p>
    {data && <label className="flex flex-wrap items-center gap-2 text-xs">구성 기준<select className="rounded border border-gray-300 bg-white px-2 py-1 text-sm" disabled={locked} value={data.catalog.focus} onChange={e => void load(e.target.value as CompositionFocus)}>{Object.entries(COMPOSITION_FOCUS).map(([key, title]) => <option key={key} value={key}>{title}</option>)}</select><span className="text-gray-500">변경하면 해당 기준의 기본 추천으로 바뀝니다.</span></label>}
    {loading && <p role="status" className="text-xs text-gray-500">이력 구성을 불러오는 중...</p>}
    {!loading && data && <>
      <p className="rounded bg-gray-50 px-3 py-2 text-xs">상세 {count("detail")}개 · 한 줄 {count("brief")}개 · 제외 {count("exclude")}개</p>
      {([ ["학력·자격·어학", ["education", "credential", "language"]], ["직무 관련 경험", ["experience"]], ["근무 경력", ["work"]], ["활용 역량·참고 자료", ["skill"]] ] as const).map(([title, kinds]) => {
        const items = confirmed.filter(i => (kinds as readonly string[]).includes(i.kind));
        return items.length ? <div key={title}><h6 className="text-xs font-semibold text-gray-600">{title}</h6>{items.map(row)}</div> : null;
      })}
      {candidates.length > 0 && <details className="rounded border border-gray-200 p-3"><summary className="cursor-pointer text-xs font-medium">확인 후 추가할 경험 자료 {candidates.length}개</summary><p className="mt-2 text-xs leading-5 text-gray-500">과거 글에서 정리된 내용과 진행 중인 프로젝트입니다. 실제 수행 내용과 수치를 직접 확인하고 저장해야 제출 파일에 넣을 수 있습니다.</p>{candidates.map(i => <div key={i.id} className="space-y-1 border-t border-gray-100 py-3"><p className="text-sm">{i.title}</p><p className="text-xs leading-5 text-gray-500">{i.reason}</p><button type="button" className={button} disabled={locked} onClick={() => openMaterial(i)}>내용 확인·추가</button></div>)}</details>}
      <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={locked} onClick={savePlan}>이 공고의 구성 저장</button><button type="button" className={button} disabled={locked} onClick={() => void load(data.catalog.focus)}>기본 추천으로 되돌리기</button></div>
      <p className="text-xs leading-5 text-gray-500">문서 순서: 기본 정보 → 학력 → 자격·어학 → 선택한 경험 → 근무 경력 → 활용 역량. 상세로 선택한 경험만 상세 내용을 붙입니다.</p>
    </>}
    {editor && <fieldset disabled={disabled || saving} className="space-y-3 rounded border border-blue-200 bg-blue-50/40 p-3"><legend className="px-1 text-sm font-medium">{editor.id ? "경험 자료 수정" : "실제 수행한 경험 추가"}</legend>
      {([ ["title", "경험명", 180], ["category", "경험 구분 (창업 프로젝트·개발 업무·학습 등)", 60], ["period", "기간 (확인된 경우)", 100], ["summary", "한 줄 설명", 500] ] as const).map(([key, label, max]) => <label key={key} className="block text-xs">{label}<input className={`${input} mt-1`} maxLength={max} value={editor[key]} onChange={e => setEditor({ ...editor, [key]: e.target.value })} /></label>)}
      <label className="block text-xs">실제로 수행한 내용<textarea aria-label="실제로 수행한 내용" className={`${input} mt-1`} rows={7} maxLength={20000} value={editor.detail} onChange={e => setEditor({ ...editor, detail: e.target.value })} /></label>
      <label className="block text-xs">진행 상태<select className={`${input} mt-1`} value={editor.status} onChange={e => setEditor({ ...editor, status: e.target.value as MaterialDraft["status"] })}><option value="confirmed">실제 수행 내용 확인 완료</option><option value="in_progress">진행 중 · 제출 파일에서 제외</option></select></label>
      <fieldset><legend className="mb-1 text-xs">관련 직무 (복수 선택)</legend><div className="grid gap-2 text-xs sm:grid-cols-2">{Object.entries(COMPOSITION_FOCUS).map(([tag, title]) => <label key={tag} className="flex gap-2"><input type="checkbox" checked={editor.tags.includes(tag as CompositionFocus)} onChange={e => setEditor({ ...editor, tags: e.target.checked ? [...editor.tags, tag as CompositionFocus] : editor.tags.filter(t => t !== tag) })} />{title}</label>)}</div></fieldset>
      <label className="block text-xs">확인한 근거·출처<input className={`${input} mt-1`} maxLength={300} value={editor.source} onChange={e => setEditor({ ...editor, source: e.target.value })} /></label>
      <p className="text-xs leading-5 text-gray-600">개인 프로젝트·학습·개발 업무를 금융 실무로 바꾸어 기재하지 마세요. 원본 카드와 지원 정보는 바뀌지 않으며, 이 자료는 다른 공고에서도 선택할 수 있습니다.</p>
      <div className="flex gap-2"><button type="button" className={button} onClick={saveMaterial}>{saving ? "저장 중..." : "내용을 확인하고 자료 저장"}</button><button type="button" className={button} onClick={() => { setEditor(null); onReady(!!data && !loading); }}>닫기</button></div>
    </fieldset>}
    {notice && <p role="status" className="text-xs text-blue-700">{notice}</p>}
    {error && <div role="alert" className="space-y-2 text-xs text-red-700"><p>{error}</p>{!editor && <button type="button" className={button} disabled={loading || disabled || saving} onClick={() => void load()}>구성 새로 불러오기</button>}</div>}
  </section>;
}
