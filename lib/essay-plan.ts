import type { EssaySource } from "./essay-contract";
export interface PlanCitation { sourceId: string; quote: string; purpose: string; paragraph: number }
// anchor: 이 소재가 답하는 공고·문항·요청의 원문 구절. 코드가 원문 일치를 확인하므로, 모델이 공고에 없는 요구("데이터 역량" 등)를
// 지어내 경험을 끌어다 붙일 수 없다. fit: direct는 그 업무·요구를 실제로 해 본 경험, transferable은 다른 맥락의 경험이 그 구절과 닿는 경우.
export type MaterialFit = "direct" | "transferable";
export interface MaterialAnchor { source: "question" | "job" | "request"; quote: string }
export interface SelectedMaterial { sourceId: string; quote: string; reason: string; anchor?: MaterialAnchor; fit?: MaterialFit }
// 문항 요구와 근거의 대응(cover-letter-team evidence-planner·intake-and-gaps의 갭 상태). 소재는 반드시 어떤 요구를
// 충족하는지 밝혀야 선택되고, 맞는 소재가 없으면 억지로 채우지 않고 그 상태를 그대로 기록한다.
export const COVERAGE_STATUSES = ["SUFFICIENT", "WEAKLY_SUPPORTED", "MISSING", "NO_ACTUAL_EXPERIENCE", "CONTRADICTORY", "NOT_APPLICABLE", "UNKNOWN"] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];
// mandatory: 문항이 실제로 요구하는 하위 요소인지(선택적 개선 기준이면 false). cover-letter-team 요건 계약의 mandatory와 같다.
export interface MaterialCoverage { requirement: string; mandatory: boolean; status: CoverageStatus; sourceIds: string[]; rationale: string }
// 필수 요소가 이 상태면 답변을 쓸 수 없어 보완 질문이 작성을 멈춘다. 그 밖의 질문은 작성을 막지 않는 보강 제안이다.
const BLOCKING_STATUSES: CoverageStatus[] = ["MISSING", "NO_ACTUAL_EXPERIENCE", "CONTRADICTORY"];
export interface EssayPlan {
  questionTypes: string[]; personalEvidence: "required" | "optional";
  question: string; intent: string; message: string; outline: string[]; materialCriteria: string[];
  researchMode: "direct" | "perspective" | "none";
  research: PlanCitation[]; notes: string[];
  selectedMaterials: SelectedMaterial[]; missingInfo: string[]; skillVersion: string;
  coverage?: MaterialCoverage[]; materialNotes?: string[]; followUps?: string[];
}
export function planStrings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((s) => typeof s === "string" && s.trim())) throw new Error("작성 구상의 항목이 올바르지 않습니다.");
  return value;
}
function field(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("작성 구상의 필수 설명이 없습니다.");
  return value;
}
// 모델이 자료를 인용할 때 공백·줄바꿈·마크다운 강조(**)·JSON 이스케이프(\\n, \\")를 바꿔 옮기는 일이 잦다. 자료는 JSON 문자열로 넘어가
// 모델에게는 이스케이프된 모습으로 보이고, 회사 리서치는 마크다운이 많다. 이런 차이만 무시하고 같은 구절을 찾아 자료의 원래 구절을
// 돌려준다(뒤 단계의 원문 일치 검증이 그대로 통과하도록). 못 찾으면 null.
export function findVerbatim(sourceText: string, quote: string): string | null {
  if (!quote.trim()) return null;
  if (sourceText.includes(quote)) return quote;
  const norm = (text: string, keepIndex: boolean) => {
    const chars: string[] = [], index: number[] = [];
    let prevSpace = true;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "*" || ch === "`") continue;
      if (/\s/.test(ch)) { if (!prevSpace) { chars.push(" "); if (keepIndex) index.push(i); } prevSpace = true; continue; }
      chars.push(ch); if (keepIndex) index.push(i); prevSpace = false;
    }
    while (chars.at(-1) === " ") { chars.pop(); index.pop(); }
    return { text: chars.join(""), index };
  };
  const unescaped = quote.replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\\t/g, " ");
  const src = norm(sourceText, true), q = norm(unescaped, false).text;
  if (q.length < 5) return null;
  const at = src.text.indexOf(q);
  if (at < 0) return null;
  return sourceText.slice(src.index[at], src.index[at + q.length - 1] + 1);
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
    // 회사 근거 인용은 원문 구절로 바로잡고, 그래도 원문에 없거나 형식이 틀린 인용은 작성 전체를 실패시키지 않고 빼서 메모로 남긴다.
    // 흥국증권 4문항 작성이 이 검증 하나로 두 번 연속 통째로 실패했다(구상 단계는 문항 전체를 한 번에 검증한다).
    const dropped: string[] = [];
    const research: PlanCitation[] = p.research.flatMap((r: PlanCitation) => {
      const source = sources.find((s) => s.id === r?.sourceId && s.id.startsWith("company."));
      const quote = source && typeof r?.quote === "string" ? findVerbatim(source.text, r.quote) : null;
      const paragraph = Number.isInteger(r?.paragraph) ? Math.min(Math.max(r.paragraph, 1), outline.length) : null;
      if (!source || !quote || paragraph === null || typeof r?.purpose !== "string" || !r.purpose.trim()) {
        dropped.push(r?.sourceId ?? "출처 없음");
        return [];
      }
      return [{ sourceId: r.sourceId, quote, purpose: r.purpose, paragraph }];
    });
    const notes = Array.isArray(p.notes) ? p.notes.filter((n): n is string => typeof n === "string" && !!n.trim()) : [];
    if (dropped.length) notes.push(`회사 근거 인용 ${dropped.length}개(${[...new Set(dropped)].join(", ")})는 원문과 맞지 않아 쓰지 않았습니다.`);
    // 인용이 모두 빠지면 리서치를 쓰지 않는 구상으로 낮춘다. 인용 없이 none이 아니라고 한 구상도 같은 처리다.
    const researchMode = research.length ? (p.researchMode === "none" ? "perspective" : p.researchMode) : "none";
    if (researchMode === "none" && !notes.length) notes.push("회사 자료를 근거로 쓰지 않는 구상입니다.");
    return { questionTypes, personalEvidence: p.personalEvidence, question, intent: field(p.intent), message: field(p.message), outline, materialCriteria, researchMode: researchMode as EssayPlan["researchMode"], research, notes, selectedMaterials: [], missingInfo: [], skillVersion };
  });
}
// 공고 자료에서 업무·자격요건 문자열(anchor로 댈 수 있는 곳)과 이름 문자열(회사명·공고 제목·직무명·모집 직무)을 나눈다.
// 직무 이름("리스크관리")이나 회사명만 대고 아무 경험이나 연결하는 것을 막기 위해, 이름의 일부일 뿐인 구절은 anchor로 인정하지 않는다.
const JOB_ANCHOR_FIELDS = ["rawContent", "description", "qualifications"];
const JOB_NAME_FIELDS = ["company", "title", "targetRole", "positions"];
function jobTexts(text: string): { anchors: string[]; names: string[] } {
  try {
    const job = JSON.parse(text) as Record<string, unknown>;
    const collect = (keys: string[]) => {
      const out: string[] = [];
      const walk = (v: unknown) => { if (typeof v === "string") out.push(v); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
      keys.forEach((k) => walk(job[k]));
      return out;
    };
    return { anchors: collect(JOB_ANCHOR_FIELDS), names: collect(JOB_NAME_FIELDS) };
  } catch { return { anchors: [], names: [] }; }
}
const MIN_ANCHOR_CHARS = 5;
const compact = (text: string) => text.replace(/\s+/g, " ").trim();

// 근거 고정에 쓰는 원문: 문항, 공고의 업무·자격요건, 사용자 요청. 공고의 이름 문자열은 "이름의 일부일 뿐인 구절"을 거르는 데 쓴다.
export interface AnchorTexts { question: string[]; job: string[]; request: string[]; jobNames: string[] }
export function anchorTextsFrom(sources: EssaySource[], question: string, extraRequests: string[] = []): AnchorTexts {
  const job = sources.filter((s) => s.id === "job").map((s) => jobTexts(s.text));
  return {
    question: [question],
    job: job.flatMap((j) => j.anchors),
    request: [...sources.filter((s) => s.id.startsWith("user.current")).map((s) => s.text), ...extraRequests],
    jobNames: job.flatMap((j) => j.names).map((n) => n.replace(/\s/g, "")).filter(Boolean),
  };
}
// anchor가 원문 구절과 그대로 일치하는지(5자 이상, 회사명·공고 제목·직무명의 일부가 아님). 소재 배치와 고쳐쓰기가 함께 쓴다.
export function isValidAnchor(anchor: unknown, texts: AnchorTexts): anchor is MaterialAnchor {
  const a = anchor as Partial<MaterialAnchor> | undefined;
  const pool = a?.source === "question" || a?.source === "job" || a?.source === "request" ? texts[a.source] : undefined;
  const quote = typeof a?.quote === "string" ? a.quote : "";
  const bare = quote.replace(/\s/g, "");
  return !!pool && bare.length >= MIN_ANCHOR_CHARS && !texts.jobNames.some((n) => n.includes(bare)) && pool.some((t) => compact(t).includes(compact(quote)));
}
export const ANCHOR_RULE = `anchor.quote는 문항(question)·공고의 업무·자격요건(job)·사용자 요청(request) 중 하나에서 ${MIN_ANCHOR_CHARS}자 이상의 원문 구절을 그대로 복사해야 합니다(회사명·직무명만으로는 안 됩니다). 원문에 없는 요구에 경험을 연결하지 마세요.`;

// lenient: 마지막 시도에서 쓴다. 문항 하나·소재 하나의 오류로 묶음 전체를 버리지 않고, 틀린 소재는 빼고(메모), 처리할 수 없는
// 문항은 그 문항만 보완 질문으로 돌린다 — 흥국증권 4문항이 한 문항의 소재 anchor 하나 때문에 통째로 실패했다.
export function applyMaterials(value: Record<string, unknown>, plans: EssayPlan[], sources: EssaySource[], { lenient = false } = {}): EssayPlan[] {
  const rows = Array.isArray(value.materials) ? (value.materials as Record<string, unknown>[]) : null;
  if (!rows || (!lenient && rows.length !== plans.length)) throw new Error("문항별 소재 배치 수가 일치하지 않습니다.");
  return plans.map((plan) => {
    try { return materialsForPlan(plan, rows, sources, lenient); }
    catch (error) {
      if (!lenient) throw error;
      const reason = (error instanceof Error ? error.message : "소재 배치 오류").slice(0, 160);
      return { ...plan, selectedMaterials: [], coverage: [], followUps: [],
        missingInfo: [`이 문항은 소재 배치를 확인하지 못해 쓰지 않았습니다(${reason}). 다른 문항은 그대로 저장했으니 이 문항만 다시 작성을 요청해주세요.`] };
    }
  });
}

function materialsForPlan(plan: EssayPlan, rowsAll: Record<string, unknown>[], sources: EssaySource[], lenient: boolean): EssayPlan {
  const rows = rowsAll.filter((v) => v && v.question === plan.question);
  if (rows.length !== 1 || !Array.isArray(rows[0].selectedMaterials)) throw new Error("문항별 소재 배치가 누락되거나 중복되었습니다.");
  const dropped: string[] = [];
  const selectedMaterials: SelectedMaterial[] = (rows[0].selectedMaterials as SelectedMaterial[]).flatMap((m) => {
    try {
      const source = sources.find((s) => s.id === m?.sourceId && s.id !== "job" && !s.id.startsWith("company."));
      const quote = source ? findVerbatim(source.text, field(m.quote)) : null;
      if (!source || !quote) throw new Error(`선정한 경험(${m?.sourceId ?? "출처 없음"})의 인용이 저장 자료와 일치하지 않습니다. 해당 자료에서 연속된 원문을 그대로 복사해주세요.`);
      const anchor = m.anchor;
      if (!isValidAnchor(anchor, anchorTextsFrom(sources, plan.question))) throw new Error(`문항 “${plan.question}”의 소재 ${m.sourceId}: ${ANCHOR_RULE}`);
      if (m.fit !== "direct" && m.fit !== "transferable") throw new Error("소재의 fit은 direct 또는 transferable이어야 합니다. 어느 쪽으로도 원문 구절과 닿지 않으면 고르지 마세요.");
      return [{ sourceId: m.sourceId, quote, reason: field(m.reason), anchor: { source: anchor.source, quote: anchor.quote }, fit: m.fit }];
    } catch (error) {
      if (!lenient) throw error;
      dropped.push(m?.sourceId ?? "출처 없음");
      return [];
    }
  });
  const missingInfo = Array.isArray(rows[0].missingInfo) ? (rows[0].missingInfo as unknown[]).filter((q): q is string => typeof q === "string" && !!q.trim()) : planStrings(rows[0].missingInfo);
  const personalIds = new Set(sources.filter((s) => s.id !== "job" && !s.id.startsWith("company.")).map((s) => s.id));
  if (!Array.isArray(rows[0].coverage) || !rows[0].coverage.length) throw new Error(`문항 “${plan.question}”의 요구별 근거 판정(coverage)이 없습니다.`);
  const coverage: MaterialCoverage[] = rows[0].coverage.map((c: MaterialCoverage) => {
    if (!COVERAGE_STATUSES.includes(c?.status)) throw new Error(`근거 판정 상태는 ${COVERAGE_STATUSES.join(", ")} 중 하나여야 합니다.`);
    const sourceIds = Array.isArray(c.sourceIds) ? c.sourceIds.filter((id): id is string => typeof id === "string") : [];
    if (sourceIds.some((id) => !personalIds.has(id))) throw new Error("근거 판정의 sourceIds는 제공된 개인 자료 id여야 합니다.");
    if ((c.status === "SUFFICIENT" || c.status === "WEAKLY_SUPPORTED") && !sourceIds.length) throw new Error(`${c.status} 판정에는 근거 자료 id가 필요합니다.`);
    if (typeof c.mandatory !== "boolean") throw new Error("근거 판정마다 mandatory(문항의 필수 요소인지)를 true/false로 지정해주세요.");
    if (c.mandatory && c.status === "NOT_APPLICABLE") throw new Error("필수 요소를 NOT_APPLICABLE로 숨기지 마세요. 근거가 없으면 MISSING 등으로 판정하세요.");
    return { requirement: field(c.requirement), mandatory: c.mandatory, status: c.status, sourceIds, rationale: field(c.rationale) };
  });
  // 어느 요구에도 쓰이지 않는 소재는 고르지 않는다 — "자료에 있다"는 이유만으로 끼워 넣는 것을 막는다.
  const covering = new Set(coverage.filter((c) => c.status === "SUFFICIENT" || c.status === "WEAKLY_SUPPORTED").flatMap((c) => c.sourceIds));
  const orphan = selectedMaterials.filter((m) => !covering.has(m.sourceId));
  if (orphan.length && !lenient) throw new Error(`문항 “${plan.question}”: 선정한 소재 ${orphan.map((m) => m.sourceId).join(", ")}가 어떤 요구를 충족하는지 coverage에 없습니다. 요구와 연결되지 않는 소재는 빼세요.`);
  dropped.push(...orphan.map((m) => m.sourceId));
  const kept = selectedMaterials.filter((m) => covering.has(m.sourceId));
  const notes = dropped.length ? [`소재 확인: ${[...new Set(dropped)].join(", ")}는 인용이나 연결 근거가 원문과 맞지 않아 이 문항에 쓰지 않았습니다.`] : [];
  const blocked = coverage.some((c) => c.mandatory && BLOCKING_STATUSES.includes(c.status));
  // 쓸 경험이 남지 않았거나 필수 요소가 막혔는데 질문이 없으면, 엄격 모드에서는 고쳐 달라고 하고 마지막 시도에서는 이 문항만 보완 질문으로 돌린다.
  const needsQuestion = (plan.personalEvidence === "required" && !kept.length && !missingInfo.length) || (blocked && !missingInfo.length);
  if (needsQuestion && !lenient) {
    if (blocked) throw new Error(`문항 “${plan.question}”: 근거가 없는 필수 요소가 있습니다. 지어내지 말고 missingInfo에 확인할 질문을 남기세요.`);
    throw new Error("적합한 경험 또는 보완 질문이 필요합니다.");
  }
  if (needsQuestion || (plan.personalEvidence === "required" && !kept.length)) {
    const questions = missingInfo.length ? missingInfo : ["이 문항에 쓸 경험을 자료에서 찾지 못했습니다. 문항에 맞는 경험을 추가 요청에 적어 다시 작성을 요청해주세요."];
    return { ...plan, selectedMaterials: kept, missingInfo: questions, followUps: [], coverage, ...(notes.length ? { materialNotes: [...(plan.materialNotes ?? []), ...notes] } : {}) };
  }
  return { ...plan, selectedMaterials: kept, missingInfo: blocked ? missingInfo : [], followUps: blocked ? [] : missingInfo, coverage,
    ...(notes.length ? { materialNotes: [...(plan.materialNotes ?? []), ...notes] } : {}) };
}
