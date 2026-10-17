// OpenDART(전자공시시스템 Open API) 클라이언트. KOFIA 공고에는 재무정보가 전혀 없어서
// (lib/crawler.ts 참고) 기업 재무상태 리서치는 이 API가 사실상 유일한 무료 구조화 소스다.
// 회사명 검색 API가 없어 전체 법인 코드 목록(corpCode.xml)을 받아 로컬에서 매칭해야 한다.
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import * as cheerio from "cheerio";
import { normalizeCompanyName } from "./company-normalize";
import { DART_CORP_CODE_REFRESH_DAYS } from "./config";

const DATA_DIR = join(process.cwd(), "data");
const CORP_CODE_CACHE_PATH = join(DATA_DIR, "dart-corpcodes.json");
const CORP_CODE_ZIP_PATH = join(DATA_DIR, "dart-corpcode.zip");

mkdirSync(DATA_DIR, { recursive: true });

function apiKey(): string | undefined {
  return process.env.DART_API_KEY;
}

export function isDartConfigured(): boolean {
  return !!apiKey();
}

interface DartCorpEntry {
  corpCode: string;
  corpName: string;
  normalizedName: string;
  stockCode: string;
}

interface CorpCodeCache {
  fetchedAt: number;
  entries: DartCorpEntry[];
}

function readCorpCodeCache(): CorpCodeCache | null {
  if (!existsSync(CORP_CODE_CACHE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CORP_CODE_CACHE_PATH, "utf-8")) as CorpCodeCache;
  } catch {
    return null;
  }
}

async function downloadCorpCodeIndex(): Promise<DartCorpEntry[]> {
  const key = apiKey();
  if (!key) return [];

  const res = await fetch(`https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${key}`);
  if (!res.ok) throw new Error(`DART corpCode.xml 요청 실패: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(CORP_CODE_ZIP_PATH, buf);

  // 전용 XML 파서를 새로 추가하는 대신, 이미 있는 cheerio를 xmlMode로 재사용한다.
  // ZIP 압축 해제는 npm 의존성 대신 시스템 unzip을 사용(이 앱은 로컬 개인용 도구로만
  // 동작하는 걸 전제하므로 macOS/Linux 기본 유틸리티에 의존해도 무리가 없다).
  const xml = execFileSync("unzip", ["-p", CORP_CODE_ZIP_PATH, "CORPCODE.xml"], {
    maxBuffer: 1024 * 1024 * 128,
  }).toString("utf-8");
  unlinkSync(CORP_CODE_ZIP_PATH);

  const $ = cheerio.load(xml, { xmlMode: true });
  const entries: DartCorpEntry[] = [];
  $("list").each((_, el) => {
    const corpCode = $(el).find("corp_code").text().trim();
    const corpName = $(el).find("corp_name").text().trim();
    const stockCode = $(el).find("stock_code").text().trim();
    if (!corpCode || !corpName) return;
    entries.push({
      corpCode,
      corpName,
      normalizedName: normalizeCompanyName(corpName),
      stockCode,
    });
  });
  return entries;
}

async function ensureCorpCodeIndex(): Promise<DartCorpEntry[]> {
  const cached = readCorpCodeCache();
  const maxAgeMs = DART_CORP_CODE_REFRESH_DAYS * 24 * 60 * 60 * 1000;
  if (cached && Date.now() - cached.fetchedAt < maxAgeMs) {
    return cached.entries;
  }

  try {
    const entries = await downloadCorpCodeIndex();
    if (entries.length === 0) return cached?.entries ?? [];
    writeFileSync(
      CORP_CODE_CACHE_PATH,
      JSON.stringify({ fetchedAt: Date.now(), entries })
    );
    return entries;
  } catch (e) {
    console.error("[dart] corpCode 인덱스 갱신 실패, 캐시 재사용:", e);
    return cached?.entries ?? [];
  }
}

export interface CorpCodeMatch {
  corpCode: string;
  corpName: string;
  confidence: "exact" | "fuzzy";
}

// 영문 약어 상호는 DART와 KOFIA 공고가 서로 다르게 적는 경우가 많다(DS투자증권 ↔ 디에스투자증권, 케이비자산운용 ↔ KB자산운용).
const LETTER_NAMES: Record<string, string> = {
  A: "에이", B: "비", C: "씨", D: "디", E: "이", F: "에프", G: "지", H: "에이치", I: "아이", J: "제이", K: "케이", L: "엘", M: "엠",
  N: "엔", O: "오", P: "피", Q: "큐", R: "알", S: "에스", T: "티", U: "유", V: "브이", W: "더블유", X: "엑스", Y: "와이", Z: "제트",
};
export function hangulizeLatin(name: string): string {
  return name.replace(/[A-Za-z]+/g, (word) => [...word.toUpperCase()].map((c) => LETTER_NAMES[c] ?? c).join(""));
}

// 같은 정규화 이름(그다음 영문 약어를 한글로 바꾼 이름)이 있으면 exact. 없으면 DART 상호가 이 이름을 품고 길이가 거의 같은
// 항목(예: 앞에 "한국"이 붙은 상호)을 fuzzy로 돌려준다 — fuzzy는 다른 회사일 수 있어 리서치는 쓰지 않는다.
// 예전에는 반대 방향(이 이름 안에 DART 상호가 들어 있음)도 받아, "DS투자증권"이 한 글자 상호 "자"(대표 이춘모)에,
// "금융투자협회"가 "융"에 묶였고 지배구조 분석이 그 대표이사를 공시 사실로 썼다.
const FUZZY_EXTRA_CHARS = 4;
const FUZZY_MIN_SHARE = 0.6;
export async function findCorpCode(rawName: string): Promise<CorpCodeMatch | null> {
  if (!isDartConfigured()) return null;
  const target = normalizeCompanyName(rawName);
  if (!target) return null;

  const entries = await ensureCorpCodeIndex();
  // 양쪽 모두 영문을 한글로 바꿔 비교한다: KOFIA "케이비자산운용" ↔ DART "KB자산운용", KOFIA "DS투자증권" ↔ DART "디에스투자증권".
  const hangul = hangulizeLatin(target);
  const exact = entries.find((e) => e.normalizedName === target) ?? entries.find((e) => hangulizeLatin(e.normalizedName) === hangul);
  if (exact) return { corpCode: exact.corpCode, corpName: exact.corpName, confidence: "exact" };
  const candidates = entries.filter((e) => e.normalizedName.includes(target)
    && e.normalizedName.length - target.length <= FUZZY_EXTRA_CHARS && target.length >= e.normalizedName.length * FUZZY_MIN_SHARE);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.normalizedName.length - b.normalizedName.length);
  const best = candidates[0];
  return { corpCode: best.corpCode, corpName: best.corpName, confidence: "fuzzy" };
}

export interface DartCompanyOverview {
  ceoName: string;
  address: string;
  homepageUrl: string;
  establishedDate: string;
  industryCode: string;
}

export async function fetchCompanyOverview(
  corpCode: string
): Promise<DartCompanyOverview | null> {
  const key = apiKey();
  if (!key) return null;
  try {
    const res = await fetch(
      `https://opendart.fss.or.kr/api/company.json?crtfc_key=${key}&corp_code=${corpCode}`
    );
    const data = await res.json();
    if (data.status !== "000") return null;
    return {
      ceoName: data.ceo_nm || "",
      address: data.adres || "",
      homepageUrl: data.hm_url || "",
      establishedDate: data.est_dt || "",
      industryCode: data.induty_code || "",
    };
  } catch (e) {
    console.error("[dart] company.json 조회 실패:", e);
    return null;
  }
}

// 손익/재무상태표에서 서술형 요약에 쓸만한 핵심 계정만 추린다. 계정명 국문 표기가
// 기업마다 조금씩 다를 수 있어 account_id(IFRS 표준 코드)를 우선 매칭하고, 없으면
// account_nm 부분일치로 보완한다.
const KEY_ACCOUNTS: { id: string; nameHints: string[]; label: string }[] = [
  { id: "ifrs-full_Assets", nameHints: ["자산총계"], label: "자산총계" },
  { id: "ifrs-full_Liabilities", nameHints: ["부채총계"], label: "부채총계" },
  { id: "ifrs-full_Equity", nameHints: ["자본총계"], label: "자본총계" },
  { id: "ifrs-full_Revenue", nameHints: ["영업수익", "매출액"], label: "영업수익" },
  {
    id: "ifrs-full_ProfitLossFromOperatingActivities",
    nameHints: ["영업이익"],
    label: "영업이익",
  },
  { id: "ifrs-full_ProfitLoss", nameHints: ["당기순이익"], label: "당기순이익" },
];

export interface DartFinancialFigure {
  label: string;
  thisYearAmount: string;
  lastYearAmount: string;
  unit: string;
}

export interface DartFinancials {
  bsnsYear: string;
  fsDiv: "CFS" | "OFS";
  figures: DartFinancialFigure[];
  sourceRceptNo: string;
}

async function fetchFinancialStatements(
  corpCode: string,
  bsnsYear: string,
  fsDiv: "CFS" | "OFS"
): Promise<Record<string, unknown>[]> {
  const key = apiKey();
  if (!key) return [];
  const res = await fetch(
    `https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json?crtfc_key=${key}&corp_code=${corpCode}&bsns_year=${bsnsYear}&reprt_code=11011&fs_div=${fsDiv}`
  );
  const data = await res.json();
  if (data.status !== "000" || !Array.isArray(data.list)) return [];
  return data.list;
}

// bsns_year 미지정 시 직전 사업연도(사업보고서가 확실히 공시됐을 연도)를 기본값으로 쓴다.
export async function fetchKeyFinancials(
  corpCode: string,
  bsnsYear?: string
): Promise<DartFinancials | null> {
  if (!isDartConfigured()) return null;
  const year = bsnsYear || String(new Date().getFullYear() - 1);

  try {
    let list = await fetchFinancialStatements(corpCode, year, "CFS");
    let fsDiv: "CFS" | "OFS" = "CFS";
    if (list.length === 0) {
      list = await fetchFinancialStatements(corpCode, year, "OFS");
      fsDiv = "OFS";
    }
    if (list.length === 0) return null;

    const figures: DartFinancialFigure[] = [];
    for (const account of KEY_ACCOUNTS) {
      // account_id(IFRS 표준 코드) 매칭을 최우선으로 하고, 그걸로 못 찾을 때만 계정명
      // "완전 일치"로 보완한다. 부분 일치(includes)를 쓰면 "부채총계"가 "자본과부채총계"
      // (자본+부채 합계 — 자산총계와 같은 값) 같은 다른 계정을 잘못 집어올 수 있어서 위험하다.
      const row =
        list.find((r) => r.account_id === account.id) ??
        list.find((r) => account.nameHints.includes(String(r.account_nm ?? "").trim()));
      if (!row) continue;
      figures.push({
        label: account.label,
        thisYearAmount: String(row.thstrm_amount ?? ""),
        lastYearAmount: String(row.frmtrm_amount ?? ""),
        unit: String(row.currency ?? "KRW"),
      });
    }
    if (figures.length === 0) return null;

    return {
      bsnsYear: year,
      fsDiv,
      figures,
      sourceRceptNo: String(list[0]?.rcept_no ?? ""),
    };
  } catch (e) {
    console.error("[dart] 재무제표 조회 실패:", e);
    return null;
  }
}

export interface DartExecutive {
  name: string;
  position: string;
  career: string;
  tenurePeriod: string;
}

export async function fetchExecutives(
  corpCode: string,
  bsnsYear?: string
): Promise<DartExecutive[]> {
  const key = apiKey();
  if (!key) return [];
  const year = bsnsYear || String(new Date().getFullYear() - 1);
  try {
    const res = await fetch(
      `https://opendart.fss.or.kr/api/exctvSttus.json?crtfc_key=${key}&corp_code=${corpCode}&bsns_year=${year}&reprt_code=11011`
    );
    const data = await res.json();
    if (data.status !== "000" || !Array.isArray(data.list)) return [];
    return data.list.slice(0, 15).map((r: Record<string, unknown>) => ({
      name: String(r.nm ?? ""),
      position: String(r.ofcps ?? ""),
      career: String(r.main_career ?? "").slice(0, 200),
      tenurePeriod: String(r.hffc_pd ?? ""),
    }));
  } catch (e) {
    console.error("[dart] 임원현황 조회 실패:", e);
    return [];
  }
}
