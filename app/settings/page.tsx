"use client";

import AIModelSettingsForm from "@/components/AIModelSettingsForm";
import WatchlistSettings from "@/components/WatchlistSettings";
import WorkspacePageHeader from "@/components/WorkspacePageHeader";
import Toast, { useToast } from "@/components/Toast";

export default function SettingsPage() {
  const { message, showToast } = useToast();
  return (
    <div className="mx-auto w-full min-w-0 max-w-4xl px-6 py-8">
      <Toast message={message} />
      <WorkspacePageHeader title="설정" description="AI 모델과 구독 연결, 공고 수집 범위 등 앱의 동작을 설정합니다." current="settings" />
      <section aria-labelledby="model-settings-title">
        <h2 id="model-settings-title" className="text-lg font-semibold text-gray-800">AI 모델</h2>
        <p className="mb-5 mt-1 text-sm text-gray-500">기능마다 사용할 모델을 선택하고, 같은 모델을 한 번에 적용할 수 있습니다.</p>
        <AIModelSettingsForm showToast={showToast} />
      </section>
      <section aria-labelledby="watchlist-title" className="mt-12">
        <h2 id="watchlist-title" className="text-lg font-semibold text-gray-800">수집 범위</h2>
        <p className="mb-5 mt-1 text-sm text-gray-500">
          금융투자협회 게시판 밖에서 공고를 확인하는 회사입니다. 신입 공채·인턴처럼 회사 채용 사이트에만 올라오는 공고를 찾습니다.
        </p>
        <WatchlistSettings showToast={showToast} />
      </section>
    </div>
  );
}
