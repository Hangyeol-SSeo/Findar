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
  categories?: string[];
  jdSummary: string;
  qualifications: string[];
  deadline: string;
  matchScore?: number;
  matchVerdict?: "추천" | "보통" | "비추천";
  matchStrengths?: string[];
  matchGaps?: string[];
  matchReasoning?: string;
}

type FilterType = "전체" | "신입" | "경력" | "인턴";
type SortType = "추천순" | "최신순";
type ViewMode = "list" | "hidden";

const MATCH_ENABLED_KEY = "findar:matchEnabled";
const CRAWL_PAGES_KEY = "findar:crawlPages";
const MIN_PAGES = 1;
const MAX_PAGES = 50; // 서버(app/api/jobs/route.ts)의 상한과 동일

// 서버가 DB에 저장한 categories를 우선 쓰고, 백필 전 데이터 등 비어있는 경우에만
// 클라이언트에서 positions로부터 재계산한다.
function jobCategories(job: JobSummary): string[] {
  return job.categories?.length ? job.categories : categorizePositions(job.positions);
}

function readStoredMatchEnabled(): boolean | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(MATCH_ENABLED_KEY);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

function readStoredPages(): number | null {
  if (typeof window === "undefined") return null;
  const raw = Number(window.localStorage.getItem(CRAWL_PAGES_KEY));
  return Number.isInteger(raw) && raw > 0 ? raw : null;
}

interface Progress {
  phase: "idle" | "profile" | "crawl" | "detail" | "summarize" | "rematch" | "done";
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
  const [newCount, setNewCount] = useState<number | null>(null);
  const [hasProfile, setHasProfile] = useState(false);
  const [sort, setSort] = useState<SortType>("추천순");
  const [matchEnabled, setMatchEnabled] = useState<boolean | null>(() =>
    readStoredMatchEnabled()
  );
  const [pages, setPages] = useState<number>(() => readStoredPages() ?? CRAWL_PAGES);
  const [pagesInput, setPagesInput] = useState<string>(String(pages));
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [hiddenSeqs, setHiddenSeqs] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<Progress>({
    phase: "idle",
    message: "",
    current: 0,
    total: 0,
    remainingSeconds: 0,
  });
  const abortRef = useRef<AbortController | null>(null);

  const chooseMatchEnabled = useCallback((enabled: boolean) => {
    window.localStorage.setItem(MATCH_ENABLED_KEY, String(enabled));
    setMatchEnabled(enabled);
  }, []);

  const choosePages = useCallback((n: number) => {
    window.localStorage.setItem(CRAWL_PAGES_KEY, String(n));
    setPages(n);
  }, []);

  const commitPagesInput = useCallback(() => {
    const parsed = Math.round(Number(pagesInput));
    const clamped = Number.isFinite(parsed)
      ? Math.min(Math.max(parsed, MIN_PAGES), MAX_PAGES)
      : pages;
    setPagesInput(String(clamped));
    if (clamped !== pages) choosePages(clamped);
  }, [pagesInput, pages, choosePages]);

  const fetchJobs = useCallback(async (enabled: boolean, pagesArg: number) => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError("");
    setNewCount(null);
    setProgress({
      phase: "crawl",
      message: "연결 중...",
      current: 0,
      total: 0,
      remainingSeconds: 0,
    });

    try {
      const res = await fetch(`/api/jobs?pages=${pagesArg}&match=${enabled}`, {
        signal: controller.signal,
      });

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
            case "cached":
              if (Array.isArray(data.jobs) && data.jobs.length > 0) {
                setJobs(data.jobs);
              }
              break;

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
              if (data.job) {
                setJobs((prev) => {
                  const exists = prev.some((j) => j.seq === data.job.seq);
                  return exists ? prev : [...prev, data.job];
                });
              }
              break;

            case "rematch-progress":
              setProgress((p) => ({
                ...p,
                phase: "rematch",
                message: `기존 공고 재평가 중... (${data.current}/${data.total})`,
                current: data.current,
                total: data.total,
              }));
              if (data.job) {
                setJobs((prev) =>
                  prev.map((j) => (j.seq === data.job.seq ? data.job : j))
                );
              }
              break;

            case "profile-ready":
              setHasProfile(
                data.status !== "missing" &&
                  data.status !== "error" &&
                  data.status !== "disabled"
              );
              break;

            case "done":
              setJobs(data.jobs);
              setNewCount(typeof data.newCount === "number" ? data.newCount : null);
              setHasProfile(!!data.hasProfile);
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
    if (matchEnabled === null) return; // 최초 접속 & 아직 게이트에서 선택 전
    fetchJobs(matchEnabled, pages);
    return () => abortRef.current?.abort();
  }, [matchEnabled, pages, fetchJobs]);

  useEffect(() => {
    fetch("/api/jobs/hide")
      .then((r) => r.json())
      .then(({ seqs }: { seqs: string[] }) => setHiddenSeqs(new Set(seqs)))
      .catch(() => {});
  }, []);

  const hideJob = useCallback((seq: string) => {
    setHiddenSeqs((prev) => new Set([...prev, seq]));
    fetch("/api/jobs/hide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seq, hidden: true }),
    }).catch(() => {});
  }, []);

  const unhideJob = useCallback((seq: string) => {
    setHiddenSeqs((prev) => {
      const next = new Set(prev);
      next.delete(seq);
      return next;
    });
    fetch("/api/jobs/hide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seq, hidden: false }),
    }).catch(() => {});
  }, []);

  // 직군 카테고리 추출
  const allCategories = useMemo(() => {
    const catSet = new Set<string>();
    jobs.forEach((job) => jobCategories(job).forEach((c) => catSet.add(c)));
    return Array.from(catSet).sort();
  }, [jobs]);

  const hiddenJobs = useMemo(
    () => jobs.filter((job) => hiddenSeqs.has(job.seq)),
    [jobs, hiddenSeqs]
  );

  const filteredJobs = useMemo(() => {
    const filtered = jobs.filter((job) => {
      if (hiddenSeqs.has(job.seq)) return false;
      const matchType =
        filter === "전체" || job.positionType.includes(filter);
      const matchPosition =
        positionFilter === "전체" || jobCategories(job).includes(positionFilter);
      const q = searchQuery.toLowerCase();
      const matchSearch =
        !q ||
        job.company.toLowerCase().includes(q) ||
        job.title.toLowerCase().includes(q) ||
        job.positions.some((p) => p.toLowerCase().includes(q)) ||
        job.jdSummary.toLowerCase().includes(q);
      return matchType && matchPosition && matchSearch;
    });

    if (sort === "추천순" && hasProfile) {
      return [...filtered].sort((a, b) => {
        const sa = a.matchScore ?? -1;
        const sb = b.matchScore ?? -1;
        if (sb !== sa) return sb - sa;
        return b.date.localeCompare(a.date);
      });
    }
    return [...filtered].sort((a, b) => b.date.localeCompare(a.date));
  }, [jobs, filter, positionFilter, searchQuery, sort, hasProfile, hiddenSeqs]);

  const getScoreColor = (score: number) => {
    if (score >= 80) return "bg-emerald-500 text-white";
    if (score >= 60) return "bg-blue-500 text-white";
    return "bg-gray-300 text-gray-700";
  };

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

  if (matchEnabled === null) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="max-w-md w-full bg-white rounded-xl border border-gray-100 p-8 text-center">
          <h1 className="text-2xl font-bold tracking-tight mb-2">Findar</h1>
          <p className="text-gray-500 mb-6">
            이력서/포트폴리오와 채용공고를 비교해 적합도 점수를 매기는
            <br />
            AI 매칭 기능을 사용할까요?
          </p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => chooseMatchEnabled(true)}
              className="px-4 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors"
            >
              매칭 사용
            </button>
            <button
              onClick={() => chooseMatchEnabled(false)}
              className="px-4 py-2.5 rounded-lg bg-white border border-gray-200 text-sm font-medium hover:bg-gray-50 transition-colors"
            >
              사용 안 함
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-4">
            선택한 값은 저장되며, 나중에 언제든 화면에서 바꿀 수 있어요.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Main content */}
      <div
        className={`flex-1 flex flex-col overflow-hidden transition-all duration-300 ${selectedJob ? "mr-[480px]" : ""}`}
      >
        <div className="flex-1 overflow-y-auto px-6 py-8 mx-auto w-full" style={{ maxWidth: 1200 }}>
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
                ["전체", "신입", "경력", "인턴"] as FilterType[]
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
              {viewMode === "hidden" ? (
                <span className="text-gray-400">숨긴 공고 {hiddenJobs.length}건</span>
              ) : loading ? (
                jobs.length > 0 ? `${jobs.length}건 로드됨...` : "데이터 수집 중..."
              ) : (
                <>
                  {filteredJobs.length}건
                  {!loading && newCount !== null && newCount > 0 && (
                    <span className="text-emerald-600"> · 신규 {newCount}건</span>
                  )}
                </>
              )}
            </span>
            <div className="flex items-center gap-2">
              {hiddenSeqs.size > 0 && (
                <button
                  onClick={() => setViewMode((v) => v === "hidden" ? "list" : "hidden")}
                  className={`text-xs px-2.5 py-1.5 rounded-lg border transition-colors flex items-center gap-1 ${
                    viewMode === "hidden"
                      ? "bg-gray-700 text-white border-gray-700"
                      : "bg-white text-gray-500 border-gray-200 hover:bg-gray-50"
                  }`}
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                    <line x1="1" y1="1" x2="23" y2="23"/>
                  </svg>
                  숨긴 공고 {hiddenSeqs.size}건
                </button>
              )}
              {viewMode === "list" && hasProfile && (
                <div className="flex bg-gray-100 rounded-lg p-0.5">
                  {(["추천순", "최신순"] as SortType[]).map((s) => (
                    <button
                      key={s}
                      onClick={() => setSort(s)}
                      className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                        sort === s
                          ? "bg-white text-gray-900 shadow-sm"
                          : "text-gray-500 hover:text-gray-700"
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
              {viewMode === "list" && (
                <>
                  <label
                    className={`flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-gray-200 bg-white text-gray-600 ${loading ? "opacity-50" : ""}`}
                    title="수집할 페이지 수 (1페이지 = 10건)"
                  >
                    <input
                      type="number"
                      inputMode="numeric"
                      min={MIN_PAGES}
                      max={MAX_PAGES}
                      value={pagesInput}
                      disabled={loading}
                      onChange={(e) => setPagesInput(e.target.value)}
                      onBlur={commitPagesInput}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitPagesInput();
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                      className="w-10 text-right bg-transparent focus:outline-none"
                    />
                    페이지 ({pages * 10}건)
                  </label>
                  <button
                    onClick={() => chooseMatchEnabled(!matchEnabled)}
                    title="이력서 매칭 사용 여부"
                    className={`text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${
                      matchEnabled
                        ? "bg-blue-50 border-blue-200 text-blue-700"
                        : "bg-white border-gray-200 text-gray-500 hover:bg-gray-50"
                    }`}
                  >
                    매칭 {matchEnabled ? "켜짐" : "꺼짐"}
                  </button>
                  <button
                    onClick={() => fetchJobs(matchEnabled, pages)}
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
                </>
              )}
            </div>
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
          {viewMode === "list" && (
            <>
              <div className="space-y-3 pb-8">
                {filteredJobs.map((job) => (
                  <JobCard
                    key={job.seq}
                    job={job}
                    isSelected={selectedJob?.seq === job.seq}
                    onSelect={setSelectedJob}
                    onHide={hideJob}
                    getScoreColor={getScoreColor}
                    getBadgeColor={getBadgeColor}
                  />
                ))}
              </div>
              {!loading && filteredJobs.length === 0 && jobs.length > 0 && (
                <div className="text-center py-12 text-gray-400">
                  검색 결과가 없습니다
                </div>
              )}
            </>
          )}

          {/* Hidden jobs view */}
          {viewMode === "hidden" && (
            <div className="space-y-3 pb-8">
              {hiddenJobs.length === 0 ? (
                <div className="text-center py-12 text-gray-400">
                  숨긴 공고가 없습니다
                </div>
              ) : (
                hiddenJobs.map((job) => (
                  <div
                    key={job.seq}
                    className="bg-white rounded-xl p-5 border border-gray-100 opacity-70"
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
                        </div>
                        <h3 className="font-semibold text-gray-700 mb-1 truncate">
                          {job.title}
                        </h3>
                        {job.jdSummary && (
                          <p className="text-sm text-gray-400 line-clamp-1">
                            {job.jdSummary}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-2 shrink-0">
                        <div className="text-xs text-gray-400">{job.date}</div>
                        <button
                          onClick={() => unhideJob(job.seq)}
                          className="text-xs px-2.5 py-1 rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors whitespace-nowrap"
                        >
                          숨김 해제
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
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

              {typeof selectedJob.matchScore === "number" && (
                <div className="mb-5 p-4 rounded-xl bg-gradient-to-br from-gray-50 to-white border border-gray-100">
                  <div className="flex items-center gap-3 mb-2">
                    <div
                      className={`text-2xl font-bold w-14 h-14 rounded-xl flex items-center justify-center ${getScoreColor(selectedJob.matchScore)}`}
                    >
                      {selectedJob.matchScore}
                    </div>
                    <div>
                      <div className="text-xs text-gray-400">매칭 점수</div>
                      <div className="text-sm font-semibold text-gray-700">
                        {selectedJob.matchVerdict ?? "-"}
                      </div>
                    </div>
                  </div>
                  {selectedJob.matchReasoning && (
                    <p className="text-sm text-gray-600 leading-relaxed">
                      {selectedJob.matchReasoning}
                    </p>
                  )}
                  {selectedJob.matchStrengths && selectedJob.matchStrengths.length > 0 && (
                    <div className="mt-3">
                      <div className="text-xs font-semibold text-emerald-700 mb-1">강점</div>
                      <ul className="text-sm text-gray-700 space-y-1">
                        {selectedJob.matchStrengths.map((s, i) => (
                          <li key={i} className="flex gap-2">
                            <span className="text-emerald-500 shrink-0">+</span>
                            <span>{s}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {selectedJob.matchGaps && selectedJob.matchGaps.length > 0 && (
                    <div className="mt-3">
                      <div className="text-xs font-semibold text-amber-700 mb-1">갭</div>
                      <ul className="text-sm text-gray-700 space-y-1">
                        {selectedJob.matchGaps.map((g, i) => (
                          <li key={i} className="flex gap-2">
                            <span className="text-amber-500 shrink-0">-</span>
                            <span>{g}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

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
            <div className="p-5 border-t border-gray-100 space-y-2">
              {selectedJob.siteUrl && (
                <a
                  href={selectedJob.siteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-center px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
                >
                  지원 사이트 바로가기
                </a>
              )}
              <a
                href={`https://www.kofia.or.kr/brd/m_96/view.do?seq=${selectedJob.seq}`}
                target="_blank"
                rel="noopener noreferrer"
                className={
                  selectedJob.siteUrl
                    ? "block text-center px-4 py-2.5 bg-gray-100 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-200 transition-colors"
                    : "block text-center px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
                }
              >
                KOFIA 원문 보기
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function JobCard({
  job,
  isSelected,
  onSelect,
  onHide,
  getScoreColor,
  getBadgeColor,
}: {
  job: JobSummary;
  isSelected: boolean;
  onSelect: (job: JobSummary) => void;
  onHide: (seq: string) => void;
  getScoreColor: (score: number) => string;
  getBadgeColor: (type: string) => string;
}) {
  return (
    <div
      onClick={() => onSelect(job)}
      className={`group bg-white rounded-xl p-5 border transition-all cursor-pointer ${
        isSelected
          ? "border-blue-400 shadow-md ring-1 ring-blue-200"
          : "border-gray-100 hover:border-blue-200 hover:shadow-md"
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            {typeof job.matchScore === "number" && (
              <span
                className={`text-xs px-2 py-0.5 rounded-full font-bold ${getScoreColor(job.matchScore)}`}
                title={job.matchReasoning}
              >
                {job.matchScore}
              </span>
            )}
            <span className="text-sm font-medium text-blue-600">
              {job.company}
            </span>
            <span
              className={`text-xs px-2 py-0.5 rounded-full font-medium ${getBadgeColor(job.positionType)}`}
            >
              {job.positionType}
            </span>
            {job.experienceYears && job.experienceYears !== "미분류" && (
              <span className="text-xs text-gray-400">{job.experienceYears}</span>
            )}
          </div>
          <h3 className="font-semibold text-gray-900 mb-1.5 truncate">
            {job.title}
          </h3>
          {job.jdSummary && (
            <p className="text-sm text-gray-500 line-clamp-2">{job.jdSummary}</p>
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
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <div className="text-xs text-gray-400">{job.date}</div>
          {job.deadline && (
            <div className="text-xs text-red-500">~{job.deadline}</div>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onHide(job.seq);
            }}
            className="opacity-0 group-hover:opacity-100 text-xs px-2 py-0.5 rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-all"
            title="숨기기"
          >
            숨기기
          </button>
        </div>
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
