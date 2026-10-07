import type { EssaySource } from "./essay-contract";
export interface PlanCitation { sourceId: string; quote: string; purpose: string; paragraph: number }
export interface SelectedMaterial { sourceId: string; quote: string; reason: string }
// 문항 요구와 근거의 대응(cover-letter-team evidence-planner·intake-and-gaps의 갭 상태). 소재는 반드시 어떤 요구를
// 충족하는지 밝혀야 선택되고, 맞는 소재가 없으면 억지로 채우지 않고 그 상태를 그대로 기록한다.
export const COVERAGE_STATUSES = ["SUFFICIENT", "WEAKLY_SUPPORTED", "MISSING", "NO_ACTUAL_EXPERIENCE", "CONTRADICTORY", "NOT_APPLICABLE", "UNKNOWN"] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];
export interface MaterialCoverage { requirement: string; status: CoverageStatus; sourceIds: string[]; rationale: string }
export interface EssayPlan {
  questionTypes: string[]; personalEvidence: "required" | "optional";
  question: string; intent: string; message: string; outline: string[]; materialCriteria: string[];
  researchMode: "direct" | "perspective" | "none";
  research: PlanCitation[]; notes: string[];
  selectedMaterials: SelectedMaterial[]; missingInfo: string[]; skillVersion: string;
  coverage?: MaterialCoverage[]; materialNotes?: string[];
}
export function planStrings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((s) => typeof s === "string" && s.trim())) throw new Error("작성 구상의 항목이 올바르지 않습니다.");
  return value;
}
function field(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("작성 구상의 필수 설명이 없습니다.");
  return value;
}
export function validatePlans(value: Record<string, unknown>, questions: string[], sources: EssaySource[], skillVersion: string): EssayPlan[] {
  if (!Array.isArray(value.plans) || value.plans.length !== questions.length) throw new Error("전체 문항 수와 구상 수가 일치하지 않습니다.");
  return questions.map((question) => {
    const matches = (value.plans as Record<string, unknown>[]).filter((p) => p && p.question === question);
    if (matches.length !== 1) throw new Error("문항별 구상이 누락되거나 중복되었습니다.");
    const p = matches[0];
    const questionTypes = planStrings(p.questionTypes);
    if (!questionTypes.length || questionTypes.some(t => !["experience", "motivation", "opinion", "freeform"].includes(t))) throw new Error("문항 요구 유형을 experience, motivation, opinion, freeform 중 하나 이상 지정해주세요.");
    if (p.personalEvidence !== "required" && p.personalEvidence !== "optional") throw new Error("개인 경험의 필수 여부를 지정해주세요.");
    if (questionTypes.includes("experience") && p.personalEvidence !== "required") throw new Error("실제 경험을 묻는 문항에는 개인 경험 근거가 필요합니다.");
    const outline = planStrings(p.outline), materialCriteria = planStrings(p.materialCriteria);
    if (!outline.length || !materialCriteria.length) throw new Error("문단 흐름과 소재 선정 기준이 필요합니다.");
    if (!["direct", "perspective", "none"].includes(String(p.researchMode)) || !Array.isArray(p.research)) throw new Error("리서치 활용 설계가 없습니다.");
    const research = p.research.map((r: PlanCitation) => {
      const source = sources.find((s) => s.id === r?.sourceId && s.id.startsWith("company."));
      const prefix = `문항 “${question}”의 회사 근거(${r?.sourceId ?? "출처 없음"})`;
      if (!source) throw new Error(`${prefix}: 제공된 company 자료 ID를 사용해주세요.`);
      if (!source.text.includes(field(r.quote))) throw new Error(`${prefix}: 인용이 원문과 다릅니다. 해당 text에서 연속된 원문을 그대로 복사해주세요.`);
      if (!Number.isInteger(r.paragraph) || r.paragraph < 1 || r.paragraph > outline.length) throw new Error(`${prefix}: 문단 번호는 1~${outline.length} 사이 정수여야 합니다.`);
      return { sourceId: r.sourceId, quote: r.quote, purpose: field(r.purpose), paragraph: r.paragraph };
    });
    if ((p.researchMode === "none") !== (research.length === 0)) throw new Error("리서치 활용 방식과 근거가 일치하지 않습니다.");
    const notes = planStrings(p.notes);
    if (p.researchMode === "none" && !notes.length) throw new Error("리서치를 활용하지 않는 이유가 필요합니다.");
    return { questionTypes, personalEvidence: p.personalEvidence, question, intent: field(p.intent), message: field(p.message), outline, materialCriteria, researchMode: p.researchMode as EssayPlan["researchMode"], research, notes, selectedMaterials: [], missingInfo: [], skillVersion };
  });
}
export function applyMaterials(value: Record<string, unknown>, plans: EssayPlan[], sources: EssaySource[]): EssayPlan[] {
  if (!Array.isArray(value.materials) || value.materials.length !== plans.length) throw new Error("문항별 소재 배치 수가 일치하지 않습니다.");
  return plans.map((plan) => {
    const rows = (value.materials as Record<string, unknown>[]).filter((v) => v && v.question === plan.question);
    if (rows.length !== 1 || !Array.isArray(rows[0].selectedMaterials)) throw new Error("문항별 소재 배치가 누락되거나 중복되었습니다.");
    const selectedMaterials = rows[0].selectedMaterials.map((m: SelectedMaterial) => {
      const source = sources.find((s) => s.id === m?.sourceId && s.id !== "job" && !s.id.startsWith("company."));
      if (!source || !source.text.includes(field(m.quote))) throw new Error("선정한 경험이 저장 자료와 일치하지 않습니다.");
      return { sourceId: m.sourceId, quote: m.quote, reason: field(m.reason) };
    });
    const missingInfo = planStrings(rows[0].missingInfo);
    if (plan.personalEvidence === "required" && !selectedMaterials.length && !missingInfo.length) throw new Error("적합한 경험 또는 보완 질문이 필요합니다.");
    const personalIds = new Set(sources.filter((s) => s.id !== "job" && !s.id.startsWith("company.")).map((s) => s.id));
    if (!Array.isArray(rows[0].coverage) || !rows[0].coverage.length) throw new Error(`문항 “${plan.question}”의 요구별 근거 판정(coverage)이 없습니다.`);
    const coverage: MaterialCoverage[] = rows[0].coverage.map((c: MaterialCoverage) => {
      if (!COVERAGE_STATUSES.includes(c?.status)) throw new Error(`근거 판정 상태는 ${COVERAGE_STATUSES.join(", ")} 중 하나여야 합니다.`);
      const sourceIds = Array.isArray(c.sourceIds) ? c.sourceIds.filter((id): id is string => typeof id === "string") : [];
      if (sourceIds.some((id) => !personalIds.has(id))) throw new Error("근거 판정의 sourceIds는 제공된 개인 자료 id여야 합니다.");
      if ((c.status === "SUFFICIENT" || c.status === "WEAKLY_SUPPORTED") && !sourceIds.length) throw new Error(`${c.status} 판정에는 근거 자료 id가 필요합니다.`);
      return { requirement: field(c.requirement), status: c.status, sourceIds, rationale: field(c.rationale) };
    });
    // 어느 요구에도 쓰이지 않는 소재는 고르지 않는다 — "자료에 있다"는 이유만으로 끼워 넣는 것을 막는다.
    const covering = new Set(coverage.filter((c) => c.status === "SUFFICIENT" || c.status === "WEAKLY_SUPPORTED").flatMap((c) => c.sourceIds));
    const orphan = selectedMaterials.filter((m) => !covering.has(m.sourceId));
    if (orphan.length) throw new Error(`문항 “${plan.question}”: 선정한 소재 ${orphan.map((m) => m.sourceId).join(", ")}가 어떤 요구를 충족하는지 coverage에 없습니다. 요구와 연결되지 않는 소재는 빼세요.`);
    return { ...plan, selectedMaterials, missingInfo, coverage };
  });
}
