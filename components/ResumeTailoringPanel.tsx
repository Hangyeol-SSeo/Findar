"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { taskActive, type ApplicationTask } from "@/lib/application-task-types";
import {
  DECISION_DESCRIPTIONS,
  DECISION_ORDER,
  type ResumeItem,
  type ResumeTailoringResult,
  type TailoringDecision,
  type TailoringEvaluation,
} from "@/lib/resume-tailoring-contract";

const DECISION_STYLES: Record<TailoringDecision, { badge: string; chip: string }> = {
  강조: { badge: "bg-emerald-100 text-emerald-800", chip: "border-emerald-200 text-emerald-800" },
  유지: { badge: "bg-blue-100 text-blue-800", chip: "border-blue-200 text-blue-800" },
  축소: { badge: "bg-amber-100 text-amber-800", chip: "border-amber-200 text-amber-800" },
  제외: { badge: "bg-gray-200 text-gray-700", chip: "border-gray-300 text-gray-700" },
  "숨김 검토": { badge: "bg-rose-100 text-rose-800", chip: "border-rose-200 text-rose-800" },
  "판단 보류": { badge: "bg-purple-100 text-purple-800", chip: "border-purple-200 text-purple-800" },
};

interface TailoringResponse {
  result: ResumeTailoringResult | null;
  stale: boolean;
  hasResume: boolean;
  hasApplicantProfile: boolean;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function ResumeTailoringPanel({ seq }: { seq: string }) {
  const [data, setData] = useState<TailoringResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [task, setTask] = useState<ApplicationTask | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<TailoringDecision | "전체">("전체");
  const [copied, setCopied] = useState("");
  const lifetime = useRef<AbortController | null>(null);
  const polling = useRef<AbortSignal | null>(null);

  const load = useCallback(async (signal: AbortSignal) => {
    const res = await fetch(`/api/applications/${seq}/tailoring`, { cache: "no-store", signal });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "불러오지 못했습니다.");
    if (!signal.aborted) setData(body);
  }, [seq]);

  // 진행 중인 평가 작업을 폴링한다. 서버 백그라운드 작업이라 탭을 옮겼다 돌아와도 이어서 보인다.
  const poll = useCallback(async (signal: AbortSignal) => {
    // 같은 화면 수명(signal) 안에서는 루프를 하나만 돌린다. StrictMode 재마운트처럼 이전 signal이
    // 이미 abort된 루프와는 겹쳐도 된다 — 그쪽은 다음 확인 때 스스로 끝난다.
    if (polling.current === signal) return;
    polling.current = signal;
    let failures = 0;
    try {
      while (!signal.aborted) {
        try {
          const res = await fetch(`/api/applications/${seq}/tasks`, { cache: "no-store", signal });
          if (!res.ok) throw new Error();
          const { tasks }: { tasks: ApplicationTask[] } = await res.json();
          const latest = tasks.filter((t) => t.kind === "tailoring").sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
          if (signal.aborted) return;
          setTask(latest);
          if (!latest || !taskActive(latest)) {
            if (latest?.status === "failed") setError(latest.error ?? "평가에 실패했습니다.");
            if (latest?.status === "completed") await load(signal);
            return;
          }
          failures = 0;
        } catch {
          if (signal.aborted) return;
          if (++failures >= 3) {
            setError("작업 상태를 확인하지 못했습니다. 탭을 다시 열어주세요.");
            return;
          }
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    } finally {
      if (polling.current === signal) polling.current = null;
    }
  }, [seq, load]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    load(controller.signal)
      .catch((e) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "불러오지 못했습니다."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    void poll(controller.signal);
    return () => controller.abort();
  }, [load, poll]);

  async function start() {
    const signal = lifetime.current?.signal;
    if (!signal) return;
    setError("");
    try {
      const res = await fetch(`/api/applications/${seq}/tailoring`, { method: "POST", signal });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "평가를 시작하지 못했습니다.");
      setTask(body.task);
      void poll(signal);
    } catch (e) {
      if (!signal.aborted) setError(e instanceof Error ? e.message : "평가를 시작하지 못했습니다.");
    }
  }

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? "" : c)), 1500);
    } catch {
      setError("클립보드에 복사하지 못했습니다.");
    }
  }

  const result = data?.result ?? null;
  const itemsById = useMemo(() => new Map((result?.items ?? []).map((i) => [i.id, i])), [result]);
  const counts = useMemo(() => {
    const c = new Map<TailoringDecision, number>();
    for (const e of result?.evaluations ?? []) c.set(e.decision, (c.get(e.decision) ?? 0) + 1);
    return c;
  }, [result]);
  const visible = (result?.evaluations ?? []).filter((e) => filter === "전체" || e.decision === filter);
  const running = !!task && taskActive(task);

  if (loading) return <p className="py-8 text-center text-sm text-gray-400">불러오는 중...</p>;

  const noSources = data && !data.hasResume && !data.hasApplicantProfile;

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-gray-200 p-4 space-y-3">
        <div>
          <h3 className="font-semibold text-gray-800">이 공고 기준 이력 취사선택</h3>
          <p className="mt-1 text-xs leading-5 text-gray-500">
            이력서와 지원 정보의 항목을 하나씩 이 공고와 비교해 강조·유지·축소·제외·숨김 검토로 나눕니다. 사실을 바꾸지 않고
            무엇을 앞세우고 무엇을 덜어낼지만 판단하며, 빼면 오히려 문제가 될 수 있는 항목(경력 누락 등)은 따로 경고합니다.
          </p>
        </div>
        {noSources ? (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
            평가할 이력이 없습니다. <Link href="/settings" className="font-medium underline">설정 → 이력서</Link>에서 이력서 PDF를 올리거나
            지원 정보를 먼저 입력해주세요.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={start}
              disabled={running}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
            >
              {running ? "평가 중..." : result ? "다시 평가" : "이력 평가하기"}
            </button>
            {running && task && (
              <span className="text-xs text-gray-500" role="status">
                {task.done === 0 ? "이력서 항목 정리 중 (처음 한 번은 몇 분 걸릴 수 있어요)" : "공고와 비교 중"} · {task.done}/{task.total}
                · 탭을 옮겨도 계속 진행됩니다
              </span>
            )}
            {!running && result && (
              <span className="text-xs text-gray-400">
                {result.targetRole ? `${result.targetRole} · ` : ""}{formatDate(result.generatedAt)} 평가 · 항목 {result.items.length}개
              </span>
            )}
          </div>
        )}
        {data && !data.hasResume && data.hasApplicantProfile && (
          <p className="text-xs text-gray-500">
            업로드된 이력서가 없어 지원 정보 항목만 평가합니다. <Link href="/settings" className="text-blue-600 underline">이력서 올리기</Link>
          </p>
        )}
      </section>

      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {data?.stale && result && !running && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          평가 이후 이력서·지원 정보·지원 방향·지원 직무 또는 모델 설정이 바뀌었습니다. 다시 평가하면 반영됩니다.
        </p>
      )}

      {result && (
        <>
          {(result.focus || result.summary) && (
            <section className="rounded-xl bg-gradient-to-br from-blue-50 to-white border border-blue-100 p-4 space-y-2">
              {result.focus && (
                <>
                  <div className="text-xs font-semibold text-blue-700">핵심 메시지</div>
                  <p className="text-sm font-medium text-gray-800 leading-relaxed">{result.focus}</p>
                </>
              )}
              {result.summary && <p className="text-sm text-gray-600 leading-relaxed">{result.summary}</p>}
            </section>
          )}

          {result.sectionOrder.length > 0 && (
            <section>
              <h4 className="text-xs font-semibold text-gray-500 mb-2">권장 섹션 순서</h4>
              <ol className="flex flex-wrap items-center gap-1.5 text-sm">
                {result.sectionOrder.map((s, i) => (
                  <li key={i} className="flex items-center gap-1.5">
                    {i > 0 && <span aria-hidden="true" className="text-gray-300">→</span>}
                    <span className="rounded-md bg-gray-100 px-2 py-0.5 text-gray-700">{s}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <section className="space-y-3">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="판정별 보기">
              <button
                onClick={() => setFilter("전체")}
                aria-pressed={filter === "전체"}
                className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${filter === "전체" ? "bg-gray-800 text-white border-gray-800" : "bg-white text-gray-600 border-gray-200"}`}
              >
                전체 {result.evaluations.length}
              </button>
              {DECISION_ORDER.filter((d) => counts.get(d)).map((d) => (
                <button
                  key={d}
                  onClick={() => setFilter(filter === d ? "전체" : d)}
                  aria-pressed={filter === d}
                  title={DECISION_DESCRIPTIONS[d]}
                  className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${filter === d ? `${DECISION_STYLES[d].badge} border-transparent` : `bg-white ${DECISION_STYLES[d].chip}`}`}
                >
                  {d} {counts.get(d)}
                </button>
              ))}
            </div>
            {filter !== "전체" && <p className="text-xs text-gray-500">{DECISION_DESCRIPTIONS[filter]}</p>}

            {visible.map((e, i) => (
              <EvaluationCard
                key={`${e.itemIds.join(",")}-${i}`}
                evaluation={e}
                items={e.itemIds.map((id) => itemsById.get(id)).filter((x): x is ResumeItem => !!x)}
                copied={copied === e.itemIds.join(",")}
                onCopy={() => copy(e.rewrite, e.itemIds.join(","))}
              />
            ))}
          </section>

          {result.watchouts.length > 0 && (
            <section className="rounded-xl border border-amber-100 bg-amber-50/50 p-4">
              <h4 className="text-xs font-semibold text-amber-800 mb-2">서류·면접에서 대비할 점</h4>
              <ul className="space-y-1 text-sm text-gray-700">
                {result.watchouts.map((w, i) => (
                  <li key={i} className="flex gap-2"><span className="text-amber-500 shrink-0">!</span><span>{w}</span></li>
                ))}
              </ul>
            </section>
          )}

          <p className="text-xs leading-5 text-gray-400">
            AI 판단은 참고용입니다. 특히 &lsquo;숨김 검토&rsquo;·&lsquo;제외&rsquo; 항목은 지원 양식이 해당 이력의 기재를 요구하는지 직접 확인해주세요.
            이력을 빼는 것과 사실과 다르게 적는 것은 다릅니다.
          </p>
        </>
      )}
    </div>
  );
}

function EvaluationCard({
  evaluation: e,
  items,
  copied,
  onCopy,
}: {
  evaluation: TailoringEvaluation;
  items: ResumeItem[];
  copied: boolean;
  onCopy: () => void;
}) {
  const sources = [...new Set(items.map((i) => (i.source === "resume" ? "이력서" : "지원 정보")))];
  const muted = e.decision === "제외";
  return (
    <article className={`rounded-xl border p-4 space-y-2 ${muted ? "border-gray-100 bg-gray-50/60" : "border-gray-200 bg-white"}`}>
      <div className="flex items-start gap-2">
        <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold ${DECISION_STYLES[e.decision].badge}`}>{e.decision}</span>
        <h5 className={`flex-1 text-sm font-semibold ${muted ? "text-gray-500 line-through decoration-gray-300" : "text-gray-800"}`}>{e.label}</h5>
        <span className="shrink-0 text-[11px] text-gray-400">{sources.join(" · ")}</span>
      </div>
      {e.reasons.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {e.reasons.map((r, i) => (
            <span key={i} className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600">{r}</span>
          ))}
        </div>
      )}
      {e.rationale && <p className="text-sm leading-relaxed text-gray-600">{e.rationale}</p>}
      {e.rewrite && (
        <div className="rounded-lg bg-blue-50/60 p-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-semibold text-blue-700">권장 기재 문구</span>
            <button onClick={onCopy} className="text-xs text-blue-600 hover:underline">{copied ? "복사됨" : "복사"}</button>
          </div>
          <p className="whitespace-pre-wrap text-sm text-gray-800">{e.rewrite}</p>
        </div>
      )}
      {e.omissionRisk && (
        <p className="rounded-lg bg-amber-50 p-2.5 text-xs leading-5 text-amber-900">
          <span className="font-semibold">빼거나 숨길 때 주의 · </span>{e.omissionRisk}
        </p>
      )}
      {items.length > 0 && (
        <details className="text-xs text-gray-500">
          <summary className="cursor-pointer select-none">원래 항목 보기{items.length > 1 ? ` (${items.length}개 묶음)` : ""}</summary>
          <ul className="mt-2 space-y-2">
            {items.map((i) => (
              <li key={i.id} className="rounded-lg bg-gray-50 p-2">
                <div className="font-medium text-gray-700">
                  [{i.source === "resume" ? "이력서" : "지원 정보"} · {i.section}] {i.title}
                  {i.period && <span className="font-normal text-gray-400"> · {i.period}</span>}
                </div>
                {i.detail && <p className="mt-0.5 whitespace-pre-wrap leading-5">{i.detail}</p>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}
