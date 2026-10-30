import type { ApplicantProfile } from "./applicant-profile";
import type { ApplicationDraft } from "./application-draft";

export interface FreeformOptions {
  mode: "filled" | "blank";
  includeDetails: boolean;
  includeEssays: boolean;
  includeMilitary: boolean;
  includePersonalDetails: boolean;
}
export const DEFAULT_FREEFORM_OPTIONS: FreeformOptions = {
  mode: "filled", includeDetails: true, includeEssays: true,
  includeMilitary: false, includePersonalDetails: false,
};
export function parseFreeformOptions(value: unknown): FreeformOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("지원서 생성 옵션이 올바르지 않습니다.");
  const input = value as Record<string, unknown>;
  const options = { ...DEFAULT_FREEFORM_OPTIONS };
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(options, key)) throw new Error("알 수 없는 지원서 생성 옵션입니다.");
    if (key === "mode") {
      if (input.mode !== "filled" && input.mode !== "blank") throw new Error("지원서 생성 방식을 확인해주세요.");
      options.mode = input.mode;
    } else {
      if (typeof input[key] !== "boolean") throw new Error("지원서 포함 항목을 확인해주세요.");
      (options as unknown as Record<string, unknown>)[key] = input[key];
    }
  }
  return options;
}

export interface FreeformEntry { title: string; meta?: string; lines: { label: string; text: string }[] }
export type FreeformBlock =
  | { type: "table"; title: string; headers: string[]; rows: string[][]; widths: number[] }
  | { type: "entries"; title: string; entries: FreeformEntry[] };
export interface FreeformPage { title: string; blocks: FreeformBlock[] }
export interface FreeformDocument {
  mode: FreeformOptions["mode"];
  company: string; role: string; name: string; contacts: string[];
  pages: FreeformPage[]; warnings: { label: string; reason: string }[];
  filled: number; total: number;
}
type RoleSelection = { role: string; revision: string };
const text = (s: unknown): string => typeof s === "string" ? s.trim() : "";
const join = (...values: unknown[]) => values.map(text).filter(Boolean).join(" / ");
const period = (a: string, b: string) => [text(a), text(b)].filter(Boolean).join(" - ");

/** Only user-entered structured facts and this posting's saved essays are exported.
 * No model, resume inference, cross-company essay bank, or tailoring rewrite is used. */
export function buildFreeformDocument(
  company: string, selection: RoleSelection, profile: ApplicantProfile,
  draft: ApplicationDraft | null, options: FreeformOptions,
): FreeformDocument {
  const blank = options.mode === "blank";
  // Unsaved default values (nationality/veteran status etc.) are not applicant facts.
  const p = !blank && profile.updatedAt > 0 ? profile : null;
  const warnings: FreeformDocument["warnings"] = [];
  const warn = (label: string, reason: string) => warnings.push({ label, reason });
  if (!blank && !p) warn("지원 정보", "내 지원 자료에서 지원 정보를 먼저 저장해주세요. 비어 있는 양식으로 생성됩니다.");
  if (!blank && !p?.name.trim()) warn("성명", "저장된 성명이 없습니다.");
  if (!blank && !p?.email.trim() && !p?.phone.trim()) warn("연락처", "저장된 이메일과 전화번호가 없습니다.");
  if (!selection.role.trim()) warn("지원 직무", "공고 상단에서 지원 직무를 선택해주세요.");
  const field = (value: unknown, placeholder: string) => blank ? `[${placeholder}]` : text(value);
  const table = (title: string, headers: string[], rows: string[][], widths: number[], placeholders: string[]) => ({
    type: "table" as const, title, headers, widths,
    rows: rows.length ? rows : [placeholders.map((v) => field("", v))],
  });
  const blocks: FreeformBlock[] = [
    table("학력", ["재학 기간", "학교 및 전공", "학위 및 상태", "학점"], (p?.education ?? []).map((e) => [
      period(e.startDate, e.endDate), [text(e.schoolName), text(e.major)].filter(Boolean).join("\n"), join(e.degreeType || e.schoolLevel, e.status), text(e.gpa) ? join(e.gpa, e.gpaMax) : "",
    ]), [20,35,25,20], ["재학 기간", "학교명 / 전공", "학위 / 졸업 상태", "취득 / 만점"]),
    table("경력", ["재직 기간", "회사 및 소속", "직위 및 고용 형태"], (p?.workExperiences ?? []).map((w) => [
      period(w.startDate, w.isCurrent ? "재직 중" : w.endDate), [text(w.companyName), text(w.department)].filter(Boolean).join("\n"), [text(w.position), text(w.employmentType)].filter(Boolean).join("\n"),
    ]), [22,50,28], ["재직 기간", "회사 / 부서", "직위 / 고용 형태"]),
    table("자격 및 어학", ["구분", "명칭", "발급 또는 시행 기관", "취득일", "등급 및 점수"], [
      ...(blank ? [["자격", "[자격명]", "[발급 기관]", "[취득일]", "[등급]"], ["어학", "[시험명]", "[시행 기관]", "[응시일]", "[점수]"]] : []),
      ...(p?.certifications ?? []).map((c) => ["자격", text(c.name), text(c.issuer), text(c.issuedDate), ""]),
      ...(p?.languageTests ?? []).map((l) => ["어학", text(l.testName), "", text(l.date), join(l.score, l.scoreMax)]),
    ], [10,29,26,17,18], ["자격 또는 어학", "명칭", "기관명", "취득일", "등급 또는 점수"]),
  ];
  const experienceRows = [
    ...(p?.projects ?? []).map((x) => ["프로젝트", period(x.startDate, x.endDate), text(x.name), join(x.role, x.workplace && `근무처 ${x.workplace}`, x.client && `발주처 ${x.client}`, x.contributionPercent && `기여도 ${x.contributionPercent}%`)]),
    ...(p?.activities ?? []).map((a) => [text(a.category) || "활동", period(a.startDate, a.endDate), text(a.organization), join(a.role, a.detail)]),
    ...(p?.research ?? []).map((r) => [text(r.category) || "연구", text(r.date), text(r.title), join(r.organizer, r.role, r.authorRank && `저자 순위 ${r.authorRank}`)]),
    ...(p?.awards ?? []).map((a) => ["수상", text(a.date), text(a.name), join(a.organizer, a.detail)]),
  ];
  // Resume identities stay compact; unabridged descriptions live in detail pages.
  if (blank || experienceRows.length) blocks.push({ type: "entries", title: "관련 경험 및 활용 역량", entries: [{ title: "", lines: blank
    ? [{ label: "관련 경험", text: "[프로젝트·교육·활동명 / 기간 / 본인 역할]" }]
    : experienceRows.map(([category, when, name]) => ({ label: category, text: join(name, when) })) }] });
  if (blank || p?.skillsNote.trim() || p?.foreignLanguageSkills.length || p?.portfolioLinks.trim()) blocks.push({
    type: "entries", title: experienceRows.length || blank ? "" : "관련 경험 및 활용 역량", entries: [{ title: "", lines: [
      ...(blank || p?.skillsNote.trim() ? [{ label: "활용 역량", text: field(p?.skillsNote, "실제 활용 가능한 지식 및 도구") }] : []),
      ...(p?.foreignLanguageSkills ?? []).map((l) => ({ label: text(l.language), text: join(l.reading && `읽기 ${l.reading}`, l.writing && `쓰기 ${l.writing}`, l.speaking && `말하기 ${l.speaking}`) })),
      ...(blank || p?.portfolioLinks.trim() ? [{ label: "참고 자료", text: field(p?.portfolioLinks, "포트폴리오 등 자료 링크") }] : []),
    ] }],
  });
  if (options.includeMilitary) blocks.push({ type: "entries", title: "병역", entries: [{ title: "", lines: [
    { label: "복무 사항", text: blank ? "[병역 구분 / 군별 / 병과 / 계급 / 제대 구분]" : join(p?.militaryStatus, p?.militaryBranch, p?.militarySpecialty, p?.militaryRank, p?.militaryDischargeType) },
    { label: "복무 기간", text: blank ? "[복무 기간]" : period(p?.militaryServiceStart ?? "", p?.militaryServiceEnd ?? "") },
  ] }] });
  if (options.includePersonalDetails) blocks.push({ type: "entries", title: "추가 인적사항", entries: [{ title: "", lines: [
    { label: "생년월일", text: field(p?.birthDate, "생년월일") },
    { label: "성별 및 국적", text: blank ? "[성별 / 국적]" : join(p?.gender, p?.nationality) },
    { label: "주소", text: blank ? "[주소]" : [p?.postalCode, p?.address, p?.addressDetail].map(text).filter(Boolean).join(" ") },
  ] }] });
  const pages: FreeformPage[] = [{ title: "입사지원서", blocks }];
  if (options.includeDetails) {
    const details: FreeformBlock[] = [];
    if (blank || p?.workExperiences.length) details.push({ type: "entries", title: "업무 경험", entries: blank ? [{ title: "[회사명 / 부서 및 직위]", meta: "[재직 기간 / 고용 형태]", lines: [
      { label: "담당 업무", text: "[직접 맡은 업무 범위]" }, { label: "본인 기여", text: "[실제로 판단하고 수행한 내용]" }, { label: "결과 및 근거", text: "[확인 가능한 결과와 근거]" },
    ] }] : (p?.workExperiences ?? []).map((w) => ({ title: join(w.companyName, w.department, w.position), meta: join(period(w.startDate, w.isCurrent ? "재직 중" : w.endDate), w.employmentType), lines: [{ label: "담당 업무", text: text(w.duties) }] })) });
    if (blank || experienceRows.length) details.push({ type: "entries", title: "프로젝트 및 학습 경험", entries: blank ? [{ title: "[프로젝트 또는 활동명]", meta: "[기간 / 실제 경험 구분]", lines: [
      { label: "본인 역할", text: "[본인이 수행한 범위]" }, { label: "수행 내용", text: "[실제로 수행한 내용]" }, { label: "결과 및 한계", text: "[확인한 결과와 한계]" },
    ] }] : experienceRows.map(([category, when, name, detail]) => ({ title: name, meta: join(category, when), lines: [{ label: "역할 및 내용", text: detail }] })) });
    if (details.length) pages.push({ title: "경력 및 경험 상세", blocks: details });
    else if (!blank) warn("경력 및 경험 상세", "저장된 업무·프로젝트·활동이 없어 상세 페이지는 포함하지 않았습니다.");
  }
  if (options.includeEssays) {
    const answers: FreeformEntry[] = [];
    if (!blank) for (const a of draft?.essayAnswers ?? []) {
      if (a.source !== "user_question") { if (a.answer.trim()) warn(a.question, "이전 형식의 답변입니다. 문항과 함께 저장한 뒤 다시 생성해주세요."); continue; }
      if (!a.answer.trim() || a.status === "needs_info") { warn(a.question, "답변이 비어 있거나 보완이 필요한 상태여서 포함하지 않았습니다."); continue; }
      if ((a.roleRevision && a.roleRevision !== selection.revision) || (a.targetRole && a.targetRole !== selection.role)) {
        warn(a.question, "이전에 선택한 지원 직무의 답변입니다. 현재 직무에 맞게 확인한 뒤 문항과 답변을 다시 등록해주세요."); continue;
      }
      // Keep all paragraphs and the user's question order verbatim.
      answers.push({ title: a.question, lines: [{ label: "", text: a.answer }] });
    }
    if (!answers.length) {
      if (!blank) warn("자기소개서", "이 공고에서 사용할 수 있는 저장 답변이 없어 기본 소제목만 넣었습니다. 문항별 자기소개서에서 답변을 저장한 뒤 다시 생성해주세요.");
      for (const title of ["지원동기", "직무 관련 역량", "일하는 방식"]) answers.push({ title, lines: [{ label: "", text: blank ? "[내용을 입력해주세요.]" : "" }] });
    }
    pages.push({ title: "자기소개서", blocks: [{ type: "entries", title: "", entries: answers }] });
  }
  const values = [text(company), text(selection.role), p?.name ?? "", p?.email ?? "", p?.phone ?? "", ...pages.flatMap((page) => page.blocks.flatMap((b) => b.type === "table" ? b.rows.flat() : b.entries.flatMap((e) => e.lines.map((l) => l.text))))];
  return {
    mode: options.mode, company: text(company), role: text(selection.role), name: field(p?.name, "성명"),
    contacts: blank ? ["[연락처]", "[이메일]"] : [p?.phone, p?.email].map(text).filter(Boolean),
    pages, warnings, filled: blank ? 0 : values.filter(Boolean).length, total: values.length,
  };
}

export function freeformFilename(document: FreeformDocument, mode: FreeformOptions["mode"]): string {
  const safe = (s: string) => Array.from(s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").trim()).slice(0, 60).join("");
  return [document.company, document.role, mode === "filled" ? document.name : "", mode === "blank" ? "입사지원서-양식" : "입사지원서"].map(safe).filter(Boolean).join("_") + ".docx";
}
