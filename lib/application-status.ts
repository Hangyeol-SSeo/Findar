export type ApplicationStatus =
  | "미지원"
  | "검토중"
  | "작성중"
  | "제출완료"
  | "서류합격"
  | "면접"
  | "불합격"
  | "최종합격";

export const APPLICATION_STATUSES: ApplicationStatus[] = [
  "미지원",
  "검토중",
  "작성중",
  "제출완료",
  "서류합격",
  "면접",
  "불합격",
  "최종합격",
];

// 검토중부터 지원 결과까지의 단계들. 이 상태의 공고는 마감이 지나도 "지원 현황" 보기에서
// 계속 추적할 수 있어야 한다(getActiveJobs()의 마감 필터와 별개로 getTrackedApplicationJobs()가 조회).
export const TRACKED_APPLICATION_STATUSES: ApplicationStatus[] = [
  "검토중",
  "작성중",
  "제출완료",
  "서류합격",
  "면접",
  "불합격",
  "최종합격",
];

// 실제로 지원서를 낸 뒤의 단계(검토중/작성중은 아직 지원 전). Google 시트 동기화와
// "최근 지원한 회사" 표시가 같은 기준을 쓴다.
export const SUBMITTED_APPLICATION_STATUSES: ApplicationStatus[] = [
  "제출완료",
  "서류합격",
  "면접",
  "불합격",
  "최종합격",
];

export function isSubmittedApplicationStatus(status: string | undefined): status is ApplicationStatus {
  return !!status && (SUBMITTED_APPLICATION_STATUSES as string[]).includes(status);
}

// 지원한 시각. submittedAt은 '제출완료'를 거쳐야만 기록되므로, 곧바로 서류합격 등으로 바꾼 경우엔
// 이력에서 처음 지원 이후 단계가 된 시각을, 그것도 없으면 마지막 변경 시각을 쓴다. 아직 지원 전이면 null.
export function applicationAppliedAt(application: {
  status: string;
  submittedAt: number | null;
  history: { status: string; at: number }[];
  updatedAt: number;
}): number | null {
  if (!isSubmittedApplicationStatus(application.status)) return null;
  return (
    application.submittedAt ??
    application.history.find((h) => isSubmittedApplicationStatus(h.status))?.at ??
    application.updatedAt
  );
}

export function isTrackedApplicationStatus(status: ApplicationStatus | undefined): boolean {
  return !!status && TRACKED_APPLICATION_STATUSES.includes(status);
}

export function isApplicationStatus(value: unknown): value is ApplicationStatus {
  return (
    typeof value === "string" &&
    (APPLICATION_STATUSES as string[]).includes(value)
  );
}

export function getApplicationStatusColor(status: ApplicationStatus): string {
  switch (status) {
    case "검토중":
    case "작성중":
      return "bg-violet-100 text-violet-700";
    case "제출완료":
    case "서류합격":
      return "bg-blue-100 text-blue-700";
    case "면접":
      return "bg-amber-100 text-amber-700";
    case "최종합격":
      return "bg-emerald-100 text-emerald-700";
    case "불합격":
      return "bg-red-100 text-red-600";
    default:
      return "bg-gray-100 text-gray-500";
  }
}
