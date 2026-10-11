import * as cheerio from "cheerio";

// 회사 리서치의 1차 근거인 회사 홈페이지를 서버에서 직접 읽는다. 모델의 WebFetch만 믿었더니 홈페이지를 열지 못한 채
// 검색 결과로 사업을 추정해, IPO 전문 운용사를 "국내 주식 롱쇼트 운용사"로 잘못 쓰고 다른 공고의 문구까지 섞인 일이 있었다.
// KOFIA 공고의 "사이트바로가기"(jobs.siteUrl)가 홈페이지 주소다. AI 호출 없음.

export const HOMEPAGE_UNVERIFIED = "※ 회사 홈페이지를 확인하지 못했습니다";
const TEXT_LIMIT = 6000;
const MIN_TEXT = 200;
const MAX_BYTES = 2_000_000;
const CACHE_MS = 10 * 60 * 1000;

export type HomepageResult =
  | { status: "ok"; url: string; title: string; text: string }
  | { status: "unavailable"; url: string; reason: string };

// 채용 대행·채용 게시판 주소는 회사 홈페이지가 아니다.
const JOB_BOARD_HOST = /(?:^|\.)(?:greetinghr\.com|recruiter\.co\.kr|saramin\.co\.kr|jobkorea\.co\.kr|incruit\.com|wanted\.co\.kr|ninehire\.com|career\.co\.kr|jobplanet\.co\.kr|catch\.co\.kr|kofia\.or\.kr|forms\.gle|google\.com|naver\.com|notion\.site)$/i;

// 공고 데이터에서 온 주소라도 내부망·로컬 주소로는 요청하지 않는다.
export function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host.includes(".") || host === "localhost" || /\.(?:local|localhost|internal|lan|home|test)$/.test(host)) return false;
  if (host.includes(":")) return false; // IPv6 리터럴
  const ip = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ip) return true;
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
}

// 최신 공고 순으로 받은 주소 중 홈페이지로 쓸 첫 주소의 첫 화면(origin)을 고른다.
export function pickHomepageUrl(urls: string[]): string | null {
  for (const raw of urls) {
    try {
      const url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
      if ((url.protocol === "https:" || url.protocol === "http:") && isPublicHost(url.hostname) && !JOB_BOARD_HOST.test(url.hostname))
        return `${url.origin}/`;
    } catch { /* 주소 형식이 아니면 다음 후보 */ }
  }
  return null;
}

export function extractHomepageText(html: string): { title: string; text: string } {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe, template").remove();
  const title = $("title").first().text().replace(/\s+/g, " ").trim();
  const description = $('meta[name="description"]').attr("content")?.trim() ?? "";
  const body = $("body").text().replace(/\s+/g, " ").trim();
  return { title, text: [description, body].filter(Boolean).join("\n").slice(0, TEXT_LIMIT) };
}

// 국내 홈페이지에는 EUC-KR이 아직 많아, 헤더나 meta의 charset으로 디코딩한다.
function decode(bytes: ArrayBuffer, contentType: string): string {
  const head = new TextDecoder("latin1").decode(bytes.slice(0, 4096));
  const charset = (contentType.match(/charset=([\w-]+)/i)?.[1] ?? head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ?? "utf-8").toLowerCase();
  try { return new TextDecoder(charset).decode(bytes); }
  catch { return new TextDecoder("utf-8").decode(bytes); }
}

async function fetchOnce(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<HomepageResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { redirect: "follow", signal: controller.signal, headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml", "Accept-Language": "ko-KR,ko;q=0.9",
    } });
    if (res.url && !isPublicHost(new URL(res.url).hostname)) return { status: "unavailable", url, reason: "내부 주소로 이동하는 페이지" };
    if (!res.ok) return { status: "unavailable", url, reason: `HTTP ${res.status}` };
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType && !/html/i.test(contentType)) return { status: "unavailable", url, reason: "HTML 페이지가 아님" };
    const bytes = await res.arrayBuffer();
    const { title, text } = extractHomepageText(decode(bytes.slice(0, MAX_BYTES), contentType));
    if (text.length < MIN_TEXT) return { status: "unavailable", url, reason: "본문이 거의 없음(스크립트로 그리는 페이지일 수 있음)" };
    return { status: "ok", url: res.url || url, title, text };
  } catch (error) {
    return { status: "unavailable", url, reason: controller.signal.aborted ? "응답 시간 초과" : error instanceof Error ? error.message : "요청 실패" };
  } finally { clearTimeout(timer); }
}

const cache = new Map<string, { at: number; result: HomepageResult }>();

// 개요·인재상 섹션이 연달아 같은 홈페이지를 쓰므로 잠시 재사용한다. https가 안 되면 http로 한 번 더 시도한다.
export async function fetchHomepage(url: string, { fetchImpl = fetch, timeoutMs = 15_000 }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<HomepageResult> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  let result = await fetchOnce(url, fetchImpl, timeoutMs);
  if (result.status !== "ok" && url.startsWith("https://")) {
    const fallback = await fetchOnce(url.replace(/^https:/, "http:"), fetchImpl, timeoutMs);
    if (fallback.status === "ok") result = fallback;
  }
  cache.set(url, { at: Date.now(), result });
  return result;
}
