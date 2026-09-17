import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  getCompany,
  getCompanySections,
  saveCompanySection,
  setCompanyDartMatch,
  upsertCompanySeen,
  type CompanySection,
} from "./db";
import {
  findCorpCode,
  fetchCompanyOverview,
  fetchKeyFinancials,
  fetchExecutives,
  isDartConfigured,
} from "./dart";
import { COMPANY_SECTION_TTL_DAYS } from "./config";
import { COMPANY_SECTION_TYPES, type CompanySectionType } from "./company-section-types";

export { COMPANY_SECTION_TYPES, COMPANY_SECTION_LABELS } from "./company-section-types";
export type { CompanySectionType } from "./company-section-types";

// 이 회사 리서치 전용 모델. WebSearch는 Anthropic 서버 내장 툴이라 FreeRide 같은 로컬
// 게이트웨이가 그대로 패스스루하지 못할 가능성이 높아, summarizer/matcher와 달리
// getSummaryModelOptions()를 거치지 않고 항상 Anthropic API로 직접 호출한다.
const RESEARCH_MODEL = "claude-haiku-4-5-20251001";

interface SectionResult {
  content: string;
  contentJson?: unknown;
  sources: { title: string; url: string }[];
  status: "ok" | "partial" | "failed";
}

function isStale(section: CompanySection | undefined, sectionType: CompanySectionType): boolean {
  if (!section) return true;
  const ttlDays = COMPANY_SECTION_TTL_DAYS[sectionType] ?? 30;
  return Date.now() - section.generatedAt > ttlDays * 24 * 60 * 60 * 1000;
}

// 미생성이거나 TTL이 지난 섹션만 골라준다 — "새로고침"을 눌러도 아직 신선한 섹션까지
// 다시 AI를 호출하지 않기 위함 (기업 리서치는 비용이 드는 작업이라 점층적으로만 채운다).
export function listStaleSections(
  normalizedName: string,
  requested?: CompanySectionType[]
): CompanySectionType[] {
  const existing = new Map(getCompanySections(normalizedName).map((s) => [s.sectionType, s]));
  const candidates = requested ?? [...COMPANY_SECTION_TYPES];
  return candidates.filter((t) => isStale(existing.get(t as CompanySectionType), t as CompanySectionType));
}

function extractSources(text: string): { title: string; url: string }[] {
  const sources: { title: string; url: string }[] = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    sources.push({ title: m[1], url: m[2] });
  }
  return sources;
}

const WEB_SEARCH_INSTRUCTION =
  "마지막 줄에 참고한 출처를 마크다운 링크 형식으로 나열해 (예: [기사 제목](https://...)). 확실하지 않은 내용은 쓰지 말고, 검색 결과가 부족하면 아는 범위까지만 짧게 작성해.";

async function runWebSearchSection(prompt: string): Promise<SectionResult> {
  let resultText = "";
  try {
    for await (const message of query({
      prompt,
      options: {
        model: RESEARCH_MODEL,
        maxTurns: 4,
        allowedTools: ["WebSearch"],
      },
    })) {
      if ("result" in message) resultText = message.result;
    }
  } catch (e) {
    console.error("[company-research] WebSearch 섹션 호출 실패:", e);
    return { content: "", sources: [], status: "failed" };
  }
  const content = resultText.trim();
  if (!content) return { content: "", sources: [], status: "failed" };
  return { content, sources: extractSources(content), status: "ok" };
}

async function runSingleTurnSummary(prompt: string): Promise<string> {
  let resultText = "";
  try {
    for await (const message of query({
      prompt,
      options: { model: RESEARCH_MODEL, maxTurns: 1, allowedTools: [] },
    })) {
      if ("result" in message) resultText = message.result;
    }
  } catch (e) {
    console.error("[company-research] 단일 요약 호출 실패:", e);
    return "";
  }
  return resultText.trim();
}

async function researchOverview(displayName: string): Promise<SectionResult> {
  const prompt = `"${displayName}"는 한국 금융투자협회 소속 회원사(증권/자산운용/금융투자 등)야. 웹 검색으로 이 회사에 대해 조사해서 아래 항목을 포함한 한국어 요약을 3-5문장으로 작성해:
- 어떤 회사인가 (설립연도, 소속 그룹/계열이 있다면)
- 주력 사업/부문
- 시장에서의 위치나 특징

${WEB_SEARCH_INSTRUCTION}`;
  return runWebSearchSection(prompt);
}

async function researchCulture(displayName: string): Promise<SectionResult> {
  const prompt = `"${displayName}"의 인재상, 조직문화, 채용 시 중요하게 보는 역량을 웹 검색으로 조사해서 3-5문장으로 요약해. 공식 채용 페이지나 인터뷰 기사를 우선 참고해.

${WEB_SEARCH_INSTRUCTION}`;
  return runWebSearchSection(prompt);
}

async function researchNews(displayName: string): Promise<SectionResult> {
  const prompt = `"${displayName}"의 최근 3개월 이내 뉴스, 사업 행보, 주요 이슈를 웹 검색으로 조사해서 3-5문장으로 요약해. 지원자 입장에서 면접·지원 시 알아두면 좋을 내용 위주로 정리해.

${WEB_SEARCH_INSTRUCTION}`;
  return runWebSearchSection(prompt);
}

// companies.dartCorpCode에 이미 매칭된 값이 있으면 재사용하고, 없으면 새로 찾아서 저장한다.
// (fuzzy 매칭이 틀렸을 경우를 대비해 나중에 UI에서 수동 정정하는 기능은 이번 범위 밖)
async function ensureDartMatch(
  normalizedName: string,
  displayName: string
): Promise<{ corpCode: string } | null> {
  upsertCompanySeen(displayName); // 없으면 아래 setCompanyDartMatch의 UPDATE가 no-op이 되는 걸 방지
  const existing = getCompany(normalizedName);
  if (existing?.dartCorpCode) {
    return { corpCode: existing.dartCorpCode };
  }
  const match = await findCorpCode(displayName);
  setCompanyDartMatch(normalizedName, match?.corpCode ?? null, match?.confidence ?? null);
  return match ? { corpCode: match.corpCode } : null;
}

async function researchFinancials(
  normalizedName: string,
  displayName: string
): Promise<SectionResult> {
  if (!isDartConfigured()) {
    return { content: "DART 연동이 설정되지 않았습니다 (DART_API_KEY 없음).", sources: [], status: "failed" };
  }
  const match = await ensureDartMatch(normalizedName, displayName);
  if (!match) {
    return { content: "DART에서 이 회사의 법인 정보를 찾지 못했습니다.", sources: [], status: "failed" };
  }
  const financials = await fetchKeyFinancials(match.corpCode);
  if (!financials) {
    return { content: "DART에 공시된 재무제표를 찾지 못했습니다.", sources: [], status: "partial" };
  }
  const prompt = `다음은 "${displayName}"의 DART 공시 재무 데이터(${financials.bsnsYear}년, ${
    financials.fsDiv === "CFS" ? "연결" : "별도"
  }재무제표, 단위: 원)야. 이 수치를 바탕으로 재무상태를 2-3문장으로 간결하게 요약해 (전년 대비 증감 방향 포함, 억원 단위로 환산해서 표현):
${financials.figures.map((f) => `- ${f.label}: ${f.thisYearAmount} (전년: ${f.lastYearAmount})`).join("\n")}`;
  const content = await runSingleTurnSummary(prompt);
  const sourceUrl = financials.sourceRceptNo
    ? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${financials.sourceRceptNo}`
    : "https://dart.fss.or.kr";
  return {
    content: content || "재무 데이터를 요약하지 못했습니다.",
    contentJson: financials,
    sources: [{ title: "DART 전자공시시스템", url: sourceUrl }],
    status: content ? "ok" : "partial",
  };
}

async function researchGovernanceStructure(
  normalizedName: string,
  displayName: string
): Promise<SectionResult> {
  if (!isDartConfigured()) {
    return { content: "DART 연동이 설정되지 않았습니다 (DART_API_KEY 없음).", sources: [], status: "failed" };
  }
  const match = await ensureDartMatch(normalizedName, displayName);
  if (!match) {
    return { content: "DART에서 이 회사의 법인 정보를 찾지 못했습니다.", sources: [], status: "failed" };
  }
  const [overview, executives] = await Promise.all([
    fetchCompanyOverview(match.corpCode),
    fetchExecutives(match.corpCode),
  ]);
  if (!overview && executives.length === 0) {
    return { content: "DART에 공시된 경영진 정보를 찾지 못했습니다.", sources: [], status: "partial" };
  }
  const prompt = `다음은 "${displayName}"의 DART 공시 정보야. 이를 바탕으로 경영진 구성과 지배구조 특징을 2-3문장으로 요약해:
대표이사: ${overview?.ceoName || "정보 없음"}
설립일: ${overview?.establishedDate || "정보 없음"}
임원 현황:
${executives.map((e) => `- ${e.name} (${e.position}, 재임: ${e.tenurePeriod})`).join("\n") || "정보 없음"}`;
  const content = await runSingleTurnSummary(prompt);
  return {
    content: content || "경영진 정보를 요약하지 못했습니다.",
    contentJson: { overview, executives },
    sources: [{ title: "DART 전자공시시스템 - 임원현황", url: "https://dart.fss.or.kr" }],
    status: content ? "ok" : "partial",
  };
}

export async function researchSection(
  normalizedName: string,
  displayName: string,
  sectionType: CompanySectionType
): Promise<CompanySection> {
  let result: SectionResult;
  switch (sectionType) {
    case "overview":
      result = await researchOverview(displayName);
      break;
    case "culture":
      result = await researchCulture(displayName);
      break;
    case "news":
      result = await researchNews(displayName);
      break;
    case "financials":
      result = await researchFinancials(normalizedName, displayName);
      break;
    case "governance_structure":
      result = await researchGovernanceStructure(normalizedName, displayName);
      break;
  }
  saveCompanySection(normalizedName, sectionType, { ...result, model: RESEARCH_MODEL });
  return {
    sectionType,
    content: result.content,
    contentJson: result.contentJson ?? null,
    sources: result.sources,
    model: RESEARCH_MODEL,
    status: result.status,
    generatedAt: Date.now(),
  };
}
