"use client";

import { useEffect, useState } from "react";
import { AI_FEATURES, type AIModelSettings, type AIModelSettingsResponse, type CodexConnectionStatus } from "@/lib/ai-model-types";

const BULK_FEATURES = AI_FEATURES.filter(({ id }) => id !== "summarization" && id !== "matching");

export default function AIModelSettingsForm({ showToast }: { showToast: (message: string) => void }) {
  const [data, setData] = useState<AIModelSettingsResponse | null>(null);
  const [settings, setSettings] = useState<AIModelSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [codex, setCodex] = useState<CodexConnectionStatus | null>(null);
  const [checkingCodex, setCheckingCodex] = useState(false);
  const dirty = data && settings && AI_FEATURES.some(({ id }) => data.settings[id] !== settings[id]);

  async function load(signal?: AbortSignal) {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/settings/models", { cache: "no-store", signal });
      if (!response.ok) throw new Error("모델 설정을 불러오지 못했습니다.");
      const result: AIModelSettingsResponse = await response.json();
      setData(result);
      setSettings(result.settings);
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "모델 설정을 불러오지 못했습니다.");
    } finally { if (!signal?.aborted) setLoading(false); }
  }

  async function checkCodex(signal?: AbortSignal) {
    setCheckingCodex(true);
    try {
      const response = await fetch("/api/settings/codex", { cache: "no-store", signal });
      if (!response.ok) throw new Error("Codex 연결 상태를 확인하지 못했습니다.");
      const result: CodexConnectionStatus = await response.json();
      if (!signal?.aborted) setCodex(result);
    } catch {
      if (!signal?.aborted) setCodex({ available: false, authenticated: false, message: "Codex 연결 상태를 확인하지 못했습니다. 다시 확인해주세요." });
    } finally { if (!signal?.aborted) setCheckingCodex(false); }
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    void checkCodex(controller.signal);
    return () => controller.abort();
  }, []);

  async function save() {
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/settings/models", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "모델 설정을 저장하지 못했습니다.");
      setData(result);
      setSettings(result.settings);
      showToast("모델 설정을 저장했습니다");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "모델 설정을 저장하지 못했습니다."); }
    finally { setSaving(false); }
  }

  if (loading) return <p className="text-sm text-gray-400" role="status">모델 설정을 불러오는 중...</p>;
  if (!data || !settings) return <div role="alert" className="text-sm text-red-600">{error}<button onClick={() => void load()} className="ml-3 underline">다시 불러오기</button></div>;

  const bulkOptions = data.options[BULK_FEATURES[0].id].filter((model) =>
    BULK_FEATURES.every(({ id }) => data.options[id].some((option) => option.id === model.id)),
  );
  const sharedModel = settings[BULK_FEATURES[0].id];
  const bulkModel = BULK_FEATURES.every(({ id }) => settings[id] === sharedModel)
    && bulkOptions.some((model) => model.id === sharedModel) ? sharedModel : "";

  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-500">저장하면 다음 생성부터 적용됩니다. 이미 생성된 결과는 각 기능에서 다시 생성할 때 변경됩니다.</p>
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <p className="text-sm font-semibold text-gray-700">Codex · ChatGPT 구독 연결</p>
        <p role="status" className="text-xs text-gray-500 mt-1">
          {checkingCodex ? "Codex 연결 상태를 확인하는 중..." : codex?.message}
        </p>
        <button type="button" onClick={() => void checkCodex()} disabled={checkingCodex}
          className="text-sm text-blue-600 mt-3 hover:underline disabled:opacity-50">연결 상태 다시 확인</button>
      </div>
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <label htmlFor="ai-model-bulk" className="block text-sm font-semibold text-gray-700">모델 일괄 선택</label>
        <p id="ai-model-bulk-description" className="text-xs text-gray-400 mt-1 mb-3">
          공고 요약·공고 매칭을 제외한 {BULK_FEATURES.length}개 기능에 같은 모델을 선택합니다. 아래에서 기능별로 조정한 뒤 저장할 수 있습니다.
        </p>
        <select id="ai-model-bulk" aria-describedby="ai-model-bulk-description"
          value={bulkModel} disabled={saving}
          onChange={(event) => {
            const model = event.target.value;
            if (!model) return;
            setSettings((current) => {
              if (!current) return current;
              const next = { ...current };
              for (const { id } of BULK_FEATURES) next[id] = model;
              return next;
            });
          }}
          className="w-full border border-gray-200 rounded-lg bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:opacity-50">
          <option value="" disabled>기능별로 다른 모델 사용 중</option>
          {bulkOptions.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {AI_FEATURES.map(({ id, label, description }) => (
          <div key={id} className="bg-white rounded-xl border border-gray-100 p-5">
            <label htmlFor={`ai-model-${id}`} className="block text-sm font-semibold text-gray-700">{label}</label>
            <p id={`ai-model-${id}-description`} className="text-xs text-gray-400 mt-1 mb-3">{description}</p>
            <select id={`ai-model-${id}`} aria-describedby={`ai-model-${id}-description`}
              value={settings[id]} disabled={saving}
              onChange={(event) => setSettings({ ...settings, [id]: event.target.value })}
              className="w-full border border-gray-200 rounded-lg bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:opacity-50">
              {data.options[id].map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
            </select>
          </div>
        ))}
      </div>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <div className="flex items-center gap-3">
        <button onClick={() => void save()} disabled={saving || !dirty} className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors">{saving ? "저장 중..." : "모델 설정 저장"}</button>
        {dirty && <span className="text-xs text-gray-400">저장하지 않은 변경이 있습니다</span>}
      </div>
    </div>
  );
}
