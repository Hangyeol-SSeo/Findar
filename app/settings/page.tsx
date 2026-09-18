"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import ApplicantProfileForm from "@/components/ApplicantProfileForm";
import Toast, { useToast } from "@/components/Toast";

export default function SettingsPage() {
  const [careerGoals, setCareerGoals] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { message: toastMessage, showToast } = useToast();

  useEffect(() => {
    fetch("/api/profile/overrides")
      .then((r) => r.json())
      .then(({ careerGoals }: { careerGoals: string }) =>
        setCareerGoals(careerGoals)
      )
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/profile/overrides", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ careerGoals }),
      });
      showToast(res.ok ? "저장되었습니다" : "저장에 실패했습니다");
    } catch {
      showToast("저장에 실패했습니다");
    } finally {
      setSaving(false);
    }
  }, [careerGoals, showToast]);

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <Toast message={toastMessage} />
      <Link
        href="/"
        className="text-sm text-gray-400 hover:text-gray-600 transition-colors"
      >
        ← 목록으로
      </Link>

      <h1 className="text-2xl font-bold tracking-tight mt-3 mb-1">설정</h1>
      <p className="text-gray-500 mb-6">
        이력서만으로는 알 수 없는 지원 의도를 직접 적어두면 AI 매칭이 참고합니다.
      </p>

      <div className="bg-white rounded-xl border border-gray-100 p-5 mb-8">
        <label className="block text-sm font-semibold text-gray-700 mb-2">
          지원 의도 / 방향
        </label>
        <p className="text-xs text-gray-400 mb-3">
          예: 컴퓨터공학 전공·개발 경험이 있지만, 금융/리스크관리에 관심이 많아 개발 외
          직군에도 폭넓게 지원하고 싶습니다. 특정 직군에 한정하지 말고 평가해주세요.
        </p>
        <textarea
          value={careerGoals}
          onChange={(e) => setCareerGoals(e.target.value)}
          disabled={loading}
          rows={6}
          placeholder="자유롭게 서술해주세요"
          className="w-full text-sm border border-gray-200 rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:opacity-50"
        />
        <div className="flex items-center gap-3 mt-3">
          <button
            onClick={save}
            disabled={loading || saving}
            className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {saving ? "저장 중..." : "저장"}
          </button>
        </div>
      </div>

      <h2 className="text-lg font-bold tracking-tight mb-1">지원 정보</h2>
      <p className="text-gray-500 mb-4">
        실제 지원폼(인적사항/학력/경력 등)에 반복적으로 들어가는 값을 미리 채워두세요.
      </p>
      <ApplicantProfileForm showToast={showToast} />
    </div>
  );
}
