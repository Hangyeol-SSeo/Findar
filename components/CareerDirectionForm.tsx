"use client";

import { useState, useEffect } from "react";

export default function CareerDirectionForm({ showToast }: { showToast: (message: string) => void }) {
  const [careerGoals, setCareerGoals] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/profile/overrides", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("지원 방향을 불러오지 못했습니다.");
        const result: { careerGoals: string } = await response.json();
        setCareerGoals(result.careerGoals);
      })
      .catch(() => { if (!controller.signal.aborted) setError("지원 방향을 불러오지 못했습니다. 페이지를 다시 열어주세요."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  async function save() {
    setSaving(true);
    try {
      const response = await fetch("/api/profile/overrides", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ careerGoals }),
      });
      showToast(response.ok ? "지원 방향을 저장했습니다" : "저장에 실패했습니다");
    } catch { showToast("저장에 실패했습니다"); }
    finally { setSaving(false); }
  }

  return (
    <div className="rounded-xl border border-gray-100 bg-white p-5">
      <label htmlFor="career-direction" className="mb-2 block text-sm font-semibold text-gray-700">지원 의도 / 방향</label>
      <p id="career-direction-description" className="mb-3 text-xs leading-5 text-gray-400">
        예: 컴퓨터공학 전공·개발 경험이 있지만, 금융/리스크관리에 관심이 많아 개발 외 직군에도 폭넓게 지원하고 싶습니다.
        특정 직군에 한정하지 말고 평가해주세요.
      </p>
      {error && <p role="alert" className="mb-3 text-sm text-red-600">{error}</p>}
      <textarea id="career-direction" aria-describedby="career-direction-description" value={careerGoals}
        onChange={(event) => setCareerGoals(event.target.value)} disabled={loading || saving || !!error} rows={6}
        placeholder="어떤 일을 하고 싶은지 자유롭게 적어주세요"
        className="w-full rounded-lg border border-gray-200 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:opacity-50" />
      <button type="button" onClick={() => void save()} disabled={loading || saving || !!error}
        className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50">
        {saving ? "저장 중..." : "지원 방향 저장"}
      </button>
    </div>
  );
}
