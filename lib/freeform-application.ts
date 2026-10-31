import type { ApplicantProfile } from "./applicant-profile";
import type { ApplicationDraft } from "./application-draft";
import { inferCompositionFocus, parseComposition, recommendComposition, resolveComposition, type CompositionCatalog, type FreeformComposition } from "./freeform-composition";

export interface FreeformOptions {
  mode: "filled" | "blank";
  applicationType: "" | "신입" | "경력" | "인턴";
  includeDetails: boolean; includeEssays: boolean; includeMilitary: boolean; includePersonalDetails: boolean;
  composition: FreeformComposition | null;
}
export const DEFAULT_FREEFORM_OPTIONS: FreeformOptions = {
  mode: "filled", applicationType: "", includeDetails: true, includeEssays: true,
  includeMilitary: false, includePersonalDetails: false, composition: null,
};
export function parseFreeformOptions(value: unknown): FreeformOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("지원서 생성 옵션이 올바르지 않습니다.");
  const input = value as Record<string, unknown>, options = { ...DEFAULT_FREEFORM_OPTIONS };
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(options, key)) throw new Error("알 수 없는 지원서 생성 옵션입니다.");
    if (key === "mode") {
      if (input.mode !== "filled" && input.mode !== "blank") throw new Error("지원서 생성 방식을 확인해주세요.");
      options.mode = input.mode;
    } else if (key === "applicationType") {
      if (!["", "신입", "경력", "인턴"].includes(input.applicationType as string)) throw new Error("지원 구분을 확인해주세요.");
      options.applicationType = input.applicationType as FreeformOptions["applicationType"];
    } else if (key === "composition") {
      options.composition = input.composition === null ? null : parseComposition(input.composition);
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
  mode: FreeformOptions["mode"]; company: string; role: string; name: string; contacts: string[];
  applicationType: string; personalRows: string[][];
  pages: FreeformPage[]; warnings: { label: string; reason: string }[]; filled: number; total: number;
}
const text = (s: unknown): string => typeof s === "string" ? s.trim() : "";
const join = (...values: unknown[]) => values.map(text).filter(Boolean).join(" / ");
const table = (title: string, headers: string[], rows: string[][]): FreeformBlock => ({ type: "table", title, headers, rows, widths: [] });
const education = (rows: string[][]) => table("학력", ["재학 기간", "학교 및 전공", "학위 및 상태", "학점"], rows);
const credentials = (rows: string[][]) => table("자격 및 어학", ["구분", "명칭", "발급 또는 시행 기관", "취득일", "등급 및 점수"], rows);
const work = (rows: string[][]) => table("경력", ["근무 기간", "회사 및 소속", "직위 및 고용 형태", "담당업무"], rows);
function entryBlock(title: string, lines: FreeformEntry["lines"]): FreeformBlock { return { type: "entries", title, entries: [{ title: "", lines }] }; }

/** Select saved facts; no model-generated claims or cross-company essays are exported. */
export function buildFreeformDocument(company: string, selection: { role: string; revision: string }, profile: ApplicantProfile,
  draft: ApplicationDraft | null, options: FreeformOptions, providedCatalog?: CompositionCatalog): FreeformDocument {
  const blank = options.mode === "blank", p = !blank && profile.updatedAt > 0 ? profile : null;
  const warnings: FreeformDocument["warnings"] = [];
  const warn = (label: string, reason: string) => warnings.push({ label, reason });
  if (!blank && !p) warn("지원 정보", "내 지원 자료에서 지원 정보를 먼저 저장해주세요. 비어 있는 양식으로 생성됩니다.");
  if (!blank && !p?.name.trim()) warn("성명", "저장된 성명이 없습니다.");
  if (!blank && !p?.email.trim() && !p?.phone.trim()) warn("연락처", "저장된 이메일과 전화번호가 없습니다.");
  if (!selection.role.trim()) warn("지원 직무", "공고 상단에서 지원 직무를 선택해주세요.");
  const field = (value: unknown, label: string) => blank ? `[${label}]` : text(value);
  const blocks: FreeformBlock[] = [], detailBlocks: FreeformBlock[] = [];
  if (blank) {
    blocks.push(education([["[재학 기간]", "[학교명 / 전공]", "[학위 / 졸업 상태]", "[취득 / 만점]"]]),
      credentials([["자격", "[자격명]", "[발급 기관]", "[취득일]", "[등급]"], ["어학", "[시험명]", "[시행 기관]", "[응시일]", "[점수]"]]),
      work([["[근무 기간]", "[회사 / 부서]", "[직위 / 고용 형태]", "[담당업무]"]]),
      entryBlock("직무 관련 경험", [{ label: "경험", text: "[선택한 경험명 / 기간 / 실제 수행한 내용]" }]),
      entryBlock("활용 역량 및 참고 자료", [{ label: "활용 역량", text: "[실제 활용 가능한 지식 및 도구]" }, { label: "참고 자료", text: "[포트폴리오 등 자료 링크]" }]));
    if (options.includeDetails) detailBlocks.push({ type: "entries", title: "선택한 경험 상세", entries: [{ title: "[회사명 또는 프로젝트·활동명]", meta: "[기간 / 실제 경험 구분]", lines: [
      { label: "본인 역할", text: "[본인이 수행한 범위]" }, { label: "수행 내용", text: "[실제로 판단하고 수행한 내용]" }, { label: "결과 및 근거", text: "[확인 가능한 결과와 근거]" },
    ] }] });
  } else {
    const catalog = providedCatalog ?? { version: `profile:${profile.updatedAt}`, focus: inferCompositionFocus(selection.role), roleRevision: selection.revision, items: recommendComposition(profile, [], selection.role) };
    const included = resolveComposition(catalog, options.composition).filter(i => i.level !== "exclude");
    const edu = included.filter(i => i.kind === "education").map(i => i.row!);
    if (edu.length) blocks.push(education(edu));
    const certs = included.filter(i => i.kind === "credential" || i.kind === "language");
    if (catalog.focus === "risk") certs.sort((a, b) => Number(/재무위험|FRM/i.test(b.title)) - Number(/재무위험|FRM/i.test(a.title)));
    if (certs.length) blocks.push(credentials(certs.map(i => i.row!)));
    const experiences = included.filter(i => i.kind === "experience");
    if (experiences.length) blocks.push(entryBlock("직무 관련 경험", experiences.map(i => ({ label: i.category, text: join(i.title, i.summary, i.period) }))));
    const jobs = included.filter(i => i.kind === "work");
    if (jobs.length) blocks.push(work(jobs.map(i => {
      const row = [...i.row!];
      row[3] = i.summary || (i.level === "detail" ? options.includeDetails ? "경력 및 경험 상세 참조" : "아래 선택한 경험 상세 참조" : "");
      return row;
    })));
    const skills = included.filter(i => i.kind === "skill");
    if (skills.length) blocks.push(entryBlock("활용 역량 및 참고 자료", skills.map(i => ({ label: i.title, text: i.summary }))));
    const detailed = included.filter(i => (i.kind === "work" || i.kind === "experience") && i.level === "detail" && i.detail.trim());
    if (detailed.length) {
      const b: FreeformBlock = { type: "entries", title: "선택한 경험 상세", entries: detailed.map(i => ({ title: i.title, meta: join(i.category, i.period), lines: [{ label: "수행 내용", text: i.detail }] })) };
      if (options.includeDetails) detailBlocks.push(b); else blocks.push(b);
    }
  }
  if (options.includeMilitary) blocks.push(entryBlock("병역사항", [{ label: "병역", text: blank ? "[병역 구분 / 군별 / 계급 / 복무 기간]" : [
    join(p?.militaryStatus, p?.militaryBranch, p?.militarySpecialty, p?.militaryRank, p?.militaryDischargeType),
    [text(p?.militaryServiceStart), text(p?.militaryServiceEnd)].filter(Boolean).join(" - "),
  ].filter(Boolean).join("  ") }]));
  const personalRows = [["성명", field(p?.name, "성명"), "연락처", field(p?.phone, "연락처")], ["이메일", field(p?.email, "이메일")]];
  if (options.includePersonalDetails) personalRows.push(
    ["생년월일", field(p?.birthDate, "생년월일"), "성별 및 국적", blank ? "[성별 / 국적]" : join(p?.gender, p?.nationality)],
    ["주소", blank ? "[주소]" : [p?.postalCode, p?.address, p?.addressDetail].map(text).filter(Boolean).join(" ")]);
  const pages: FreeformPage[] = [{ title: "입사지원서", blocks }];
  if (detailBlocks.length) pages.push({ title: "경력 및 경험 상세", blocks: detailBlocks });
  if (options.includeEssays) {
    const answers: FreeformEntry[] = [];
    if (!blank) for (const a of draft?.essayAnswers ?? []) {
      if (a.source !== "user_question") { if (a.answer.trim()) warn(a.question, "이전 형식의 답변입니다. 문항과 함께 저장한 뒤 다시 생성해주세요."); continue; }
      if (!a.answer.trim() || a.status === "needs_info") { warn(a.question, "답변이 비어 있거나 보완이 필요한 상태여서 포함하지 않았습니다."); continue; }
      if ((a.roleRevision && a.roleRevision !== selection.revision) || (a.targetRole && a.targetRole !== selection.role)) {
        warn(a.question, "이전에 선택한 지원 직무의 답변입니다. 현재 직무에 맞게 확인한 뒤 문항과 답변을 다시 등록해주세요."); continue;
      }
      answers.push({ title: a.question, lines: [{ label: "", text: a.answer }] });
    }
    if (!answers.length) {
      if (!blank) warn("자기소개서", "이 공고에서 사용할 수 있는 저장 답변이 없어 기본 소제목만 넣었습니다. 문항별 자기소개서에서 답변을 저장한 뒤 다시 생성해주세요.");
      for (const title of ["지원동기", "직무 관련 역량", "일하는 방식"]) answers.push({ title, lines: [{ label: "", text: blank ? "[내용을 입력해주세요.]" : "" }] });
    }
    pages.push({ title: "자기소개서", blocks: [{ type: "entries", title: "", entries: answers }] });
  }
  const values = [text(company), text(selection.role), options.applicationType, ...personalRows.flatMap(row => row.filter((_, i) => i % 2)), ...pages.flatMap(page => page.blocks.flatMap(b => b.type === "table" ? b.rows.flat() : b.entries.flatMap(e => e.lines.map(l => l.text))))];
  return { mode: options.mode, company: text(company), role: text(selection.role), name: field(p?.name, "성명"),
    contacts: blank ? ["[연락처]", "[이메일]"] : [p?.phone, p?.email].map(text).filter(Boolean), applicationType: options.applicationType || (blank ? "[신입 / 경력 / 인턴]" : ""), personalRows,
    pages, warnings, filled: blank ? 0 : values.filter(Boolean).length, total: values.length };
}
export function freeformFilename(document: FreeformDocument, mode: FreeformOptions["mode"]): string {
  const safe = (s: string) => Array.from(s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").trim()).slice(0, 60).join("");
  return [document.company, document.role, mode === "filled" ? document.name : "", mode === "blank" ? "입사지원서-양식" : "입사지원서"].map(safe).filter(Boolean).join("_") + ".docx";
}
