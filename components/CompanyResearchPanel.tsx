"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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
  const normalizedName = normalizeCompanyName(companyName);
  const [sections, setSections] = useState<Record<string, CompanySection>>({});
  const [loading, setLoading] = useState(true);
  const [researching, setResearching] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setLoading(true);
    setSections({});
    setError("");
    fetch(
      `/api/companies/${encodeURIComponent(normalizedName)}?displayName=${encodeURIComponent(companyName)}`
    )
      .then((r) => r.json())
      .then(({ sections: list }: { sections: CompanySection[] }) => {
        const map: Record<string, CompanySection> = {};
        for (const s of list) map[s.sectionType] = s;
        setSections(map);
      })
      .catch(() => setError("불러오지 못했습니다."))
      .finally(() => setLoading(false));

    return () => abortRef.current?.abort();
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
                  "모든 섹션이 아직 최신 상태라 다시 조사하지 않았습니다. 특정 섹션을 지금 바로 다시 조사하려면 그 섹션의 ↻ 버튼을 눌러주세요(TTL 무시하고 강제 재조사)."
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
              setResearching((prev) => {
                const next = new Set(prev);
                next.delete(data.sectionType);
                return next;
              });
            }
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError("리서치 중 오류가 발생했습니다.");
      } finally {
        setResearching(new Set());
      }
    },
    [normalizedName, companyName]
  );

  const anyResearching = researching.size > 0;
  const missingCount = COMPANY_SECTION_TYPES.filter((t) => !sections[t]).length;

  if (loading) {
    return <div className="text-sm text-gray-400 py-8 text-center">불러오는 중...</div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-gray-400">
          {missingCount > 0
            ? `${missingCount}개 섹션이 아직 조사되지 않았습니다. AI가 웹 검색/DART 공시를 조회합니다.`
            : "모든 섹션이 준비되어 있습니다."}
        </p>
        <button
          onClick={() => runResearch()}
          disabled={anyResearching}
          title="미조사·오래된 섹션만 채웁니다. 최신 섹션까지 강제로 다시 하려면 해당 섹션의 ↻를 누르세요."
          className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 ml-3"
        >
          {anyResearching ? "조사 중..." : "미조사 항목 채우기"}
        </button>
      </div>

      {error && <p className="text-xs text-red-500 mb-3">{error}</p>}
      {info && <p className="text-xs text-amber-600 mb-3">{info}</p>}

      <div className="space-y-3">
        {COMPANY_SECTION_TYPES.map((type) => {
          const section = sections[type];
          const isRunning = researching.has(type);
          return (
            <div key={type} className="bg-gray-50 rounded-lg p-3.5 border border-gray-100">
              <div className="flex items-center justify-between mb-1.5">
                <h4 className="text-sm font-semibold text-gray-700">
                  {COMPANY_SECTION_LABELS[type]}
                </h4>
                <div className="flex items-center gap-2">
                  {section && (
                    <span className="text-xs text-gray-400">
                      {timeAgo(section.generatedAt)}
                    </span>
                  )}
                  <button
                    onClick={() => runResearch([type], true)}
                    disabled={anyResearching}
                    className="text-xs text-gray-400 hover:text-gray-600 disabled:opacity-40"
                    title="이 섹션만 지금 강제로 다시 조사 (TTL 무시)"
                  >
                    ↻
                  </button>
                </div>
              </div>

              {isRunning ? (
                <p className="text-sm text-gray-400 animate-pulse">조사 중...</p>
              ) : section ? (
                <>
                  <p
                    className={`text-sm leading-relaxed whitespace-pre-wrap ${
                      section.status === "failed" ? "text-gray-400" : "text-gray-700"
                    }`}
                  >
                    {section.content}
                  </p>
                  {section.sources.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                      {section.sources.map((s, i) => (
                        <a
                          key={i}
                          href={s.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-blue-500 hover:underline truncate max-w-[200px]"
                        >
                          {s.title}
                        </a>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <p className="text-sm text-gray-400">아직 조사되지 않았습니다.</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
