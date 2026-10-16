import { normalizeCompanyName } from "./company-normalize";
import { isSubmittedApplicationStatus } from "./application-status";

// "최근에 지원한 회사" 표시. 같은 회사에 짧은 기간 여러 공고로 지원하면 찔러보기로 비쳐 불리하므로,
// 1개월/3개월/6개월 이내에 지원서를 낸 회사의 다른 공고에 기간별 색으로 표시한다.
// 회사 식별은 normalizeCompanyName()만 쓴다. AI 호출 없음 — 클라이언트에서 지원 현황 목록으로 계산한다.

export type RecentApplicationTier = "1개월" | "3개월" | "6개월";

const TIER_MONTHS: [RecentApplicationTier, number][] = [
  ["1개월", 1],
  ["3개월", 3],
  ["6개월", 6],
];

export interface CompanyApplication {
  seq: string;
  company: string;
  title: string;
  status: string;
  appliedAt: number;
}

export interface RecentCompanyApplications {
  tier: RecentApplicationTier;
  // 최근 지원 순. 표시 중인 공고 자신은 빠져 있다.
  applications: CompanyApplication[];
}

function monthsBefore(now: number, months: number): number {
  const date = new Date(now);
  date.setMonth(date.getMonth() - months);
  return date.getTime();
}

// 지원 시각이 몇 개월 이내인지. 6개월보다 오래됐거나 미래 시각이면 null.
export function recentApplicationTier(appliedAt: number, now: number): RecentApplicationTier | null {
  if (appliedAt > now) return null;
  for (const [tier, months] of TIER_MONTHS) {
    if (appliedAt >= monthsBefore(now, months)) return tier;
  }
  return null;
}

// 지원 현황 목록에서 6개월 이내에 지원서를 낸 공고만 회사별로 모은다. 상태를 지원 전으로 되돌린 공고는 뺀다.
export function indexRecentCompanyApplications(
  jobs: { seq: string; company: string; title: string; applicationStatus?: string; appliedAt?: number | null }[],
  now: number
): Map<string, CompanyApplication[]> {
  const index = new Map<string, CompanyApplication[]>();
  for (const job of jobs) {
    if (!job.appliedAt || !isSubmittedApplicationStatus(job.applicationStatus)) continue;
    if (!recentApplicationTier(job.appliedAt, now)) continue;
    const key = normalizeCompanyName(job.company);
    if (!key) continue;
    const list = index.get(key) ?? [];
    list.push({ seq: job.seq, company: job.company, title: job.title, status: job.applicationStatus, appliedAt: job.appliedAt });
    index.set(key, list);
  }
  for (const list of index.values()) list.sort((a, b) => b.appliedAt - a.appliedAt);
  return index;
}

// 이 공고의 회사에 최근 지원한 다른 공고. 가장 최근 지원 기준으로 기간을 정한다.
export function recentCompanyApplications(
  index: Map<string, CompanyApplication[]>,
  job: { seq: string; company: string },
  now: number
): RecentCompanyApplications | null {
  const applications = (index.get(normalizeCompanyName(job.company)) ?? []).filter((a) => a.seq !== job.seq);
  if (applications.length === 0) return null;
  const tier = recentApplicationTier(applications[0].appliedAt, now);
  return tier ? { tier, applications } : null;
}

// 가까울수록 진한 경고색. stripe는 카드 왼쪽 띠와 점, text는 글자, notice는 상세 안내 상자.
export function recentApplicationTierColor(tier: RecentApplicationTier): { stripe: string; text: string; notice: string } {
  switch (tier) {
    case "1개월":
      return { stripe: "bg-rose-500", text: "text-rose-600", notice: "bg-rose-50 border-rose-200 text-rose-800" };
    case "3개월":
      return { stripe: "bg-orange-400", text: "text-orange-600", notice: "bg-orange-50 border-orange-200 text-orange-800" };
    case "6개월":
      return { stripe: "bg-yellow-400", text: "text-yellow-700", notice: "bg-yellow-50 border-yellow-200 text-yellow-900" };
  }
}

export function daysAgoLabel(appliedAt: number, now: number): string {
  const days = Math.floor((now - appliedAt) / 86_400_000);
  return days <= 0 ? "오늘" : `${days}일 전`;
}
