"use client";

import { useEffect, useState } from "react";
import type { SeasonAlertView, SeasonAlertsResponse } from "@/lib/season-alert-types";

const POLL_MS = 20_000;

// 보드 위 공채 소식 알림(lib/hiring-season.ts). 자동으로 공고를 받지 못하는 회사의 이번 시즌 신입 공채 보도를 보여 주고,
// "공고로 추가"를 누르면 공고 직접 추가 창을 회사·제목·채용 사이트·마감일을 채운 채 연다. 보드에 이미 같은 공고가 있으면
// 서버가 알림을 빼서 보낸다. 확인은 공고 새로고침 뒤 백그라운드로 돌아서, 도는 동안에는 잠시마다 다시 읽는다.
export default function SeasonAlerts({
  refreshKey,
  onAdd,
}: {
  refreshKey: number;
  onAdd: (alert: SeasonAlertView) => void;
}) {
  const [data, setData] = useState<SeasonAlertsResponse | null>(null);

  // 새로고침이 끝날 때(refreshKey)와, 서버에서 확인이 도는 동안 잠시마다 다시 읽는다.
  const [poll, setPoll] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/season-alerts", { cache: "no-store", signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((result: SeasonAlertsResponse | null) => { if (result) setData(result); })
      .catch(() => { /* 알림은 보조 기능이라 조용히 넘어간다 */ });
    return () => controller.abort();
  }, [refreshKey, poll]);

  useEffect(() => {
    if (!data?.running) return;
    const timer = setTimeout(() => setPoll((n) => n + 1), POLL_MS);
    return () => clearTimeout(timer);
  }, [data]);

  async function dismiss(id: number) {
    setData((prev) => (prev ? { ...prev, alerts: prev.alerts.filter((a) => a.id !== id) } : prev));
    await fetch("/api/season-alerts", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "dismiss", id }),
    }).catch(() => {});
  }

  if (!data || (data.alerts.length === 0 && !data.running)) return null;

  return (
    <div className="mb-6 rounded-xl border border-violet-100 bg-violet-50/60 px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-violet-900">금투협에 없는 공채 소식 · {data.season}</h3>
        {data.running && <span className="text-xs text-violet-500">공채 소식 확인 중...</span>}
      </div>
      {data.alerts.length > 0 && (
        <ul className="mt-2 divide-y divide-violet-100">
          {data.alerts.map((alert) => (
            <li key={alert.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-gray-800">
                  <span className="font-medium">{alert.company}</span>{" "}
                  {alert.title}
                  {alert.deadline && <span className="ml-1.5 text-xs text-red-500">~{alert.deadline}</span>}
                </div>
                {alert.evidence && <div className="mt-0.5 text-xs text-gray-500">{alert.evidence}</div>}
              </div>
              <div className="flex shrink-0 items-center gap-3 text-xs">
                <a href={alert.articleUrl} target="_blank" rel="noopener noreferrer" className="text-gray-500 hover:underline">기사</a>
                {alert.recruitUrl && (
                  <a href={alert.recruitUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">채용 사이트</a>
                )}
                <button type="button" onClick={() => onAdd(alert)} className="font-medium text-violet-700 hover:underline">공고로 추가</button>
                <button type="button" onClick={() => dismiss(alert.id)} className="text-gray-400 hover:text-gray-600" aria-label={`${alert.company} 공채 소식 닫기`}>닫기</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
