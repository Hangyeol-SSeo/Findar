import type { ApplicantProfile } from "./applicant-profile";

// 공고별 "이력 취사선택" 평가의 타입과 순수 로직. DB/AI 호출이 없어 클라이언트 컴포넌트와
// scripts/tests에서 그대로 불러 쓸 수 있다.

export const TAILORING_DECISIONS = ["강조", "유지", "축소", "제외", "숨김 검토"] as const;
export type TailoringDecision = (typeof TAILORING_DECISIONS)[number] | "판단 보류";
export const DECISION_ORDER: TailoringDecision[] = [...TAILORING_DECISIONS, "판단 보류"];

export const DECISION_DESCRIPTIONS: Record<TailoringDecision, string> = {
  강조: "공고의 핵심 요구를 직접 증명 — 앞쪽에 구체적으로",
  유지: "관련은 있지만 주인공은 아님 — 지금 수준으로",
  축소: "한 줄로 줄이거나 직무와 닿는 부분만",
  제외: "직무 무관·오래됨·중복 — 빼는 편이 낫다",
  "숨김 검토": "사실이지만 부정적 신호로 읽힐 수 있음 — 기재 여부 신중히",
  "판단 보류": "AI 평가에서 빠진 항목 — 직접 판단 필요",
};

export interface ResumeItem {
  id: string;
  source: "resume" | "applicant";
  section: string;
  title: string;
  period: string;
  detail: string;
}

export interface TailoringEvaluation {
  itemIds: string[];
  label: string;
  decision: TailoringDecision;
  reasons: string[];
  rationale: string;
  rewrite: string;
  omissionRisk: string;
}

export interface ResumeTailoringResult {
  targetRole?: string;
  seq: string;
  focus: string;
  summary: string;
  evaluations: TailoringEvaluation[];
  sectionOrder: string[];
  watchouts: string[];
  items: ResumeItem[];
  model: string;
  generatedAt: number;
}

const str = (v: unknown, max = 2000): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const strList = (v: unknown, maxItems = 20): string[] =>
  Array.isArray(v) ? v.map((x) => str(x, 300)).filter(Boolean).slice(0, maxItems) : [];

export function extractJsonObject(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const value = JSON.parse(body.trim());
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("평가 결과 형식이 올바르지 않습니다.");
  return value as Record<string, unknown>;
}

// 모델 출력을 신뢰하지 않고 정리한다: 모르는 id는 버리고, 같은 id가 두 번 평가되면 첫 번째만
// 남기고, 모델이 빠뜨린 항목은 버리지 않고 "판단 보류"로 채워 넣는다(항목이 조용히 사라지면
// 사용자는 그 이력이 평가됐다고 착각한다 — 저장소 전반의 "degraded, never dropped" 원칙).
export function normalizeTailoring(
  raw: Record<string, unknown>,
  items: ResumeItem[]
): Pick<ResumeTailoringResult, "focus" | "summary" | "evaluations" | "sectionOrder" | "watchouts"> {
  const known = new Map(items.map((i) => [i.id, i]));
  const used = new Set<string>();
  const evaluations: TailoringEvaluation[] = [];
  for (const entry of Array.isArray(raw.evaluations) ? raw.evaluations : []) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const ids = strList(e.itemIds, 50).filter((id) => known.has(id) && !used.has(id));
    if (ids.length === 0) continue;
    ids.forEach((id) => used.add(id));
    const decision = (TAILORING_DECISIONS as readonly string[]).includes(e.decision as string)
      ? (e.decision as TailoringDecision)
      : "판단 보류";
    const hidesItem = decision === "제외" || decision === "숨김 검토";
    evaluations.push({
      itemIds: ids,
      label: str(e.label, 120) || known.get(ids[0])!.title,
      decision,
      reasons: strList(e.reasons, 6),
      rationale: str(e.rationale),
      rewrite: hidesItem ? "" : str(e.rewrite),
      omissionRisk: str(e.omissionRisk),
    });
  }
  for (const item of items) {
    if (used.has(item.id)) continue;
    evaluations.push({
      itemIds: [item.id],
      label: item.title,
      decision: "판단 보류",
      reasons: [],
      rationale: "AI 평가 결과에서 빠진 항목입니다. 다시 평가하거나 직접 판단해주세요.",
      rewrite: "",
      omissionRisk: "",
    });
  }
  evaluations.sort((a, b) => DECISION_ORDER.indexOf(a.decision) - DECISION_ORDER.indexOf(b.decision));
  return {
    focus: str(raw.focus, 500),
    summary: str(raw.summary),
    evaluations,
    sectionOrder: strList(raw.sectionOrder, 15),
    watchouts: strList(raw.watchouts, 10),
  };
}

const period = (a: string, b: string) => [a, b].filter(Boolean).join(" ~ ");
const join = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" · ");

// /settings의 "지원 정보"(사용자가 직접 입력한 구조화 이력)를 평가 대상 항목으로 펼친다.
// 인적사항 중 성별/생년월일/연락처처럼 양식이 필수로 묻는 값은 취사선택 대상이 아니므로 뺀다.
export function buildApplicantItems(p: ApplicantProfile): ResumeItem[] {
  const items: ResumeItem[] = [];
  const add = (id: string, section: string, title: string, when: string, detail: string) => {
    if (title.trim()) items.push({ id, source: "applicant", section, title: title.trim(), period: when, detail });
  };
  p.education.forEach((e, i) =>
    add(`a.edu.${i}`, "학력", join(e.schoolName, e.major), period(e.startDate, e.endDate),
      join(e.schoolLevel, e.status, e.degreeType, e.majorTrack, e.gpa && `학점 ${e.gpa}${e.gpaMax ? `/${e.gpaMax}` : ""}`)));
  p.workExperiences.forEach((w, i) =>
    add(`a.work.${i}`, "경력", join(w.companyName, w.department, w.position), period(w.startDate, w.isCurrent ? "재직중" : w.endDate),
      join(w.employmentType, w.duties, w.resignReason && `퇴사 사유: ${w.resignReason}`)));
  p.projects.forEach((x, i) =>
    add(`a.project.${i}`, "프로젝트", x.name, period(x.startDate, x.endDate),
      join(x.role, x.client && `발주처 ${x.client}`, x.workplace && `근무처 ${x.workplace}`, x.contributionPercent && `기여도 ${x.contributionPercent}%`)));
  p.activities.forEach((a, i) =>
    add(`a.activity.${i}`, "대외활동", join(a.category, a.organization), period(a.startDate, a.endDate), join(a.role, a.detail)));
  p.research.forEach((r, i) =>
    add(`a.research.${i}`, "연구", r.title, r.date, join(r.category, r.organizer, r.role, r.authorRank && `저자 순위 ${r.authorRank}`)));
  p.awards.forEach((a, i) => add(`a.award.${i}`, "수상", a.name, a.date, join(a.organizer, a.detail)));
  p.certifications.forEach((c, i) => add(`a.cert.${i}`, "자격증", c.name, c.issuedDate, c.issuer));
  p.languageTests.forEach((l, i) =>
    add(`a.lang.${i}`, "어학", l.testName, l.date, l.score && `점수 ${l.score}${l.scoreMax ? `/${l.scoreMax}` : ""}`));
  p.foreignLanguageSkills.forEach((l, i) =>
    add(`a.langskill.${i}`, "외국어 능력", l.language, "", join(l.reading && `읽기 ${l.reading}`, l.writing && `쓰기 ${l.writing}`, l.speaking && `말하기 ${l.speaking}`)));
  if (p.skillsNote.trim()) add("a.skills", "기술/활용 능력", "활용 가능 기술", "", p.skillsNote.trim());
  if (p.specialties.trim()) add("a.specialties", "인적사항(선택)", "특기", "", p.specialties.trim());
  if (p.hobbies.trim()) add("a.hobbies", "인적사항(선택)", "취미", "", p.hobbies.trim());
  if (p.religion.trim()) add("a.religion", "인적사항(선택)", "종교", "", p.religion.trim());
  return items;
}
