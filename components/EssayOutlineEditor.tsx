"use client";

import type { EssayOutline, OutlineParagraph } from "@/lib/essay-contract";

export interface MaterialOption { id: string; label: string; kind: string }

const inputStyle = "w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200";
const smallButton = "rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40";
const KIND_LABEL: Record<string, string> = { card: "경험 카드", episode: "가치관·서사", resume: "이력서", activity: "활동" };

// 구성 확인 카드: AI가 제안한 핵심 메시지·문단 구성·쓸 경험·회사 근거·확인 질문을 고친 뒤 그대로 작성한다.
export function EssayOutlineEditor({ outline, materials, disabled, onChange, onWrite, onRemove }: {
  outline: EssayOutline;
  materials: MaterialOption[];
  disabled: boolean;
  onChange: (outline: EssayOutline) => void;
  onWrite: () => void;
  onRemove: () => void;
}) {
  const labelOf = (id: string) => materials.find((m) => m.id === id)?.label ?? id;
  const setParagraph = (index: number, patch: Partial<OutlineParagraph>) =>
    onChange({ ...outline, paragraphs: outline.paragraphs.map((p, i) => (i === index ? { ...p, ...patch } : p)) });
  const removeParagraph = (index: number) =>
    onChange({ ...outline, paragraphs: outline.paragraphs.length > 1 ? outline.paragraphs.filter((_, i) => i !== index) : outline.paragraphs });
  const moveParagraph = (index: number, delta: number) => {
    const next = [...outline.paragraphs];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange({ ...outline, paragraphs: next });
  };

  return <section data-outline className="space-y-3 rounded-xl border border-blue-200 bg-blue-50/30 p-4">
    <div className="space-y-1">
      <p className="text-xs font-medium text-blue-700">구성 확인 — 고친 뒤 작성하면 이 구성대로 씁니다</p>
      <h4 className="whitespace-pre-wrap text-sm font-semibold text-gray-800">{outline.question}</h4>
      {outline.maxChars && <p className="text-xs text-gray-500">{outline.maxChars.toLocaleString()}자 이내 · 공백 {outline.countSpaces ? "포함" : "제외"}</p>}
    </div>
    <label className="block text-xs font-medium text-gray-700">핵심 메시지
      <input className={`${inputStyle} mt-1`} value={outline.message} maxLength={500} disabled={disabled}
        onChange={(e) => onChange({ ...outline, message: e.target.value })} placeholder="이 글이 전할 핵심 한 문장" />
    </label>
    <div className="space-y-2">
      <p className="text-xs font-medium text-gray-700">문단 구성</p>
      {outline.paragraphs.map((p, i) => <div key={i} className="space-y-2 rounded-lg border border-gray-200 bg-white p-2.5">
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-xs font-medium text-gray-500">{i + 1}문단</span>
          <input aria-label={`${i + 1}문단 역할`} className={inputStyle} value={p.role} maxLength={300} disabled={disabled}
            onChange={(e) => setParagraph(i, { role: e.target.value })} placeholder="이 문단의 역할 — 예: 지원동기, 경험과 배운 점" />
          <button type="button" className={smallButton} disabled={disabled || i === 0} onClick={() => moveParagraph(i, -1)} aria-label={`${i + 1}문단 위로`}>↑</button>
          <button type="button" className={smallButton} disabled={disabled || i === outline.paragraphs.length - 1} onClick={() => moveParagraph(i, 1)} aria-label={`${i + 1}문단 아래로`}>↓</button>
          <button type="button" className={smallButton} disabled={disabled || outline.paragraphs.length === 1} onClick={() => removeParagraph(i)}>삭제</button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {p.materials.map((id) => <span key={id} className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-800">
            {labelOf(id)}
            <button type="button" disabled={disabled} aria-label={`${labelOf(id)} 빼기`} className="text-blue-500 hover:text-blue-800" onClick={() => setParagraph(i, { materials: p.materials.filter((m) => m !== id) })}>×</button>
          </span>)}
          <select aria-label={`${i + 1}문단에 쓸 경험 추가`} className="rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-600" value="" disabled={disabled || p.materials.length >= 4}
            onChange={(e) => e.target.value && setParagraph(i, { materials: [...p.materials, e.target.value] })}>
            <option value="">+ 쓸 경험 추가</option>
            {materials.filter((m) => !p.materials.includes(m.id)).map((m) => <option key={m.id} value={m.id}>[{KIND_LABEL[m.kind] ?? m.kind}] {m.label}</option>)}
          </select>
          {!p.materials.length && <span className="text-xs text-gray-400">쓸 경험 없음 — 동기·포부 문단이면 괜찮습니다</span>}
        </div>
        <input aria-label={`${i + 1}문단 메모`} className={inputStyle} value={p.note} maxLength={1000} disabled={disabled}
          onChange={(e) => setParagraph(i, { note: e.target.value })} placeholder="이 경험에서 꺼낼 내용이나 강조점 (선택)" />
      </div>)}
      <button type="button" className={smallButton} disabled={disabled || outline.paragraphs.length >= 8}
        onClick={() => onChange({ ...outline, paragraphs: [...outline.paragraphs, { role: "", materials: [], note: "" }] })}>+ 문단 추가</button>
    </div>
    {!!outline.companyFacts.length && <div className="space-y-1">
      <p className="text-xs font-medium text-gray-700">글에 쓸 회사 내용</p>
      {outline.companyFacts.map((f, i) => <label key={i} className="flex items-start gap-2 text-xs text-gray-600">
        <input type="checkbox" className="mt-0.5" checked={f.use} disabled={disabled}
          onChange={(e) => onChange({ ...outline, companyFacts: outline.companyFacts.map((x, j) => (j === i ? { ...x, use: e.target.checked } : x)) })} />
        <span>{f.text}</span>
      </label>)}
    </div>}
    {!!outline.questions.length && <div className="space-y-2">
      <p className="text-xs font-medium text-gray-700">확인 질문 <span className="font-normal text-gray-400">(답하면 글에 반영하고, 비워 두면 자료만으로 씁니다)</span></p>
      {outline.questions.map((q, i) => <label key={i} className="block text-xs text-gray-600">{q.question}
        <textarea className={`${inputStyle} mt-1`} rows={2} maxLength={2000} value={q.answer} disabled={disabled}
          onChange={(e) => onChange({ ...outline, questions: outline.questions.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)) })} />
      </label>)}
    </div>}
    <label className="block text-xs text-gray-600">추가 요청 <span className="text-gray-400">(선택)</span>
      <textarea className={`${inputStyle} mt-1`} rows={2} maxLength={6000} value={outline.guidance} disabled={disabled}
        onChange={(e) => onChange({ ...outline, guidance: e.target.value })} placeholder="강조할 점, 피하고 싶은 표현 등" />
    </label>
    <div className="flex flex-wrap gap-2">
      <button type="button" className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40" disabled={disabled} onClick={onWrite}>이 구성으로 작성</button>
      <button type="button" className="rounded-lg px-3 py-2 text-sm text-gray-500 hover:bg-gray-100 disabled:opacity-40" disabled={disabled} onClick={onRemove}>구성 지우기</button>
    </div>
  </section>;
}
