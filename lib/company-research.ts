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

// 이 회사 리서치 전용 모델. WebSearch/WebFetch는 Anthropic 서버 내장 툴이라 FreeRide 같은
// 로컬 게이트웨이가 그대로 패스스루하지 못할 가능성이 높아, summarizer/matcher와 달리
// getSummaryModelOptions()를 거치지 않고 항상 Anthropic API로 직접 호출한다.
// Sonnet 사용: 지원 시 회사 이해도가 낮아 보이면 안 된다는 게 이 기능의 존재 이유라
// 짧고 얕은 Haiku 요약보다 여러 출처를 실제로 종합·분석하는 능력이 더 중요하다고 판단.
const RESEARCH_MODEL = "claude-sonnet-4-6";

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

// 미생성이거나 TTL이 지난 섹션만 골라준다 — "전체 새로고침"을 눌러도 아직 신선한 섹션까지
// 다시 AI를 호출하지 않기 위함(기업 리서치는 비용이 드는 작업이라 점층적으로만 채운다).
// force=true면 TTL을 무시하고 요청한 섹션을 전부 돌려준다 — 개별 섹션 새로고침(↻)처럼
// 사용자가 명시적으로 "이거 하나는 지금 당장 다시 해줘"라고 누른 경우를 위한 탈출구.
// force 없이는 이미 최신인 섹션에 대해 새로고침이 조용히 아무 일도 안 하는 게 혼란스럽다는
// 피드백을 받고 추가했다.
export function listStaleSections(
  normalizedName: string,
  requested?: CompanySectionType[],
  force = false
): CompanySectionType[] {
  const candidates = requested ?? [...COMPANY_SECTION_TYPES];
  if (force) return candidates;
  const existing = new Map(getCompanySections(normalizedName).map((s) => [s.sectionType, s]));
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

// 감사인이 기업 실사하듯 조사하는 게 목적이므로, 검색 스니펫만 보고 짧게 쓰는 걸 막는다 —
// 최소 소스 개수·분량을 명시하고 WebFetch로 실제 본문을 읽게 강제한다.
const WEB_RESEARCH_INSTRUCTION = `조사 방법:
1. 먼저 WebSearch로 여러 각도(공식 발표, 뉴스, 채용/평판 사이트, 업계 분석 등)에서 검색해.
2. 검색 결과에서 신뢰할 만한 링크를 최소 3개 이상 WebFetch로 직접 열어서 본문을 읽어.
   검색 결과 스니펫만 보고 답을 쓰지 마 — 반드시 실제 페이지 내용을 확인해.
3. 한 번의 검색으로 부족하면 추가 검색어를 바꿔가며 더 찾아봐 (인물명, 사업부문명, 최근 연도 등 구체적 키워드로).

출력 형식:
- 최소 1000자 이상, 여러 문단으로. 뭉뚱그린 일반론이 아니라 구체적 사실·수치·연도·인물명·사업부문명을 실제로 인용해.
- 정보가 상충하면 어느 쪽이 더 최신/신뢰할 만한지 판단해서 쓰고, 불확실하면 불확실하다고 명시해.
- 확인 안 된 내용은 지어내지 마. 검색해도 안 나오는 부분은 "확인되지 않음"이라고 써.
- 마지막에 "출처:" 줄 아래 실제로 열어본 링크를 마크다운 형식으로 전부 나열해 (예: [기사 제목](https://...)).`;

async function runWebSearchSection(prompt: string): Promise<SectionResult> {
  let resultText = "";
  try {
    for await (const message of query({
      prompt,
      options: {
        model: RESEARCH_MODEL,
        maxTurns: 25,
        allowedTools: ["WebSearch", "WebFetch"],
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

// DART 등으로 이미 확보한 정확한 데이터를 프롬프트에 심어주고, 그 위에 웹 검색/조회로
// 맥락(업계 내 위치, 경영진 배경, 최근 평가 등)을 더해 해석까지 하게 한다. maxTurns를 낮게
// 잡았다가(15) 실제로 턴 초과 에러가 나는 걸 확인해서 순수 WebSearch 섹션과 동일하게 맞춤 —
// WebFetch로 본문을 읽는 리서치는 예상보다 턴을 많이 먹는다.
async function runGroundedResearchSection(prompt: string): Promise<SectionResult> {
  let resultText = "";
  try {
    for await (const message of query({
      prompt,
      options: {
        model: RESEARCH_MODEL,
        maxTurns: 25,
        allowedTools: ["WebSearch", "WebFetch"],
      },
    })) {
      if ("result" in message) resultText = message.result;
    }
  } catch (e) {
    console.error("[company-research] 데이터 기반 리서치 섹션 호출 실패:", e);
    return { content: "", sources: [], status: "failed" };
  }
  const content = resultText.trim();
  return { content, sources: extractSources(content), status: content ? "ok" : "failed" };
}

async function researchOverview(displayName: string): Promise<SectionResult> {
  const prompt = `당신은 "${displayName}"(한국 금융투자협회 소속 회원사 — 증권/자산운용/금융투자 등)에 지원하는 사람을 도와, 기업 실사(due diligence)하듯 깊이 있게 조사하는 애널리스트입니다. 이 회사를 잘 모른다는 인상을 절대 주면 안 되는 상황이라 생각하고 아래를 전부 다뤄:

- 연혁: 설립연도, 주요 연혁(사명 변경, 인수합병, 대주주 변경 등), 소속 그룹/계열이 있다면 그룹 내 위치와 역할
- 주력 사업: 사업부문별로 구체적으로 무엇을 하는지, 각 부문의 비중이나 규모(가능하면 AUM/자산규모/매출 비중 등 수치)
- 시장 지위: 업계 내 순위나 규모, 경쟁사 대비 강점·차별점, 최근 3-5년간의 성장/축소 흐름
- 조직: 대략적인 조직구조(본부/부문 구성), 임직원 규모
- 왜 사람을 뽑는가: 이 회사가 최근 어떤 방향으로 사업을 확장/전환하고 있고, 그것이 채용과 어떻게 연결될 수 있는지 추정

${WEB_RESEARCH_INSTRUCTION}`;
  return runWebSearchSection(prompt);
}

async function researchCulture(displayName: string): Promise<SectionResult> {
  const prompt = `당신은 "${displayName}"에 지원하는 사람을 돕는 애널리스트입니다. 이 회사의 인재상과 조직문화를 기업 실사하듯 깊이 있게 조사해:

- 공식 인재상: 회사가 공식적으로 내세우는 핵심가치/인재상 키워드와 그 구체적 의미
- 채용 시 강조 역량: 채용공고, 인터뷰 기사, 공식 채용 페이지에서 반복적으로 강조되는 자격/역량/태도
- 실제 조직문화: 가능하면 재직자 리뷰(잡플래닛 등 검색 결과에 노출되는 내용), 인터뷰, 사내 행사 관련 기사 등으로 실제 분위기(수평적/위계적, 워라밸, 복지, 재택 등) 파악
- 채용 프로세스: 알려진 전형 단계, 면접에서 자주 나오는 질문이나 평가 포인트(찾을 수 있는 만큼)
- 최근 채용 방향: 최근 어떤 직무/분야를 확대 채용하고 있는지, 그게 회사의 사업 방향과 어떻게 연결되는지

${WEB_RESEARCH_INSTRUCTION}`;
  return runWebSearchSection(prompt);
}

async function researchNews(displayName: string): Promise<SectionResult> {
  const prompt = `당신은 "${displayName}"에 지원하는 사람을 돕는 애널리스트입니다. 최근 1년 이내를 중심으로(중요한 건 더 이전 것도 포함) 이 회사의 행보를 기업 실사하듯 깊이 있게 조사해:

- 사업 행보: 신사업 진출, 조직개편, 주요 상품/서비스 출시, 파트너십, M&A 등
- 경영/지배구조 변화: 대표이사·주요 임원 교체, 대주주 변경, 지분 구조 변화
- 업계 내 이슈: 규제/제재/감독당국 관련 이슈가 있었다면 무엇이고 어떻게 해결됐는지(지원자가 반드시 알아야 할 리스크 요인)
- 평판/화제: 언론에 노출된 논란이나 화제(호재·악재 모두), 업계 내 평가
- 향후 전망: 회사가 공개적으로 밝힌 향후 계획이나 전략 방향

지원자 입장에서 면접·자소서에서 언급하면 좋을 구체적 사실 위주로, 날짜와 함께 정리해.

${WEB_RESEARCH_INSTRUCTION}`;
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
  const prompt = `당신은 "${displayName}"에 지원하는 사람을 돕는 애널리스트입니다. 아래는 DART 공시 재무 데이터(${financials.bsnsYear}년, ${
    financials.fsDiv === "CFS" ? "연결" : "별도"
  }재무제표, 단위: 원)입니다 — 이 수치 자체는 정확하니 그대로 인용하고 지어내지 마세요:
${financials.figures.map((f) => `- ${f.label}: ${f.thisYearAmount} (전년: ${f.lastYearAmount})`).join("\n")}

이 수치를 억원 단위로 환산해 정리한 뒤, 웹 검색/조회로 아래를 보완해 재무상태에 대한 실질적 분석을 작성해줘 (단순 수치 나열이 아니라 해석):
- 전년 대비 증감의 배경(실적 관련 뉴스나 공시가 있다면)
- 업계/경쟁사 대비 이 회사의 규모나 재무 건전성이 어느 정도 수준인지
- 재무구조에서 주목할 만한 특징이나 리스크 요인(부채비율, 특이 항목 등)

${WEB_RESEARCH_INSTRUCTION}`;
  const result = await runGroundedResearchSection(prompt);
  const sourceUrl = financials.sourceRceptNo
    ? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${financials.sourceRceptNo}`
    : "https://dart.fss.or.kr";
  return {
    ...result,
    content: result.content || "재무 데이터를 분석하지 못했습니다.",
    contentJson: financials,
    sources: [{ title: "DART 전자공시시스템", url: sourceUrl }, ...result.sources],
    status: result.content ? "ok" : "partial",
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
  const prompt = `당신은 "${displayName}"에 지원하는 사람을 돕는 애널리스트입니다. 아래는 DART 공시 기준 경영진 정보입니다 — 이 정보 자체는 정확하니 그대로 인용하고 지어내지 마세요:
대표이사: ${overview?.ceoName || "정보 없음"}
설립일: ${overview?.establishedDate || "정보 없음"}
임원 현황:
${executives.map((e) => `- ${e.name} (${e.position}, 재임: ${e.tenurePeriod})`).join("\n") || "정보 없음"}

웹 검색으로 아래를 보완해 경영진 구성과 지배구조에 대한 실질적 분석을 작성해줘:
- 대표이사 및 주요 임원의 경력/배경(찾을 수 있는 범위에서 — 이전 경력, 업계 평판)
- 지배구조 특징(대주주/모회사가 있다면 그 관계, 최근 경영진 교체가 있었다면 그 배경)
- 이 조직구조가 지원자에게 시사하는 점(의사결정 구조, 조직 안정성 등)

${WEB_RESEARCH_INSTRUCTION}`;
  const result = await runGroundedResearchSection(prompt);
  return {
    ...result,
    content: result.content || "경영진 정보를 분석하지 못했습니다.",
    contentJson: { overview, executives },
    sources: [
      { title: "DART 전자공시시스템 - 임원현황", url: "https://dart.fss.or.kr" },
      ...result.sources,
    ],
    status: result.content ? "ok" : "partial",
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
