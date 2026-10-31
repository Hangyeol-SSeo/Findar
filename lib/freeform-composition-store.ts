import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApplicantProfile } from "./applicant-profile";
import { defaultComposition, inferCompositionFocus, isFocus, materialTags, parseComposition, recommendComposition, resolveComposition, str, type ApplicationMaterial, type CompositionCatalog, type CompositionFocus, type FreeformComposition } from "./freeform-composition";

const dir = () => join(process.cwd(), "data");
function readJson(name: string): unknown {
  try { return JSON.parse(readFileSync(join(dir(), name), "utf8")); } catch { return null; }
}
function writeJson(name: string, value: unknown) {
  mkdirSync(dir(), { recursive: true });
  const path = join(dir(), name), temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2)); renameSync(temp, path);
}
export function parseApplicationMaterial(value: unknown): Omit<ApplicationMaterial, "id" | "updatedAt"> & { id?: string; expectedUpdatedAt?: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("추가할 경험을 확인해주세요.");
  const x = value as Record<string, unknown>;
  const allowed = ["id", "title", "category", "period", "summary", "detail", "tags", "status", "source", "originId", "expectedUpdatedAt"];
  if (Object.keys(x).some(k => !allowed.includes(k))) throw new Error("알 수 없는 경험 항목입니다.");
  for (const [key, max] of [["title", 180], ["category", 60], ["period", 100], ["summary", 500], ["detail", 20000], ["source", 300]] as const) {
    if (typeof x[key] !== "string" || (x[key] as string).length > max || (key === "summary" && /[\r\n]/.test(x[key] as string))) throw new Error("경험의 제목·한 줄 설명·상세 내용을 확인해주세요.");
  }
  if (!str(x.title) || !str(x.category) || !str(x.summary) || !str(x.detail)) throw new Error("제목, 경험 구분, 한 줄 설명, 실제 수행 내용을 입력해주세요.");
  if (!Array.isArray(x.tags) || x.tags.length > 6 || !x.tags.every(isFocus) || !["confirmed", "in_progress"].includes(x.status as string)) throw new Error("경험의 직무와 진행 상태를 확인해주세요.");
  if ((x.id !== undefined && (typeof x.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(x.id))) || (x.originId !== undefined && (typeof x.originId !== "string" || x.originId.length > 180)) || (x.expectedUpdatedAt !== undefined && typeof x.expectedUpdatedAt !== "number")) throw new Error("경험 식별 정보를 확인해주세요.");
  return { id: x.id as string | undefined, expectedUpdatedAt: x.expectedUpdatedAt as number | undefined,
    title: str(x.title), category: str(x.category), period: str(x.period), summary: str(x.summary), detail: str(x.detail),
    source: str(x.source), tags: [...new Set(x.tags as CompositionFocus[])], status: x.status as "confirmed" | "in_progress", ...(x.originId ? { originId: str(x.originId) } : {}) };
}
export function readApplicationMaterials(): ApplicationMaterial[] {
  const raw = readJson("application-materials.json") as { materials?: unknown[] } | null;
  if (!Array.isArray(raw?.materials)) return [];
  return raw.materials.flatMap((v) => {
    try {
      const x = v as Record<string, unknown>;
      const parsed = parseApplicationMaterial(Object.fromEntries(Object.entries(x).filter(([k]) => k !== "updatedAt")));
      return parsed.id ? [{ ...parsed, id: parsed.id, updatedAt: typeof x.updatedAt === "number" ? x.updatedAt : 0 } as ApplicationMaterial] : [];
    } catch { return []; }
  });
}
export function saveApplicationMaterial(value: unknown): ApplicationMaterial {
  const parsed = parseApplicationMaterial(value), materials = readApplicationMaterials();
  const previous = materials.find(m => m.id === parsed.id);
  if (parsed.id && !previous) throw new Error("수정할 경험을 찾을 수 없습니다. 자료를 새로 불러와주세요.");
  if (previous && parsed.expectedUpdatedAt !== previous.updatedAt) throw new Error("다른 화면에서 수정된 경험입니다. 다시 불러온 뒤 수정해주세요.");
  const { expectedUpdatedAt: _expected, ...fields } = parsed;
  void _expected;
  const material = { ...fields, id: previous?.id ?? randomUUID(), updatedAt: Date.now() } as ApplicationMaterial;
  writeJson("application-materials.json", { materials: [...materials.filter(m => m.id !== material.id), material] });
  return material;
}
function readReviewCards(confirmed: ApplicationMaterial[]): ApplicationMaterial[] {
  const raw = readJson("experience-cards.json") as { cards?: unknown[] } | null;
  const imported = new Set(confirmed.map(m => m.originId).filter(Boolean));
  if (!Array.isArray(raw?.cards)) return [];
  return raw.cards.slice(0, 300).flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const c = value as Record<string, unknown>;
    if (c.excluded || !str(c.id) || !str(c.context) || imported.has(`card:${str(c.id)}`)) return [];
    const list = (key: string) => Array.isArray(c[key]) ? (c[key] as unknown[]).map(str).filter(Boolean) : [];
    const detail = list("personal_actions").join("\n");
    if (!detail) return [];
    const limitations = list("result_limitations");
    return [{ id: `card-${str(c.id)}`, title: str(c.context).slice(0, 180), category: "경험 자료", period: str(c.period) === "불명" ? "" : str(c.period),
      summary: str(c.context).slice(0, 500), detail: detail.slice(0, 20000), tags: materialTags(str(c.context) + detail),
      status: "review" as const, source: ["과거 자기소개서·이력서에서 정리한 경험 카드", ...limitations].join(" · ").slice(0, 300), originId: `card:${str(c.id)}`, updatedAt: 0 }];
  });
}
export interface CompositionJob { company?: string; title?: string; rawContent?: string; jdSummary?: unknown }
export function loadCompositionCatalog(profile: ApplicantProfile, selection: { role: string; revision: string }, job: CompositionJob, focus = inferCompositionFocus(selection.role)): CompositionCatalog {
  const materials = readApplicationMaterials();
  const jobText = [job.title, job.rawContent, typeof job.jdSummary === "string" ? job.jdSummary : JSON.stringify(job.jdSummary ?? "")].filter(Boolean).join("\n");
  const items = recommendComposition(profile, [...materials, ...readReviewCards(materials)], selection.role, jobText, focus);
  const version = createHash("sha256").update(JSON.stringify([profile.updatedAt, selection, job.company, jobText, focus, items])).digest("hex");
  return { version, focus, roleRevision: selection.revision, items };
}
export function getCompositionPlan(seq: string, catalog: CompositionCatalog, reset = false) {
  const saved = (readJson("freeform-compositions.json") as { plans?: Record<string, unknown> } | null)?.plans?.[seq];
  if (!reset && saved) {
    try { const plan = parseComposition(saved); resolveComposition(catalog, plan); return { plan, notice: "저장한 구성을 불러왔습니다." }; } catch { /* changed sources/role invalidate saved choices */ }
  }
  return { plan: defaultComposition(catalog), notice: saved && !reset ? "직무 또는 이력 자료가 달라 기본 구성을 다시 불러왔습니다. 선택 내용을 확인해주세요." : "" };
}
export function savedCompositionFocus(seq: string, revision: string): CompositionFocus | undefined {
  const saved = (readJson("freeform-compositions.json") as { plans?: Record<string, unknown> } | null)?.plans?.[seq];
  try { const plan = parseComposition(saved); return plan.roleRevision === revision ? plan.focus : undefined; } catch { return undefined; }
}
export function saveCompositionPlan(seq: string, catalog: CompositionCatalog, plan: FreeformComposition) {
  resolveComposition(catalog, plan);
  const raw = readJson("freeform-compositions.json") as { plans?: Record<string, unknown> } | null;
  const plans = raw?.plans && typeof raw.plans === "object" && !Array.isArray(raw.plans) ? raw.plans : {};
  writeJson("freeform-compositions.json", { plans: { ...plans, [seq]: plan } });
}
