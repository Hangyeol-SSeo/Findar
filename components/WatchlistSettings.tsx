"use client";

import { useEffect, useState } from "react";
import type { WatchRunStatus, WatchlistCompanyView, WatchlistResponse, WatchlistSourceView } from "@/lib/watchlist-types";

const STATUS_LABELS: Record<WatchRunStatus, { text: string; className: string }> = {
  ok: { text: "확인함", className: "bg-emerald-50 text-emerald-700" },
  empty: { text: "공고 없음", className: "bg-gray-100 text-gray-600" },
  failed: { text: "실패", className: "bg-red-50 text-red-700" },
  blocked: { text: "차단됨", className: "bg-amber-50 text-amber-800" },
};

function formatRanAt(ms: number): string {
  return new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}

function siteHost(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

export default function WatchlistSettings({ showToast }: { showToast: (message: string) => void }) {
  const [companies, setCompanies] = useState<WatchlistCompanyView[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function load(signal?: AbortSignal) {
    try {
      const response = await fetch("/api/watchlist", { cache: "no-store", signal });
      if (!response.ok) throw new Error();
      const result: WatchlistResponse = await response.json();
      setCompanies(result.companies);
      setError("");
    } catch {
      if (!signal?.aborted) setError("수집 범위를 불러오지 못했습니다.");
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, []);

  async function patch(name: string, body: { enabled?: boolean; recheck?: boolean }, done: string) {
    setBusy(name);
    try {
      const response = await fetch("/api/watchlist", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, ...body }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "저장하지 못했습니다.");
      await load();
      showToast(done);
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : "저장하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!companies) return <p className="text-sm text-gray-400">불러오는 중...</p>;

  const collected = companies.filter((c) => c.sources.some((s) => s.collectable));
  const manual = companies
    .flatMap((c) => c.sources.filter((s) => !s.collectable).map((source) => ({ company: c, source })));

  return (
    <div className="space-y-8">
      <div>
        <h3 className="text-sm font-semibold text-gray-700">자동으로 확인하는 채용 사이트 ({collected.length}곳)</h3>
        <p className="mt-1 text-xs text-gray-500">
          공고를 새로고침할 때 사이트마다 하루 한 번 확인합니다. 금투협에 이미 올라온 공고는 하나로 합쳐 보여 줍니다.
        </p>
        <ul className="mt-3 divide-y divide-gray-100 rounded-xl border border-gray-100 bg-white">
          {collected.map((company) => (
            <li key={company.name} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-medium ${company.enabled ? "text-gray-800" : "text-gray-400"}`}>{company.name}</span>
                  <span className="text-xs text-gray-400">{company.segment}</span>
                </div>
                {company.sources.filter((s) => s.collectable).map((source) => (
                  <SourceLine key={source.url} source={source} />
                ))}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <button
                  type="button"
                  disabled={busy === company.name || !company.enabled}
                  onClick={() => patch(company.name, { recheck: true }, `${company.name}: 다음 새로고침 때 다시 확인합니다.`)}
                  className="text-xs text-blue-600 hover:underline disabled:text-gray-300 disabled:no-underline"
                >
                  다시 확인
                </button>
                <label className="flex items-center gap-1.5 text-xs text-gray-600">
                  <input
                    type="checkbox"
                    checked={company.enabled}
                    disabled={busy === company.name}
                    onChange={(e) => patch(company.name, { enabled: e.target.checked }, `${company.name}: ${e.target.checked ? "확인합니다" : "확인하지 않습니다"}.`)}
                  />
                  확인
                </label>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-gray-700">직접 확인할 채용 사이트 ({manual.length}곳)</h3>
        <p className="mt-1 text-xs text-gray-500">
          자동으로 받지 못하는 곳입니다. 차단된 사이트는 우회하지 않습니다. 공채 시기에 열어 보고, 필요한 공고는 보드의 “공고 직접 추가”로 넣어 주세요.
        </p>
        <ul className="mt-3 divide-y divide-gray-100 rounded-xl border border-gray-100 bg-white">
          {manual.map(({ company, source }) => (
            <li key={`${company.name}-${source.url}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5">
              <span className="w-40 shrink-0 text-sm text-gray-800">{company.name}</span>
              <span className="text-xs text-gray-500">{source.label}{source.note ? ` · ${source.note}` : ""}</span>
              {source.type !== "saraminApi" && (
                <a href={source.url} target="_blank" rel="noopener noreferrer" className="ml-auto text-xs text-blue-600 hover:underline">
                  {siteHost(source.url)} ↗
                </a>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function SourceLine({ source }: { source: WatchlistSourceView }) {
  const run = source.lastRun;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
      <a href={source.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
        {source.label} · {siteHost(source.url)}
      </a>
      {run ? (
        <>
          <span className={`rounded px-1.5 py-0.5 ${STATUS_LABELS[run.status].className}`}>{STATUS_LABELS[run.status].text}</span>
          <span className="text-gray-400">{formatRanAt(run.ranAt)} · {run.message}</span>
        </>
      ) : (
        <span className="text-gray-400">아직 확인 전</span>
      )}
    </div>
  );
}
