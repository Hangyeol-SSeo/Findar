"use client";

import { useCallback, useEffect, useState } from "react";

type Precision = "exact" | "approx" | "unknown";
interface Card {
  id: string; event_id: string; period: string; context: string;
  team_result: string[]; personal_actions: string[]; decision: string[]; observed_details: string[];
  constraints: string[]; alternatives_considered: string[]; result_limitations: string[];
  evidence: { entryId: string; sourceFile: string; kind: string; quote: string }[];
  precision: Record<string, Precision>; sensitive: boolean; user_confirmed: boolean; droppedItems: string[];
  origins?: { company: string; context: string; question: string; kind: string }[];
}
interface CardState {
  cards: Card[]; generatedAt: number | null; error: string; stale: boolean; running: boolean; essayRunning: boolean; sourceCount: number; coversProfile: boolean;
}
const SOURCE_LABEL: Record<string, string> = { cover_letter: "자기소개서", interview: "면접 대본", final: "확정한 답변", resume: "이력서", applicant: "지원 정보" };

const FIELDS: [keyof Card, string][] = [
  ["personal_actions", "내가 한 일"], ["decision", "내 판단·선택"], ["team_result", "팀이 이룬 결과"],
  ["observed_details", "구체 장면"], ["constraints", "당시 제약"], ["alternatives_considered", "검토했다 접은 대안"],
  ["result_limitations", "결과의 한계"],
];
const PRECISION_LABEL: Record<Precision, string> = { exact: "정확", approx: "근사", unknown: "불명" };

export default function ExperienceCardList({ showToast }: { showToast: (msg: string) => void }) {
  const [state, setState] = useState<CardState | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/experience-cards", { cache: "no-store" });
    setState(await res.json());
  }, []);

  useEffect(() => { load().catch(() => setError("경험 카드를 불러오지 못했습니다.")); }, [load]);

  // 과거 자료 분석이 끝나면 카드 정리가 이어서 돈다. 둘 중 하나라도 도는 동안만 다시 읽는다.
  const polling = !!state && (state.running || state.essayRunning);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => { load().catch(() => {}); }, 4000);
    return () => clearInterval(timer);
  }, [polling, load]);

  async function rebuild() {
    setBusy("rebuild");
    setError("");
    try {
      const res = await fetch("/api/experience-cards", { method: "POST" });
      setState(await res.json());
    } catch {
      setError("카드 정리를 시작하지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  async function confirm(card: Card, confirmed: boolean) {
    setBusy(card.id);
    setError("");
    try {
      const res = await fetch("/api/experience-cards", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: card.id, confirmed }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setState(body);
      showToast(confirmed ? `${card.id}를 확인했습니다` : `${card.id} 확인을 취소했습니다`);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "처리하지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  if (!state) return error ? <p className="text-sm text-red-600">{error}</p> : null;
  if (!state.sourceCount && !state.cards.length) return null;

  const confirmedCount = state.cards.filter((c) => c.user_confirmed).length;
  const working = state.running || state.essayRunning;

  return (
    <div className="mt-6 rounded-xl border border-gray-100 bg-white p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-700">경험 카드 <span className="font-normal text-gray-400">확인 {confirmedCount} / {state.cards.length}</span></h3>
          <p className="mt-1 text-xs leading-5 text-gray-500">
            이력서·지원 정보의 경험 항목과 올린 과거 자료를 사건 단위로 정리한 카드입니다. 같은 경험은 하나로 묶습니다. 읽어 보고 사실과 맞는 카드만 <b>확인</b>해주세요.
            <b>확인한 카드만 자기소개서 작성에 쓰이고</b>, 작성할 때도 문항 요구에 맞는 카드만 고르며 맞는 카드가 없으면 쓰지 않습니다.
            {state.coversProfile && <> 이력서 경험도 이제 카드로만 쓰입니다.</>}
          </p>
        </div>
        {working ? (
          <span className="text-xs text-gray-500" aria-live="polite">{state.essayRunning ? "과거 자료 분석 중..." : "경험 카드 정리 중..."}</span>
        ) : (state.stale || state.error) && (
          <button onClick={rebuild} disabled={!!busy}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40">
            {state.cards.length ? "카드 다시 만들기" : "경험 카드 만들기"}
          </button>
        )}
      </div>

      {state.stale && !working && state.cards.length > 0 && (
        <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">과거 자료가 바뀌었습니다. 카드를 다시 만들면 내용이 같은 카드는 확인이 유지되고, 달라진 카드는 다시 확인해야 합니다.</p>
      )}
      {(error || state.error) && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error || state.error}</p>}
      {!state.cards.length && !working && !state.error && (
        <p className="text-sm text-gray-400">아직 카드가 없습니다. 과거 자료를 분석한 뒤 카드를 만들어주세요.</p>
      )}

      <ul className="space-y-3">
        {state.cards.map((card) => (
          <li key={card.id} className={`rounded-lg border p-4 text-sm ${card.user_confirmed ? "border-emerald-200 bg-emerald-50/40" : "border-gray-100"}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium text-gray-800">{card.context || "(맥락 없음)"}</p>
                <p className="text-xs text-gray-400">
                  {card.id} · 사건 {card.event_id} · {card.period}
                  {card.sensitive && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">민감 정보 포함</span>}
                </p>
              </div>
              <button onClick={() => confirm(card, !card.user_confirmed)} disabled={!!busy || working}
                className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-40 ${card.user_confirmed ? "border border-gray-200 text-gray-600 hover:bg-gray-50" : "bg-emerald-600 text-white hover:bg-emerald-700"}`}>
                {card.user_confirmed ? "확인 취소" : "확인"}
              </button>
            </div>
            {!!card.origins?.length && (
              <p className="mt-2 text-xs text-gray-500">
                출처: {card.origins.map((o) => (o.kind === "resume" || o.kind === "applicant") ? [SOURCE_LABEL[o.kind], o.context].join(" · ") : [o.company || "회사 미상", SOURCE_LABEL[o.kind], o.context].filter(Boolean).join(" · ")).filter((v, i, a) => a.indexOf(v) === i).join(" / ")}
                <span className="text-gray-400"> — 다른 회사 이름은 작성 때 가려지고, 답변에 쓰이면 거부됩니다.</span>
              </p>
            )}
            <dl className="mt-3 space-y-2">
              {FIELDS.filter(([key]) => (card[key] as string[]).length).map(([key, label]) => (
                <div key={key}>
                  <dt className="text-xs font-semibold text-gray-500">{label}</dt>
                  <dd><ul className="ml-4 list-disc text-gray-700">{(card[key] as string[]).map((t, i) => <li key={i}>{t}</li>)}</ul></dd>
                </div>
              ))}
            </dl>
            {Object.keys(card.precision).length > 0 && (
              <p className="mt-2 flex flex-wrap gap-1 text-xs">
                {Object.entries(card.precision).map(([k, v]) => (
                  <span key={k} className={`rounded px-1.5 py-0.5 ${v === "unknown" ? "bg-gray-100 text-gray-500" : "bg-blue-50 text-blue-700"}`}>{k}: {PRECISION_LABEL[v]}</span>
                ))}
              </p>
            )}
            {card.droppedItems.length > 0 && (
              <p className="mt-2 text-xs text-amber-700">원문 구절에 없는 수치가 들어 있어 뺀 내용: {card.droppedItems.join(" / ")}</p>
            )}
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-gray-500">원문 근거 {card.evidence.length}개</summary>
              <ul className="mt-2 space-y-2">
                {card.evidence.map((e, i) => (
                  <li key={i} className="rounded bg-gray-50 p-2">
                    <p className="text-gray-400">{SOURCE_LABEL[e.kind] ?? "자료"}{e.sourceFile && ` · ${e.sourceFile.split("/").pop()}`}</p>
                    <p className="mt-1 whitespace-pre-wrap text-gray-600">{e.quote}</p>
                  </li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ul>
      <p className="text-xs text-gray-400">카드 형식과 정리 규칙은 공개 스킬 cover-letter-team(MIT)의 경험카드 스키마를 그대로 따릅니다.</p>
    </div>
  );
}
