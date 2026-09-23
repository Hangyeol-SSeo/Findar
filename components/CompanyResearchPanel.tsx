"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import ResearchContent from "./ResearchContent";
import { normalizeCompanyName } from "@/lib/company-normalize";
import {
  COMPANY_SECTION_TYPES,
  COMPANY_SECTION_LABELS,
  type CompanySectionType,
} from "@/lib/company-section-types";

interface CompanySection {
  sectionType: string;
  content: string;
  sources: { title: string; url: string }[];
  status: "ok" | "partial" | "failed";
  generatedAt: number;
}

function timeAgo(ts: number): string {
  const days = Math.floor((Date.now() - ts) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "오늘";
  if (days === 1) return "1일 전";
  return `${days}일 전`;
}

export default function CompanyResearchPanel({ companyName }: { companyName: string }) {
  const [activeSection, setActiveSection] = useState<CompanySectionType>("overview");
  const readingRef = useRef<HTMLDivElement | null>(null);
  const normalizedName = normalizeCompanyName(companyName);
  const [sections, setSections] = useState<Record<string, CompanySection>>({});
  const [loading, setLoading] = useState(true);
  const [researching, setResearching] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const loadController = new AbortController();
    setLoading(true);
    setActiveSection("overview");
    setInfo("");
    setResearching(new Set());
    setSections({});
    setError("");
    fetch(
      `/api/companies/${encodeURIComponent(normalizedName)}?displayName=${encodeURIComponent(companyName)}`,
      { signal: loadController.signal }
    )
      .then((r) => { if (!r.ok) throw new Error("Load failed"); return r.json(); })
      .then(({ sections: list }: { sections: CompanySection[] }) => {
        if (loadController.signal.aborted) return;
        const map: Record<string, CompanySection> = {};
        for (const s of list) map[s.sectionType] = s;
        setSections(map);
      })
      .catch(() => { if (!loadController.signal.aborted) setError("불러오지 못했습니다."); })
      .finally(() => { if (!loadController.signal.aborted) setLoading(false); });

    return () => { loadController.abort(); abortRef.current?.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalizedName]);

  const runResearch = useCallback(
    async (sectionTypes?: CompanySectionType[], force = false) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setError("");
      setInfo("");
      setResearching(new Set(sectionTypes ?? [...COMPANY_SECTION_TYPES]));

      try {
        const res = await fetch(`/api/companies/${encodeURIComponent(normalizedName)}/research`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayName: companyName, sections: sectionTypes, force }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error("조사 요청에 실패했습니다.");
        const reader = res.body?.getReader();
        if (!reader) throw new Error("스트림을 열 수 없습니다");

        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const dataLine = line.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            const data = JSON.parse(dataLine.slice(6));

            if (data.type === "targets") {
              setResearching(new Set(data.sectionTypes));
              // force 없이 눌렀는데 다시 조사할 섹션이 하나도 없으면(전부 아직 TTL 안 지남)
              // 조용히 아무 일도 안 일어나는 게 아니라 왜 그런지 알려준다.
              if (!force && data.sectionTypes.length === 0) {
                setInfo(
                  "모든 항목이 최신 상태입니다. 새 자료를 확인하려면 해당 항목에서 ‘다시 조사’를 눌러주세요."
                );
              }
            } else if (data.type === "section-done") {
              setSections((prev) => ({ ...prev, [data.sectionType]: data.section }));
              setResearching((prev) => {
                const next = new Set(prev);
                next.delete(data.sectionType);
                return next;
              });
            } else if (data.type === "section-error") {
              setError(data.message || "일부 항목을 조사하지 못했습니다.");
              setResearching((prev) => {
                const next = new Set(prev);
                next.delete(data.sectionType);
                return next;
              });
            }
          }
        }
      } catch (e) {
        if (!controller.signal.aborted && (e as Error).name !== "AbortError") setError("리서치 중 오류가 발생했습니다.");
      } finally {
        if (abortRef.current === controller) setResearching(new Set());
      }
    },
    [normalizedName, companyName]
  );

  const anyResearching = researching.size > 0;
  const missingCount = COMPANY_SECTION_TYPES.filter((t) => !sections[t]).length;

  if (loading) {
    return <div className="text-sm text-gray-400 py-8 text-center">불러오는 중...</div>;
  }

  const section = sections[activeSection];
  const activeIndex = COMPANY_SECTION_TYPES.indexOf(activeSection);
  const isRunning = researching.has(activeSection);
  function selectSection(type: CompanySectionType) {
    setActiveSection(type);
    readingRef.current?.scrollTo({ top: 0 });
    document.getElementById(`research-tab-${type}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  return (
    <div className="flex h-full min-h-0 flex-col lg:grid lg:grid-cols-[176px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)_auto]">
      <div className="shrink-0 border-b border-gray-100 bg-white px-4 py-3 lg:row-span-2 lg:min-h-0 lg:overflow-y-auto lg:border-b-0 lg:border-r lg:bg-gray-50/70 lg:px-3 lg:py-5">
        <div className="mb-3 flex items-center justify-between gap-3 lg:flex-col lg:items-stretch lg:gap-4 lg:mb-5">
          <div><p className="text-sm font-semibold text-gray-900">회사 이해하기</p><p className="mt-1 text-xs text-gray-500">{5 - missingCount}/5개 항목 확인</p></div>
          <button onClick={() => runResearch()} disabled={anyResearching} className="shrink-0 rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {anyResearching ? "조사 중..." : "리서치 업데이트"}
          </button>
        </div>
        <div role="tablist" aria-label="회사 리서치 항목" className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
          {COMPANY_SECTION_TYPES.map((type, index) => {
            const item = sections[type];
            const selected = activeSection === type;
            return <button key={type} id={`research-tab-${type}`} role="tab" aria-selected={selected} aria-controls={`research-panel-${type}`} tabIndex={selected ? 0 : -1}
              onClick={() => selectSection(type)} onKeyDown={(event) => {
                let next = index;
                if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % COMPANY_SECTION_TYPES.length;
                else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index + COMPANY_SECTION_TYPES.length - 1) % COMPANY_SECTION_TYPES.length;
                else if (event.key === "Home") next = 0;
                else if (event.key === "End") next = COMPANY_SECTION_TYPES.length - 1;
                else return;
                event.preventDefault(); selectSection(COMPANY_SECTION_TYPES[next]);
                document.getElementById(`research-tab-${COMPANY_SECTION_TYPES[next]}`)?.focus();
              }}
              className={`shrink-0 rounded-lg border px-3 py-2 text-left lg:min-w-0 lg:py-3 transition-colors ${selected ? "border-blue-200 bg-blue-50 text-blue-800" : "border-transparent bg-transparent text-gray-600 hover:bg-gray-100"}`}>
              <span className="block whitespace-nowrap text-xs font-semibold">{COMPANY_SECTION_LABELS[type]}</span>
              <span className={`mt-1 hidden text-[11px] lg:block ${researching.has(type) ? "text-blue-600 animate-pulse" : "text-gray-500"}`}>
                {researching.has(type) ? "조사 중" : !item ? "미조사" : item.status === "failed" ? "조사 실패" : item.status === "partial" ? "일부 확인" : `${timeAgo(item.generatedAt)} 업데이트`}
              </span>
            </button>;
          })}
        </div>
        <p className="mt-5 hidden text-[11px] leading-5 text-gray-400 lg:block">업데이트는 미조사·오래된 항목만 확인합니다. 항목 전환에는 추가 조사가 발생하지 않습니다.</p>
        {error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
        {info && <p role="status" className="mt-2 text-xs text-blue-600">{info}</p>}
      </div>

      <div ref={readingRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-8 lg:col-start-2 lg:row-start-1 lg:px-9 lg:py-6">
        <article id={`research-panel-${activeSection}`} role="tabpanel" aria-labelledby={`research-tab-${activeSection}`} tabIndex={0} className="mx-auto max-w-2xl outline-offset-4">
          <div className="mb-5 flex items-start justify-between gap-3 border-b border-gray-100 pb-4">
            <div><h4 className="text-xl font-semibold tracking-tight text-gray-900">{COMPANY_SECTION_LABELS[activeSection]}</h4>
              {section && <p className="mt-2 text-xs text-gray-400">{timeAgo(section.generatedAt)} 업데이트 · 출처 {section.sources.length}개</p>}
            </div>
            <button onClick={() => runResearch([activeSection], true)} disabled={anyResearching} className="shrink-0 rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40">{section ? "다시 조사" : "이 항목 조사"}</button>
          </div>
          {isRunning && <p role="status" className="mb-4 rounded-lg bg-blue-50 p-3 text-sm text-blue-700">자료를 확인하고 있습니다.{section?.content ? " 기존 내용을 먼저 읽으실 수 있습니다." : " 다른 항목을 읽으면서 기다리실 수 있습니다."}</p>}
          {section?.content ? <ResearchContent content={section.content} /> : !isRunning && <div className="rounded-xl bg-gray-50 px-5 py-12 text-center"><p className="text-sm text-gray-600">아직 조사된 내용이 없습니다.</p><p className="mt-2 text-xs text-gray-400">‘이 항목 조사’로 필요한 주제부터 확인하세요.</p></div>}
          {section && section.status !== "ok" && <p className="mt-4 text-xs text-amber-700">{section.status === "partial" ? "일부 정보만 확인되었습니다. 미확인 내용은 원문을 확인해주세요." : "조사를 완료하지 못했습니다. 다시 조사할 수 있습니다."}</p>}
          {!!section?.sources.length && <details key={activeSection} className="mt-7 rounded-xl border border-gray-200 bg-gray-50 p-4">
            <summary className="cursor-pointer text-sm font-medium text-gray-700">참고 출처 {section.sources.length}개</summary>
            <ul className="mt-3 space-y-3">{section.sources.map((source, index) => <li key={index}><a href={/^https?:\/\//i.test(source.url) ? source.url : undefined} target="_blank" rel="noopener noreferrer" className="block break-words text-sm text-blue-600 hover:underline">{index + 1}. {source.title}</a></li>)}</ul>
          </details>}
        </article>
      </div>
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-gray-100 px-4 py-1 text-xs lg:col-start-2 lg:row-start-2 lg:px-7">
        <button disabled={activeIndex === 0} onClick={() => selectSection(COMPANY_SECTION_TYPES[activeIndex - 1])} className="rounded-lg px-2 py-2 text-gray-600 hover:bg-gray-50 disabled:opacity-30">← 이전 항목</button>
        <span className="text-gray-400">{activeIndex + 1} / {COMPANY_SECTION_TYPES.length}</span>
        <button disabled={activeIndex === COMPANY_SECTION_TYPES.length - 1} onClick={() => selectSection(COMPANY_SECTION_TYPES[activeIndex + 1])} className="rounded-lg px-2 py-2 text-blue-600 hover:bg-blue-50 disabled:opacity-30">다음 항목 →</button>
      </div>
    </div>
  );
}
