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
