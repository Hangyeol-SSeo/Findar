"use client";

import { useSyncExternalStore, type MouseEvent } from "react";
import ApplicantProfileForm from "@/components/ApplicantProfileForm";
import NarrativeProfileForm from "@/components/NarrativeProfileForm";
import ResumeUploadForm from "@/components/ResumeUploadForm";
import EssaySourceUploadForm from "@/components/EssaySourceUploadForm";
import ExperienceCardList from "@/components/ExperienceCardList";
import CareerDirectionForm from "@/components/CareerDirectionForm";
import WorkspacePageHeader from "@/components/WorkspacePageHeader";
import Toast, { useToast } from "@/components/Toast";

const GROUPS = [
  { label: "이력·지원 정보", items: [
    { id: "resume", label: "이력서·포트폴리오", description: "이력서와 포트폴리오 PDF를 관리합니다. 공고 매칭과 이력 구성 평가에 활용하며, 자기소개서에는 확인한 경험 카드를 통해 반영합니다." },
    { id: "applicant", label: "지원 정보", description: "지원서에 반복해서 입력하는 인적사항, 학력, 경력 등의 정보를 관리합니다." },
    { id: "direction", label: "지원 방향", description: "이력서만으로 알 수 없는 지원 의도와 관심 직무를 적어두세요. 공고 매칭에서 참고합니다." },
  ] },
  { label: "자기소개서 자료", items: [
    { id: "essays", label: "과거 자소서·면접", description: "과거 자기소개서와 면접 대본을 보관합니다. 문항과 답변을 원문 그대로 정리해 작성에 참고합니다." },
    { id: "experience", label: "경험 카드", description: "이력서, 지원 정보와 과거 답변에서 정리한 경험을 검토합니다. 사실과 맞는 카드를 확인하면 자기소개서 작성에 사용할 수 있습니다." },
    { id: "narrative", label: "가치관과 서사", description: "일을 선택하는 기준, 가치관과 경험의 맥락을 정리합니다. 자기소개서와 면접 답변의 동기를 설명하는 데 참고합니다." },
  ] },
] as const;
type ProfileSection = typeof GROUPS[number]["items"][number];
const SECTIONS = GROUPS.flatMap<ProfileSection>((group) => group.items);
type SectionId = ProfileSection["id"];

function currentSection(): SectionId {
  const hash = window.location.hash.slice(1);
  return SECTIONS.find(({ id }) => id === hash)?.id || "resume";
}

function subscribe(listener: () => void) {
  window.addEventListener("hashchange", listener);
  window.addEventListener("popstate", listener);
  return () => {
    window.removeEventListener("hashchange", listener);
    window.removeEventListener("popstate", listener);
  };
}

function navigate(event: MouseEvent<HTMLAnchorElement>, id: SectionId) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (window.location.hash === `#${id}`) return;
  window.history.pushState(null, "", `#${id}`);
  window.dispatchEvent(new Event("hashchange"));
}

export default function ProfilePage() {
  const section = useSyncExternalStore(subscribe, currentSection, () => "resume" as SectionId);
  const { message, showToast } = useToast();
  return (
    <div className="mx-auto w-full min-w-0 max-w-6xl px-6 py-8">
      <Toast message={message} />
      <WorkspacePageHeader title="내 지원 자료" description="여러 공고에서 함께 활용할 이력과 자기소개서 자료를 관리합니다." current="profile" />
      <div className="grid min-w-0 gap-6 md:grid-cols-[200px_minmax(0,1fr)]">
        <nav aria-label="지원 자료 분류" className="self-start rounded-xl border border-gray-100 bg-white p-3 md:sticky md:top-6">
          {GROUPS.map((group) => (
            <div key={group.label} className="mb-4 last:mb-0">
              <p className="px-3 pb-2 pt-1 text-xs font-semibold text-gray-400">{group.label}</p>
              <div className="flex flex-wrap gap-1 md:flex-col">
                {group.items.map(({ id, label }) => (
                  <a key={id} href={`#${id}`} onClick={(event) => navigate(event, id)} aria-current={section === id ? "location" : undefined}
                    className={`rounded-lg px-3 py-2 text-sm transition-colors ${section === id ? "bg-blue-50 font-medium text-blue-700" : "text-gray-600 hover:bg-gray-50"}`}>
                    {label}
                  </a>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="min-w-0">
          {/* Keep forms mounted so switching categories preserves unsaved input and ongoing work. */}
          {SECTIONS.map(({ id, label, description }) => (
            <section key={id} id={id} hidden={section !== id} aria-labelledby={`profile-${id}-title`}>
              <h2 id={`profile-${id}-title`} className="text-lg font-semibold text-gray-800">{label}</h2>
              <p className="mb-5 mt-2 text-sm leading-6 text-gray-500">{description}</p>
              {id === "resume" && <ResumeUploadForm showToast={showToast} />}
              {id === "applicant" && <ApplicantProfileForm showToast={showToast} />}
              {id === "direction" && <CareerDirectionForm showToast={showToast} />}
              {id === "essays" && <>
                <EssaySourceUploadForm showToast={showToast} />
                <p className="mt-4 text-sm text-gray-500">정리한 경험은 <a href="#experience" onClick={(event) => navigate(event, "experience")} className="text-blue-600 underline">경험 카드</a>에서 확인할 수 있습니다.</p>
              </>}
              {id === "experience" && <ExperienceCardList showToast={showToast} />}
              {id === "narrative" && <NarrativeProfileForm showToast={showToast} />}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
