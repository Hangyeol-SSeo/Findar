import type { ApplicantProfile } from "./applicant-profile";

export const COMPOSITION_FOCUS = {
  equity: "기업분석·주식운용", macro: "매크로·퀀트 리서치", risk: "리스크관리",
  bond: "채권운용·운용지원", digital: "디지털자산 리서치", general: "일반 금융",
} as const;
export type CompositionFocus = keyof typeof COMPOSITION_FOCUS;
export type MaterialLevel = "detail" | "brief" | "exclude";
export type MaterialKind = "education" | "credential" | "language" | "work" | "experience" | "skill";
export interface ApplicationMaterial {
  id: string; title: string; category: string; period: string; summary: string; detail: string;
  tags: CompositionFocus[]; status: "confirmed" | "review" | "in_progress";
  source: string; originId?: string; updatedAt: number;
}
export interface CompositionItem {
  id: string; kind: MaterialKind; title: string; category: string; period: string;
  summary: string; detail: string; source: string; status: ApplicationMaterial["status"];
  tags: CompositionFocus[]; row?: string[]; required: boolean;
  recommended: MaterialLevel; reason: string;
}
export interface MaterialChoice { id: string; level: MaterialLevel; summary?: string; detail?: string }
export interface FreeformComposition {
  version: string; focus: CompositionFocus; roleRevision: string; choices: MaterialChoice[];
}
export interface CompositionCatalog {
  version: string; focus: CompositionFocus; roleRevision: string; items: CompositionItem[];
}
export const str = (v: unknown) => typeof v === "string" ? v.trim() : "";
const join = (...v: unknown[]) => v.map(str).filter(Boolean).join(" / ");
/** 저장된 `2019-03`, `2026-05-21`을 서류에서 흔한 `2019.03`, `2026.05.21` 꼴로 보인다. 그 밖의 글(재직 중 등)은 그대로 둔다. */
export function fmtDate(value: unknown): string {
  const v = str(value);
  const m = v.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
  return m ? [m[1], m[2].padStart(2, "0"), m[3]?.padStart(2, "0")].filter(Boolean).join(".") : v;
}
export const period = (a: string, b: string) => [fmtDate(a), fmtDate(b)].filter(Boolean).join(" ~ ");
// 외국어 수준은 자유 입력칸이라 영어 단어(Intermediate)로 저장된 경우가 많다. 한국어 서류에는 한국어로 쓴다.
const LEVEL_KO: Record<string, string> = { beginner: "초급", basic: "초급", low: "초급", intermediate: "중급", medium: "중급", advanced: "상급", high: "상급", fluent: "상급", native: "원어민" };
export const levelLabel = (v: unknown) => LEVEL_KO[str(v).toLowerCase()] ?? str(v);
export function isFocus(v: unknown): v is CompositionFocus { return typeof v === "string" && Object.hasOwn(COMPOSITION_FOCUS, v); }
export function inferCompositionFocus(role: string): CompositionFocus {
  if (/퀀트|매크로|자산배분|투자전략|quant|macro/i.test(role)) return "macro";
  if (/리스크|위험관리|risk/i.test(role)) return "risk";
  if (/채권|운용지원|펀드회계|오퍼레이션|트레이딩지원|bond|operation/i.test(role)) return "bond";
  if (/디지털자산|가상자산|블록체인|crypto/i.test(role)) return "digital";
  if (/리서치|주식|기업분석|운용|research|equity/i.test(role)) return "equity";
  return "general";
}
export function materialTags(content: string): CompositionFocus[] {
  const tags: CompositionFocus[] = [];
  if (/기업분석|재무제표|밸류에이션|가설|수요|사업성|사업모델/.test(content)) tags.push("equity");
  if (/뉴스|경제지표|시계열|데이터|자료 수집|자동화|Python|SQL/i.test(content)) tags.push("macro");
  if (/정합|오류|예외|결제|리스크|위험 측정|검증/.test(content)) tags.push("risk");
  if (/채권|금리|듀레이션|운용지원|펀드회계|결산|DV01/i.test(content)) tags.push("bond");
  if (/블록체인|디지털자산|가상자산|비트코인|Babylon|암호학/i.test(content)) tags.push("digital");
  return tags;
}

export function profileCompositionItems(profile: ApplicantProfile): CompositionItem[] {
  if (!profile.updatedAt) return [];
  const items: CompositionItem[] = [];
  const ids = new Set<string>();
  const add = (kind: MaterialKind, index: number, title: string, category: string, when: string, summary: string, detail: string, row?: string[]) => {
    const base = `${kind}:${category}:${index}`;
    let id = base, duplicate = 1;
    while (ids.has(id)) id = `${base}:${++duplicate}`;
    ids.add(id);
    items.push({ id, kind, title, category, period: when, summary, detail,
      row, source: "지원 정보", status: "confirmed", tags: materialTags(join(title, summary, detail)),
      required: false, recommended: "exclude", reason: "공고에 맞춰 선택해주세요." });
  };
  profile.education.forEach((e, i) => add("education", i, join(e.schoolName, e.major), e.schoolLevel, period(e.startDate, e.endDate), join(e.degreeType || e.schoolLevel, e.status), "", [
    period(e.startDate, e.endDate), [str(e.schoolName), str(e.major)].filter(Boolean).join("\n"), join(e.degreeType || e.schoolLevel, e.status), str(e.gpa) ? join(e.gpa, e.gpaMax) : "",
  ]));
  profile.certifications.forEach((c, i) => add("credential", i, str(c.name), "자격", str(c.issuedDate), str(c.issuer), "", ["자격", str(c.name), str(c.issuer), fmtDate(c.issuedDate), ""]));
  profile.languageTests.forEach((l, i) => add("language", i, str(l.testName), "어학", fmtDate(l.date), join(l.score, l.scoreMax), "", ["어학", str(l.testName), "", fmtDate(l.date), join(l.score, l.scoreMax)]));
  profile.workExperiences.forEach((w, i) => add("work", i, join(w.companyName, w.department), "근무 경력", period(w.startDate, w.isCurrent ? "재직 중" : w.endDate), str(w.duties).length <= 160 ? str(w.duties) : join(w.position, w.employmentType), str(w.duties), [
    period(w.startDate, w.isCurrent ? "재직 중" : w.endDate), [str(w.companyName), str(w.department)].filter(Boolean).join("\n"), [str(w.position), str(w.employmentType)].filter(Boolean).join("\n"), str(w.duties),
  ]));
  profile.projects.forEach((p, i) => add("experience", i, str(p.name), "프로젝트", period(p.startDate, p.endDate), str(p.role), join(p.role, p.workplace && `근무처 ${p.workplace}`, p.client && `발주처 ${p.client}`, p.contributionPercent && `기여도 ${p.contributionPercent}%`)));
  profile.activities.forEach((a, i) => add("experience", i, str(a.organization), str(a.category) || "활동", period(a.startDate, a.endDate), str(a.role), join(a.role, a.detail)));
  profile.research.forEach((r, i) => add("experience", i, str(r.title), "학술 연구", fmtDate(r.date), join(r.organizer, r.role), join(r.organizer, r.role, r.authorRank && `저자 순위 ${r.authorRank}`)));
  profile.awards.forEach((a, i) => add("experience", i, str(a.name), "수상", fmtDate(a.date), join(a.organizer, a.detail), join(a.organizer, a.detail)));
  if (str(profile.skillsNote)) add("skill", 0, "활용 역량", "활용 역량", "", str(profile.skillsNote), str(profile.skillsNote));
  profile.foreignLanguageSkills.forEach((l, i) => add("skill", i, str(l.language), "언어 활용", "", join(l.reading && `독해 ${levelLabel(l.reading)}`, l.writing && `작문 ${levelLabel(l.writing)}`, l.speaking && `회화 ${levelLabel(l.speaking)}`), ""));
  if (str(profile.portfolioLinks)) add("skill", 0, "참고 자료", "참고 자료", "", str(profile.portfolioLinks), "");
  return items;
}

export function recommendComposition(profile: ApplicantProfile, materials: ApplicationMaterial[], role: string, jobText = "", focus = inferCompositionFocus(role)): CompositionItem[] {
  const items = [...profileCompositionItems(profile), ...materials.map((m): CompositionItem => ({
    id: `material:${m.id}`, kind: "experience", title: m.title, category: m.category, period: m.period,
    summary: m.summary, detail: m.detail, source: m.source, status: m.status, tags: m.tags,
    required: false, recommended: "exclude", reason: "공고에 맞춰 선택해주세요.",
  }))];
  const allCareers = /(전체|모든).{0,12}(경력|재직)|경력.{0,12}(빠짐없이|누락\s*없이)/.test(jobText);
  const highSchool = /고등학교.{0,16}(포함|기재|작성)|학력.{0,12}(전체|모두)/.test(jobText);
  const detailed: CompositionItem[] = [];
  for (const item of items) {
    if (item.status !== "confirmed") {
      item.reason = item.status === "in_progress" ? "진행 중인 자료입니다. 완료·검증한 내용으로 정리한 뒤 추가해주세요." : "이전 글에서 정리된 자료입니다. 실제 수행 내용과 수치를 확인한 뒤 추가해주세요.";
      continue;
    }
    if (item.kind === "education") {
      item.required = highSchool && item.category === "고등학교";
      item.recommended = item.category === "고등학교" && !highSchool ? "exclude" : "brief";
      item.reason = item.required ? "공고에서 고등학교를 포함한 학력을 요구합니다." : item.recommended === "exclude" ? "금융권 기본 구성에서는 대학 학력을 우선합니다." : "학위·전공·학점의 기본 사실을 표시합니다.";
    } else if (item.kind === "credential") {
      item.recommended = /투자|재무|금융|회계|CFA|FRM|CPA|AICPA|신용|파생|증권/i.test(item.title) ? "brief" : "exclude";
      item.reason = item.recommended === "brief" ? "금융 관련 기초 자격을 먼저 표시합니다." : "지원 직무에서 요구하는 자격인지 확인해 선택해주세요.";
    } else if (item.kind === "language") {
      item.recommended = "brief"; item.reason = "저장한 어학 성적을 표시합니다.";
    } else if (item.kind === "work") {
      item.required = allCareers; item.recommended = "brief";
      item.reason = allCareers ? "공고에서 전체 경력을 요구하므로 근무 사실을 남깁니다." : "근무 사실은 짧게 남기고, 상세 경험은 별도로 선택합니다.";
    } else if (item.kind === "skill") {
      item.recommended = item.category === "언어 활용" || /Python|SQL|Excel|엑셀|통계|데이터/i.test(item.summary) ? "brief" : "exclude";
      item.reason = "지원 업무에서 실제 활용할 수 있는 도구·언어와 자료만 선택해주세요.";
    } else if (item.category === "수상") {
      item.reason = "선택한 경험과 관련된 수상일 때 포함해주세요.";
    } else if (item.category === "학술 연구") {
      item.recommended = /반도체|IT|소프트웨어|기술기업/i.test(role) ? "brief" : "exclude";
      item.reason = "관련 산업·기술을 다루는 직무에서 연구 이력을 보조 자료로 사용합니다.";
    } else if (item.tags.includes(focus)) {
      item.recommended = item.detail ? "detail" : "brief";
      item.reason = `${COMPOSITION_FOCUS[focus]}의 기본 구성에 맞는 경험입니다. 실제 수행 범위로 표시합니다.`;
      if (item.recommended === "detail") detailed.push(item);
    } else {
      item.reason = "선택 직무와의 직접적인 관련성이 낮아 기본 구성에서 제외했습니다.";
    }
  }
  // A posting starts with a small, reviewable selection. Manual choices are not capped.
  detailed.slice(3).forEach((item) => { item.recommended = "brief"; item.reason = "상세 경험은 우선 3개로 정리하고 이 경험은 한 줄로 남깁니다."; });
  return items;
}
export function defaultComposition(catalog: CompositionCatalog): FreeformComposition {
  return { version: catalog.version, focus: catalog.focus, roleRevision: catalog.roleRevision,
    choices: catalog.items.map((i) => ({ id: i.id, level: i.recommended })) };
}
export function parseComposition(value: unknown): FreeformComposition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("지원서 구성을 확인해주세요.");
  const x = value as Record<string, unknown>;
  if (Object.keys(x).some((k) => !["version", "focus", "roleRevision", "choices"].includes(k)) || typeof x.version !== "string" || x.version.length > 100 || typeof x.roleRevision !== "string" || x.roleRevision.length > 100 || !isFocus(x.focus) || !Array.isArray(x.choices) || x.choices.length > 500) throw new Error("지원서 구성 형식이 올바르지 않습니다.");
  const choices: MaterialChoice[] = []; const seen = new Set<string>();
  for (const raw of x.choices) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("이력 선택을 확인해주세요.");
    const c = raw as Record<string, unknown>;
    if (Object.keys(c).some((k) => !["id", "level", "summary", "detail"].includes(k)) || typeof c.id !== "string" || !c.id || c.id.length > 180 || seen.has(c.id) || !["detail", "brief", "exclude"].includes(c.level as string)) throw new Error("중복되거나 올바르지 않은 이력 선택입니다.");
    if ((c.summary !== undefined && (typeof c.summary !== "string" || c.summary.length > 500 || /[\r\n]/.test(c.summary))) || (c.detail !== undefined && (typeof c.detail !== "string" || c.detail.length > 20000))) throw new Error("이력 설명의 길이와 줄바꿈을 확인해주세요.");
    seen.add(c.id); choices.push({ id: c.id, level: c.level as MaterialLevel, ...(c.summary !== undefined ? { summary: c.summary as string } : {}), ...(c.detail !== undefined ? { detail: c.detail as string } : {}) });
  }
  return { version: x.version, focus: x.focus, roleRevision: x.roleRevision, choices };
}
export function resolveComposition(catalog: CompositionCatalog, composition?: FreeformComposition | null) {
  const plan = composition ?? defaultComposition(catalog);
  if (plan.version !== catalog.version || plan.roleRevision !== catalog.roleRevision || plan.focus !== catalog.focus) throw new Error("지원 직무나 이력 자료가 변경되었습니다. 구성을 새로 불러와 확인해주세요.");
  const items = new Map(catalog.items.map((i) => [i.id, i]));
  for (const c of plan.choices) {
    const item = items.get(c.id);
    if (!item) throw new Error("현재 자료에 없는 이력이 선택되었습니다. 구성을 새로 불러와주세요.");
    if (c.level !== "exclude" && item.status !== "confirmed") throw new Error("확인하지 않았거나 진행 중인 경험은 먼저 내용 확인 후 자료로 추가해주세요.");
    if (c.level === "detail" && !["work", "experience"].includes(item.kind)) throw new Error("학력·자격·어학·활용 역량은 기본 항목으로 기재해주세요.");
    if ((c.summary !== undefined || c.detail !== undefined) && !["work", "experience", "skill"].includes(item.kind)) throw new Error("학력·자격·어학 정보는 내 지원 자료에서 수정해주세요.");
  }
  const choices = new Map(plan.choices.map((c) => [c.id, c]));
  return catalog.items.map((item) => {
    const choice = choices.get(item.id) ?? { id: item.id, level: "exclude" as const };
    if (item.required && choice.level === "exclude") throw new Error(`${item.title}: 공고에서 요구한 이력은 제외할 수 없습니다.`);
    return { ...item, level: choice.level, summary: choice.summary ?? item.summary, detail: choice.detail ?? item.detail };
  });
}
