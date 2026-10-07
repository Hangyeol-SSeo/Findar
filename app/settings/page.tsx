"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import ApplicantProfileForm from "@/components/ApplicantProfileForm";
import NarrativeProfileForm from "@/components/NarrativeProfileForm";
import ResumeUploadForm from "@/components/ResumeUploadForm";
import EssaySourceUploadForm from "@/components/EssaySourceUploadForm";
import ExperienceCardList from "@/components/ExperienceCardList";
import AIModelSettingsForm from "@/components/AIModelSettingsForm";
import Toast, { useToast } from "@/components/Toast";

export default function SettingsPage() {
  const [careerGoals, setCareerGoals] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"resume" | "essays" | "matching" | "applicant" | "narrative" | "models">("resume");
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
    <div className="w-full min-w-0 max-w-4xl mx-auto px-6 py-8">
      <Toast message={toastMessage} />
      <Link
        href="/"
        className="text-sm text-gray-400 hover:text-gray-600 transition-colors"
      >
        ← 목록으로
      </Link>

      <h1 className="text-2xl font-bold tracking-tight mt-3 mb-6">설정</h1>

      <div className="flex gap-1 overflow-x-auto border-b border-gray-100 mb-6">
        {(["resume", "essays", "matching", "applicant", "narrative", "models"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`shrink-0 text-sm px-3 py-2 -mb-px border-b-2 transition-colors ${
              tab === t
                ? "border-blue-600 text-blue-600 font-medium"
                : "border-transparent text-gray-400 hover:text-gray-600"
            }`}
          >
            {t === "resume" ? "이력서" : t === "essays" ? "과거 자소서·면접" : t === "matching" ? "매칭 설정" : t === "applicant" ? "지원 정보" : t === "narrative" ? "가치관과 서사" : "AI 모델"}
          </button>
        ))}
      </div>

      {/* 탭마다 조건부로 마운트하면 전환할 때마다 폼이 다시 불러오며 "불러오는 중..."으로
          번쩍이고 저장 안 한 입력도 사라진다. 모든 탭을 마운트해두고 hidden으로만 전환한다. */}
      <div hidden={tab !== "resume"}>
        <p className="text-gray-500 mb-4">
          이력서·포트폴리오 PDF를 올리면 AI 매칭, 이력 구성 평가, 자기소개서 작성에 사용됩니다. 자기소개서 작성에는 이력서의 경험 항목이
          ‘과거 자소서·면접’ 탭의 경험 카드로 정리되어, 확인한 카드만 쓰입니다.
        </p>
        <ResumeUploadForm showToast={showToast} />
      </div>
      <div hidden={tab !== "essays"}>
        <p className="text-gray-500 mb-4">
          예전에 쓴 자기소개서와 면접 대본을 올리면 문항·답변을 원문 그대로 정리해 두고, 자기소개서를 쓸 때 실제 경험과 표현의 참고 자료로 씁니다.
        </p>
        <EssaySourceUploadForm showToast={showToast} />
        <ExperienceCardList showToast={showToast} />
      </div>
      <div hidden={tab !== "matching"}>
        <p className="text-gray-500 mb-6">
          이력서만으로는 알 수 없는 지원 의도를 직접 적어두면 AI 매칭이 참고합니다.
        </p>
        <div className="bg-white rounded-xl border border-gray-100 p-5">
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
      </div>
      <div hidden={tab !== "applicant"}>
        <p className="text-gray-500 mb-4">
          실제 지원폼(인적사항/학력/경력 등)에 반복적으로 들어가는 값을 미리 채워두세요.
        </p>
        <ApplicantProfileForm showToast={showToast} />
      </div>
      <div hidden={tab !== "narrative"}>
        <p className="text-gray-500 mb-4">
          자소서·면접 답변이 이력과 거리가 있는 직무에서도 스킬을 억지로 갖다붙이지 않고, 진짜
          동기로 자연스럽게 연결되도록 쓰이는 참고 자료입니다.
        </p>
        <NarrativeProfileForm showToast={showToast} />
      </div>
      <div hidden={tab !== "models"}>
        <AIModelSettingsForm showToast={showToast} />
      </div>
    </div>
  );
}
