"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { categorizePositions } from "@/lib/position-categories";
import { CRAWL_PAGES } from "@/lib/config";

interface JobSummary {
  seq: string;
  company: string;
  title: string;
  date: string;
  applicationPeriod: string;
  siteUrl: string;
  attachments: { name: string; url: string }[];
  positionType: string;
  experienceYears: string;
  positions: string[];
  jdSummary: string;
  qualifications: string[];
  deadline: string;
}

type FilterType = "전체" | "신입" | "경력" | "인턴" | "신입경력";

interface Progress {
  phase: "idle" | "crawl" | "detail" | "summarize" | "done";
  message: string;
  current: number;
  total: number;
  remainingSeconds: number;
}

export default function JobBoard() {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<FilterType>("전체");
  const [positionFilter, setPositionFilter] = useState("전체");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedJob, setSelectedJob] = useState<JobSummary | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [progress, setProgress] = useState<Progress>({
    phase: "idle",
    message: "",
    current: 0,
    total: 0,
    remainingSeconds: 0,
  });
  const abortRef = useRef<AbortController | null>(null);

  const fetchJobs = useCallback(async (refresh = false) => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError("");
    setProgress({
      phase: "crawl",
      message: "연결 중...",
      current: 0,
      total: 0,
      remainingSeconds: 0,
    });

    try {
      const res = await fetch(
        `/api/jobs?pages=${CRAWL_PAGES}${refresh ? "&refresh=true" : ""}`,
        { signal: controller.signal }
      );

      // 캐시 히트 시 JSON 응답
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const data = await res.json();
        setJobs(data.jobs);
        setFromCache(data.fromCache);
        setProgress((p) => ({ ...p, phase: "done", message: "완료" }));
        setLoading(false);
        return;
      }

      // SSE 스트리밍
      const reader = res.body?.getReader();
      if (!reader) throw new Error("Stream not available");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const dataLine = line
            .split("\n")
            .find((l) => l.startsWith("data: "));
          if (!dataLine) continue;

          const data = JSON.parse(dataLine.slice(6));

          switch (data.type) {
            case "phase":
              setProgress((p) => ({
                ...p,
                phase: data.phase,
                message: data.message,
                total: data.total || p.total,
                current: 0,
              }));
              break;

            case "crawl-list":
              setProgress((p) => ({
                ...p,
                message: `목록 수집 중... (${data.page}/${data.totalPages}페이지, ${data.count}건)`,
                current: data.page,
                total: data.totalPages,
              }));
              break;

            case "crawl-detail":
              setProgress((p) => ({
                ...p,
                message: `상세 정보 수집 중... (${data.current}/${data.total})`,
                current: data.current,
                total: data.total,
              }));
              break;

            case "summarize-progress":
              setProgress((p) => ({
                ...p,
                phase: "summarize",
                message: `AI 요약 중... (${data.current}/${data.total})`,
                current: data.current,
                total: data.total,
                remainingSeconds: data.remainingSeconds,
              }));
              // 요약된 공고 실시간 추가
              if (data.job) {
                setJobs((prev) => {
                  const exists = prev.some((j) => j.seq === data.job.seq);
                  return exists ? prev : [...prev, data.job];
                });
              }
              break;

            case "done":
              setJobs(data.jobs);
              setFromCache(false);
              setLoading(false);
              setProgress((p) => ({
                ...p,
                phase: "done",
                message: "완료",
              }));
              break;

            case "error":
              setError(data.message);
              setLoading(false);
              break;
          }
        }
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError("데이터를 불러오는데 실패했습니다.");
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchJobs();
    return () => abortRef.current?.abort();
  }, [fetchJobs]);

  // 직군 카테고리 추출
  const allCategories = useMemo(() => {
    const catSet = new Set<string>();
    jobs.forEach((job) =>
      categorizePositions(job.positions).forEach((c) => catSet.add(c))
    );
    return Array.from(catSet).sort();
  }, [jobs]);

  const filteredJobs = useMemo(() => {
    return jobs.filter((job) => {
      const matchType =
        filter === "전체" || job.positionType.includes(filter);
      const matchPosition =
        positionFilter === "전체" ||
        categorizePositions(job.positions).includes(positionFilter);
      const q = searchQuery.toLowerCase();
      const matchSearch =
        !q ||
        job.company.toLowerCase().includes(q) ||
        job.title.toLowerCase().includes(q) ||
        job.positions.some((p) => p.toLowerCase().includes(q)) ||
        job.jdSummary.toLowerCase().includes(q);
      return matchType && matchPosition && matchSearch;
    });
  }, [jobs, filter, positionFilter, searchQuery]);

  const getBadgeColor = (type: string) => {
    if (type.includes("신입") && type.includes("경력"))
      return "bg-blue-100 text-blue-700";
    if (type.includes("신입")) return "bg-emerald-100 text-emerald-700";
    if (type.includes("경력")) return "bg-amber-100 text-amber-700";
    if (type.includes("인턴")) return "bg-violet-100 text-violet-700";
    return "bg-gray-100 text-gray-600";
  };

  const formatTime = (seconds: number) => {
    if (seconds < 60) return `약 ${seconds}초`;
    const min = Math.floor(seconds / 60);
    const sec = seconds % 60;
    return `약 ${min}분 ${sec}초`;
  };

  const progressPercent =
    progress.total > 0
      ? Math.round((progress.current / progress.total) * 100)
      : 0;

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Main content */}
      <div
        className={`flex-1 flex flex-col overflow-hidden transition-all duration-300 ${selectedJob ? "mr-[480px]" : ""}`}
      >
        <div className="flex-1 overflow-y-auto px-6 py-8">
          {/* Header */}
          <header className="mb-6">
            <h1 className="text-3xl font-bold tracking-tight">Findar</h1>
            <p className="text-gray-500 mt-1">
              금융투자협회 회원사 채용공고를 한눈에
            </p>
          </header>

          {/* Progress bar */}
          {loading && progress.phase !== "idle" && (
            <div className="mb-6 bg-white rounded-xl border border-gray-100 p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-700">
                  {progress.message}
                </span>
                {progress.phase === "summarize" &&
                  progress.remainingSeconds > 0 && (
                    <span className="text-xs text-gray-400">
                      남은 시간: {formatTime(progress.remainingSeconds)}
                    </span>
                  )}
              </div>
              <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500 ease-out"
                  style={{
                    width: `${progressPercent}%`,
                    backgroundColor:
                      progress.phase === "summarize" ? "#2563eb" : "#10b981",
                  }}
                />
              </div>
              <div className="flex justify-between mt-1.5">
                <span className="text-xs text-gray-400">
                  {progress.current} / {progress.total}
                </span>
                <span className="text-xs text-gray-400">
                  {progressPercent}%
                </span>
              </div>
            </div>
          )}

          {/* Controls */}
          <div className="flex flex-col gap-3 mb-6">
            <input
              type="text"
              placeholder="회사명, 직무, 키워드 검색..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full px-4 py-2 border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />

            {/* 채용유형 필터 */}
            <div className="flex gap-2 flex-wrap">
              {(
                ["전체", "신입", "경력", "인턴", "신입경력"] as FilterType[]
              ).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    filter === f
                      ? "bg-blue-600 text-white"
                      : "bg-white text-gray-600 border border-gray-200 hover:bg-gray-50"
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>

            {/* 직군 필터 */}
            {allCategories.length > 0 && (
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={() => setPositionFilter("전체")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    positionFilter === "전체"
                      ? "bg-indigo-600 text-white"
                      : "bg-white text-gray-500 border border-gray-200 hover:bg-gray-50"
                  }`}
                >
                  직군 전체
                </button>
                {allCategories.map((cat) => (
                  <button
                    key={cat}
                    onClick={() =>
                      setPositionFilter(positionFilter === cat ? "전체" : cat)
                    }
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      positionFilter === cat
                        ? "bg-indigo-600 text-white"
                        : "bg-white text-gray-500 border border-gray-200 hover:bg-gray-50"
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Status bar */}
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm text-gray-500">
              {loading
                ? jobs.length > 0
                  ? `${jobs.length}건 로드됨...`
                  : "데이터 수집 중..."
                : `${filteredJobs.length}건`}
              {fromCache && !loading && " (캐시)"}
            </span>
            <button
              onClick={() => {
                setJobs([]);
                setFromCache(false);
                fetchJobs(true);
              }}
              disabled={loading}
              className="text-sm px-3 py-1.5 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-50 transition-colors flex items-center gap-1.5"
            >
              {loading && (
                <svg className="animate-spin h-3.5 w-3.5 text-gray-500" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              )}
              {loading ? "로딩 중..." : "새로고침"}
            </button>
          </div>

          {/* Error */}
          {error && (
            <div className="mb-4 p-4 bg-red-50 text-red-700 rounded-lg">
              {error}
            </div>
          )}

          {/* Loading skeleton */}
          {loading && jobs.length === 0 && progress.phase === "idle" && (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <div
                  key={i}
                  className="bg-white rounded-xl p-5 border border-gray-100 animate-pulse"
                >
                  <div className="h-4 bg-gray-200 rounded w-1/4 mb-3" />
                  <div className="h-5 bg-gray-200 rounded w-3/4 mb-3" />
                  <div className="h-3 bg-gray-200 rounded w-full" />
                </div>
              ))}
            </div>
          )}

          {/* Job list */}
          <div className="space-y-3 pb-8">
            {filteredJobs.map((job) => (
              <div
                key={job.seq}
                onClick={() => setSelectedJob(job)}
                className={`bg-white rounded-xl p-5 border transition-all cursor-pointer ${
                  selectedJob?.seq === job.seq
                    ? "border-blue-400 shadow-md ring-1 ring-blue-200"
                    : "border-gray-100 hover:border-blue-200 hover:shadow-md"
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-sm font-medium text-blue-600">
                        {job.company}
                      </span>
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full font-medium ${getBadgeColor(job.positionType)}`}
                      >
                        {job.positionType}
                      </span>
                      {job.experienceYears &&
                        job.experienceYears !== "미분류" && (
                          <span className="text-xs text-gray-400">
                            {job.experienceYears}
                          </span>
                        )}
                    </div>
                    <h3 className="font-semibold text-gray-900 mb-1.5 truncate">
                      {job.title}
                    </h3>
                    {job.jdSummary && (
                      <p className="text-sm text-gray-500 line-clamp-2">
                        {job.jdSummary}
                      </p>
                    )}
                    {job.positions.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {job.positions.map((pos, i) => (
                          <span
                            key={i}
                            className="text-xs px-2 py-0.5 bg-gray-100 text-gray-600 rounded"
                          >
                            {pos}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs text-gray-400">{job.date}</div>
                    {job.deadline && (
                      <div className="text-xs text-red-500 mt-0.5">
                        ~{job.deadline}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {!loading && filteredJobs.length === 0 && jobs.length > 0 && (
            <div className="text-center py-12 text-gray-400">
              검색 결과가 없습니다
            </div>
          )}
        </div>
      </div>

      {/* Side Panel */}
      <div
        className={`fixed top-0 right-0 h-full w-[480px] bg-white border-l border-gray-200 shadow-xl transform transition-transform duration-300 ease-in-out z-40 ${
          selectedJob ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {selectedJob && (
          <div className="h-full flex flex-col">
            {/* Panel header */}
            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <span className="text-sm font-medium text-blue-600">
                {selectedJob.company}
              </span>
              <button
                onClick={() => setSelectedJob(null)}
                className="text-gray-400 hover:text-gray-600 text-xl leading-none p-1"
              >
                &times;
              </button>
            </div>

            {/* Panel body */}
            <div className="flex-1 overflow-y-auto p-5">
              <h2 className="text-xl font-bold mb-4">{selectedJob.title}</h2>

              <div className="grid grid-cols-2 gap-3 mb-5">
                <InfoItem label="채용 유형" value={selectedJob.positionType} />
                <InfoItem label="경력" value={selectedJob.experienceYears} />
                <InfoItem label="등록일" value={selectedJob.date} />
                <InfoItem
                  label="마감일"
                  value={
                    selectedJob.deadline ||
                    formatPeriod(selectedJob.applicationPeriod) ||
                    "-"
                  }
                />
              </div>

              {selectedJob.positions.length > 0 && (
                <Section title="모집 직무">
                  <div className="flex flex-wrap gap-1.5">
                    {selectedJob.positions.map((pos, i) => (
                      <span
                        key={i}
                        className="text-sm px-2.5 py-1 bg-blue-50 text-blue-700 rounded-lg"
                      >
                        {pos}
                      </span>
                    ))}
                  </div>
                </Section>
              )}

              {selectedJob.jdSummary && (
                <Section title="업무 내용">
                  <p className="text-sm text-gray-600 leading-relaxed">
                    {selectedJob.jdSummary}
                  </p>
                </Section>
              )}

              {selectedJob.qualifications.length > 0 && (
                <Section title="자격 요건">
                  <ul className="text-sm text-gray-600 space-y-1">
                    {selectedJob.qualifications.map((q, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="text-gray-400 shrink-0">-</span>
                        <span>{q}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {selectedJob.attachments.length > 0 && (
                <Section title="첨부파일">
                  <ul className="text-sm space-y-1">
                    {selectedJob.attachments.map((att, i) => (
                      <li key={i}>
                        <a
                          href={att.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline"
                        >
                          {att.name}
                        </a>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}
            </div>

            {/* Panel footer */}
            {selectedJob.siteUrl && (
              <div className="p-5 border-t border-gray-100">
                <a
                  href={selectedJob.siteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-center px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
                >
                  원문 보기
                </a>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-50 rounded-lg p-3">
      <div className="text-xs text-gray-400 mb-0.5">{label}</div>
      <div className="text-sm font-medium">{value || "-"}</div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-5">
      <h4 className="text-sm font-semibold text-gray-700 mb-2">{title}</h4>
      {children}
    </div>
  );
}

function formatPeriod(period: string): string {
  if (!period || period.length < 8) return period;
  // "20260406~20260420" → "2026-04-06 ~ 2026-04-20"
  const parts = period.split("~");
  return parts
    .map((p) => {
      const t = p.trim();
      if (t.length === 8) {
        return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
      }
      return t;
    })
    .join(" ~ ");
}
