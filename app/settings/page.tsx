"use client";

import AIModelSettingsForm from "@/components/AIModelSettingsForm";
import WorkspacePageHeader from "@/components/WorkspacePageHeader";
import Toast, { useToast } from "@/components/Toast";

export default function SettingsPage() {
  const { message, showToast } = useToast();
  return (
    <div className="mx-auto w-full min-w-0 max-w-4xl px-6 py-8">
      <Toast message={message} />
      <WorkspacePageHeader title="설정" description="AI 모델과 구독 연결 등 앱의 동작을 설정합니다." current="settings" />
      <section aria-labelledby="model-settings-title">
        <h2 id="model-settings-title" className="text-lg font-semibold text-gray-800">AI 모델</h2>
        <p className="mb-5 mt-1 text-sm text-gray-500">기능마다 사용할 모델을 선택하고, 같은 모델을 한 번에 적용할 수 있습니다.</p>
        <AIModelSettingsForm showToast={showToast} />
      </section>
    </div>
  );
}
