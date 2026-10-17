import * as cheerio from "cheerio";
import type { InputImage } from "./codex-ai";

// 회사 리서치의 1차 근거인 회사 홈페이지를 서버에서 직접 읽는다. 모델의 WebFetch만 믿었더니 홈페이지를 열지 못한 채
// 검색 결과로 사업을 추정해, IPO 전문 운용사를 "국내 주식 롱쇼트 운용사"로 잘못 쓰고 다른 공고의 문구까지 섞인 일이 있었다.
// 주소 후보는 KOFIA 공고의 "사이트바로가기"(jobs.siteUrl), DART 기업개황의 홈페이지, 공고에 적힌 지원 이메일의 도메인 순이다.
// 첫 화면은 대개 메뉴와 최근 게시물뿐이라(흥국증권: 프레임셋 → /index.do, 회사개요·CEO·경영정보는 하위 페이지), 프레임·
// 리다이렉트를 따라가고 회사개요·사업영역 같은 하위 페이지 몇 개를 함께 읽는다. 하위 페이지 본문이 이미지로만 된 경우
// (한국자산평가 인재상·미션·핵심가치: alt는 "한국자산평가 인재상"뿐)를 위해 본문 이미지도 내려받아 둔다 — 글자는
// lib/homepage-image-text.ts가 읽는다. 이 파일은 AI 호출 없음.

export const HOMEPAGE_UNVERIFIED = "※ 회사 홈페이지를 확인하지 못했습니다";
const ROOT_TEXT_LIMIT = 2500;
const SUBPAGE_TEXT_LIMIT = 1800;
const MAX_SUBPAGES = 4;
const MAX_REDIRECTS = 2;
const MAX_CANDIDATES = 3;
const MIN_TEXT = 200;
const MAX_BYTES = 2_000_000;
const CACHE_MS = 10 * 60 * 1000;
const MAX_IMAGES = 6;
const MAX_IMAGE_CANDIDATES = 10;
const MAX_IMAGES_PER_PAGE = 3;
// 아이콘·글머리표·구분선은 수 KB다. 모델 입력 한도(장당 5MB, 한 변 8000px) 안에서만 보낸다.
const MIN_IMAGE_BYTES = 6_000;
const MAX_IMAGE_BYTES = 4_500_000;
const MIN_IMAGE_SIDE = 120;
const MAX_IMAGE_SIDE = 8000;
const ALT_IS_TEXT = 80;

export interface HomepagePage { title: string; url: string }
// 하위 페이지 본문에 든 이미지. data는 base64.
export interface HomepageImage { page: string; pageUrl: string; url: string; alt: string; mediaType: InputImage["mediaType"]; data: string }
export type HomepageResult =
  | { status: "ok"; url: string; title: string; text: string; pages: HomepagePage[]; images: HomepageImage[] }
  | { status: "unavailable"; url: string; reason: string };

// 채용 대행·채용 게시판 주소는 회사 홈페이지가 아니다.
const JOB_BOARD_HOST = /(?:^|\.)(?:greetinghr\.com|recruiter\.co\.kr|saramin\.co\.kr|jobkorea\.co\.kr|incruit\.com|wanted\.co\.kr|ninehire\.com|career\.co\.kr|jobplanet\.co\.kr|catch\.co\.kr|kofia\.or\.kr|forms\.gle|google\.com|naver\.com|notion\.site)$/i;
// 지원 이메일이 개인 메일이면 회사 도메인이 아니다.
const PUBLIC_MAIL = /^(?:gmail\.com|naver\.com|daum\.net|hanmail\.net|nate\.com|kakao\.com|hotmail\.com|outlook\.com|live\.com|yahoo\.com|yahoo\.co\.kr|icloud\.com|me\.com|korea\.com|empas\.com|dreamwiz\.com|paran\.com|chol\.com|kofia\.or\.kr)$/i;

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

// 받은 주소들 중 홈페이지로 쓸 수 있는 것의 첫 화면(origin)을, 순서를 지키며 중복 없이 고른다.
export function homepageCandidates(urls: string[]): string[] {
  const result: string[] = [];
  for (const raw of urls) {
    try {
      const url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
      if ((url.protocol === "https:" || url.protocol === "http:") && isPublicHost(url.hostname) && !JOB_BOARD_HOST.test(url.hostname)) {
        const origin = `${url.origin}/`;
        if (!result.includes(origin)) result.push(origin);
      }
    } catch { /* 주소 형식이 아니면 다음 후보 */ }
  }
  return result;
}

// 공고 본문의 지원 이메일 도메인(가장 많이 나온 순). 개인 메일 도메인은 뺀다. 예: kej1205@heungkuksec.co.kr → www.heungkuksec.co.kr
export function emailDomainUrls(texts: string[]): string[] {
  const counts = new Map<string, number>();
  for (const text of texts)
    for (const m of text.matchAll(/[\w.+-]+@((?:[\w-]+\.)+[a-z]{2,})/gi)) {
      const domain = m[1].toLowerCase().replace(/^(?:mail|email|recruit|hr)\./, "");
      if (!PUBLIC_MAIL.test(domain)) counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
  return [...counts].sort((a, b) => b[1] - a[1])
    .flatMap(([domain]) => domain.startsWith("www.") ? [`https://${domain}/`] : [`https://www.${domain}/`, `https://${domain}/`]);
}

// 사이트 공통 머리·메뉴·바닥 영역. 하위 페이지마다 반복돼 글자 수만 차지하므로 하위 페이지에서는 지운다.
// 첫 화면은 바닥에 주소·연락처가 있어 그대로 둔다.
const CHROME = "header, nav, footer, [id*=gnb], [class*=gnb], [id*=lnb], [class*=lnb], [id*=snb], [class*=snb], [id*=header], [class*=header], [id*=footer], [class*=footer], [id*=sidebar], [class*=sidebar], [class*=sitemap], [id*=quick], [class*=quick], [id*=skip], [class*=skip], [id*=top_menu], [class*=top_menu], [class*=breadcrumb], [class*=location]";

export function extractHomepageText(html: string, { stripChrome = false, limit = ROOT_TEXT_LIMIT } = {}): { title: string; text: string } {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe, template").remove();
  if (stripChrome) $(CHROME).remove();
  // 오래된 국내 홈페이지는 회사개요·경영이념 같은 본문을 이미지로 넣고 alt에 문장을 적는다(흥국증권 회사개요).
  $("img[alt]").each((_, el) => {
    const alt = ($(el).attr("alt") ?? "").replace(/\s+/g, " ").trim();
    $(el).replaceWith(alt.length >= 8 ? ` ${alt} ` : "");
  });
  const title = $("title").first().text().replace(/\s+/g, " ").trim();
  const description = $('meta[name="description"]').attr("content")?.trim() ?? "";
  const body = $("body").text().replace(/\s+/g, " ").trim();
  return { title, text: [description, body].filter(Boolean).join("\n").slice(0, limit) };
}

// 프레임셋·meta refresh·스크립트 이동으로 실제 첫 화면이 다른 주소에 있는 경우 그 주소.
export function redirectTarget(html: string, base: string): string | null {
  const $ = cheerio.load(html);
  const frame = $("frame[src], iframe[src]").toArray().map((el) => $(el).attr("src")?.trim()).find((src) => src && !/^(?:about:|javascript:)/i.test(src));
  const refresh = $('meta[http-equiv="refresh" i]').attr("content")?.match(/url\s*=\s*['"]?([^'";]+)/i)?.[1];
  const script = html.match(/location(?:\.href)?\s*=\s*['"]([^'"]+)['"]|location\.replace\(\s*['"]([^'"]+)['"]/);
  const target = frame || refresh || script?.[1] || script?.[2];
  if (!target) return null;
  try { return new URL(target, base).toString(); } catch { return null; }
}

// 회사 정보가 있는 하위 페이지 링크. 앞쪽 키워드가 우선이며, 같은 사이트 주소만 고른다.
const SUBPAGE_KEYWORDS = [/회사\s?개요|기업\s?개요/, /사업\s?(?:영역|소개|분야)/, /연혁/, /CEO|대표이사|인사말/, /인재상|핵심\s?가치|비전/, /경영\s?(?:정보|공시)/, /조직도/, /회사\s?소개/];
const sameSite = (a: URL, b: URL) => a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "");
export function subpageLinks(html: string, base: string): HomepagePage[] {
  const $ = cheerio.load(html);
  const baseUrl = new URL(base);
  const found: { rank: number; title: string; url: string }[] = [];
  $("a[href]").each((_, el) => {
    const title = $(el).text().replace(/\s+/g, " ").trim();
    const href = $(el).attr("href") ?? "";
    if (!title || title.length > 20 || /^(?:#|javascript:|mailto:|tel:)/i.test(href)) return;
    const rank = SUBPAGE_KEYWORDS.findIndex((re) => re.test(title));
    if (rank < 0) return;
    try {
      const url = new URL(href, base);
      url.hash = "";
      if (sameSite(url, baseUrl) && url.toString() !== base && !found.some((f) => f.url === url.toString())) found.push({ rank, title, url: url.toString() });
    } catch { /* 잘못된 링크 */ }
  });
  return found.sort((a, b) => a.rank - b.rank).slice(0, MAX_SUBPAGES).map(({ title, url }) => ({ title, url }));
}

// 하위 페이지 본문(머리·메뉴·바닥 제외)의 이미지 후보. 파일 이름이나 크기 속성으로 장식임이 드러나는 것은 뺀다.
const DECORATION = /(?:logo|icon|ico_|btn|button|bullet|arrow|blank|spacer|^dot|line|bar_|tab_|bg_|sns|quick|loading|top_|_top\.)/i;
export function contentImages(html: string, base: string): { url: string; alt: string }[] {
  const $ = cheerio.load(html);
  $(CHROME).remove();
  const found: { url: string; alt: string }[] = [];
  $("img[src]").each((_, el) => {
    const src = $(el).attr("src")?.trim() ?? "";
    const file = src.split(/[?#]/)[0].split("/").pop() ?? "";
    if (!src || /^data:/i.test(src) || /\.svg$/i.test(file) || DECORATION.test(file)) return;
    const width = Number($(el).attr("width")), height = Number($(el).attr("height"));
    if ((width && width < MIN_IMAGE_SIDE) || (height && height < 40)) return;
    try {
      const url = new URL(src, base);
      url.hash = "";
      const alt = ($(el).attr("alt") ?? "").replace(/\s+/g, " ").trim();
      // alt에 문장이 다 적힌 이미지(흥국증권 CEO 인사말)는 본문 텍스트로 이미 읽었다.
      if (alt.length < ALT_IS_TEXT && (url.protocol === "https:" || url.protocol === "http:") && isPublicHost(url.hostname) && !found.some((f) => f.url === url.toString()))
        found.push({ url: url.toString(), alt });
    } catch { /* 잘못된 주소 */ }
  });
  return found;
}

// 파일 앞부분으로 형식과 가로·세로를 읽는다(헤더의 content-type은 틀린 경우가 있다). WebP는 크기를 읽지 않는다.
export function sniffImage(bytes: Uint8Array): { mediaType: InputImage["mediaType"]; width?: number; height?: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return { mediaType: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
    return { mediaType: "image/gif", width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (bytes.length > 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP")
    return { mediaType: "image/webp" };
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let i = 2; i + 9 < bytes.length;) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { mediaType: "image/jpeg", height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; }
      i += 2 + view.getUint16(i + 2);
    }
    return { mediaType: "image/jpeg" };
  }
  return null;
}

async function fetchImage(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<InputImage | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { redirect: "follow", signal: controller.signal, headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept": "image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.5",
    } });
    if (!res.ok || (res.url && !isPublicHost(new URL(res.url).hostname))) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length < MIN_IMAGE_BYTES || bytes.length > MAX_IMAGE_BYTES) return null;
    const image = sniffImage(bytes);
    if (!image) return null;
    const { width, height } = image;
    if (width !== undefined && height !== undefined && (Math.min(width, height) < 40 || Math.max(width, height) < MIN_IMAGE_SIDE || Math.max(width, height) > MAX_IMAGE_SIDE)) return null;
    return { mediaType: image.mediaType, data: Buffer.from(bytes).toString("base64") };
  } catch { return null; }
  finally { clearTimeout(timer); }
}

// 하위 페이지들의 본문 이미지를 페이지 순서대로 모아 내려받는다. 두 페이지 이상에 똑같이 나오는 이미지(인증 마크 등)는
// 사이트 공통 요소라 뺀다.
async function collectImages(pages: { title: string; url: string; html: string }[], fetchImpl: typeof fetch, timeoutMs: number): Promise<HomepageImage[]> {
  const perPage = pages.map((p) => ({ ...p, images: contentImages(p.html, p.url) }));
  const seen = new Map<string, number>();
  for (const p of perPage) for (const image of p.images) seen.set(image.url, (seen.get(image.url) ?? 0) + 1);
  const candidates = perPage.flatMap((p) => p.images.filter((image) => seen.get(image.url) === 1).slice(0, MAX_IMAGES_PER_PAGE)
    .map((image) => ({ ...image, page: p.title, pageUrl: p.url }))).slice(0, MAX_IMAGE_CANDIDATES);
  const loaded = await Promise.all(candidates.map(async (c) => {
    const image = await fetchImage(c.url, fetchImpl, timeoutMs);
    return image ? { ...c, ...image } : null;
  }));
  return loaded.filter((image): image is HomepageImage => image !== null).slice(0, MAX_IMAGES);
}

// 국내 홈페이지에는 EUC-KR이 아직 많아, 헤더나 meta의 charset으로 디코딩한다.
export function decode(bytes: ArrayBuffer, contentType: string): string {
  const head = new TextDecoder("latin1").decode(bytes.slice(0, 4096));
  const charset = (contentType.match(/charset=([\w-]+)/i)?.[1] ?? head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ?? "utf-8").toLowerCase();
  try { return new TextDecoder(charset).decode(bytes); }
  catch { return new TextDecoder("utf-8").decode(bytes); }
}

type Page = { status: "ok"; url: string; html: string } | { status: "unavailable"; url: string; reason: string };

async function fetchPage(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<Page> {
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
    return { status: "ok", url: res.url || url, html: decode(bytes.slice(0, MAX_BYTES), contentType) };
  } catch (error) {
    return { status: "unavailable", url, reason: controller.signal.aborted ? "응답 시간 초과" : error instanceof Error ? error.message : "요청 실패" };
  } finally { clearTimeout(timer); }
}

// 첫 화면을 읽고(프레임·리다이렉트는 따라감), 회사 정보 하위 페이지를 함께 읽어 페이지 이름을 붙여 합친다.
async function crawl(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<HomepageResult> {
  let page = await fetchPage(url, fetchImpl, timeoutMs);
  for (let hop = 0; page.status === "ok" && hop < MAX_REDIRECTS; hop++) {
    if (extractHomepageText(page.html).text.length >= MIN_TEXT) break;
    const next = redirectTarget(page.html, page.url);
    if (!next || next === page.url || !sameSite(new URL(next), new URL(page.url))) break;
    page = await fetchPage(next, fetchImpl, timeoutMs);
  }
  if (page.status !== "ok") return page;
  const root = extractHomepageText(page.html);
  if (root.text.length < MIN_TEXT) return { status: "unavailable", url: page.url, reason: "본문이 거의 없음(스크립트로 그리는 페이지일 수 있음)" };
  const links = subpageLinks(page.html, page.url);
  const subpages = (await Promise.all(links.map(async (link) => {
    const sub = await fetchPage(link.url, fetchImpl, timeoutMs);
    if (sub.status !== "ok") return null;
    const { text } = extractHomepageText(sub.html, { stripChrome: true, limit: SUBPAGE_TEXT_LIMIT });
    // 본문 글자가 거의 없어도 이미지에 내용이 있을 수 있어 남긴다(인재상 페이지가 이미지 한 장인 경우).
    return text.length >= 50 || contentImages(sub.html, sub.url).length ? { ...link, url: sub.url, text, html: sub.html } : null;
  }))).filter((s): s is HomepagePage & { text: string; html: string } => s !== null);
  const images = await collectImages(subpages, fetchImpl, timeoutMs);
  return {
    status: "ok", url: page.url, title: root.title,
    text: [`[첫 화면 — ${page.url}]\n${root.text}`, ...subpages.map((s) => `[${s.title} — ${s.url}]\n${s.text}`)].join("\n\n"),
    pages: [{ title: root.title || "첫 화면", url: page.url }, ...subpages.map(({ title, url }) => ({ title, url }))],
    images,
  };
}

const cache = new Map<string, { at: number; result: Promise<HomepageResult> }>();

// 리서치 섹션들이 같은 홈페이지를 연달아·동시에 쓰므로 진행 중인 요청까지 잠시 재사용한다. https가 안 되면 http로 한 번 더 시도한다.
export function fetchHomepage(url: string, { fetchImpl = fetch, timeoutMs = 15_000 }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<HomepageResult> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  const result = (async () => {
    const first = await crawl(url, fetchImpl, timeoutMs);
    if (first.status === "ok" || !url.startsWith("https://")) return first;
    const fallback = await crawl(url.replace(/^https:/, "http:"), fetchImpl, timeoutMs);
    return fallback.status === "ok" ? fallback : first;
  })();
  cache.set(url, { at: Date.now(), result });
  return result;
}

// 후보 주소를 순서대로(최대 3개) 시도해 처음 읽힌 홈페이지를 돌려준다. 하나도 없으면 null, 모두 실패하면 첫 실패 사유.
export async function findHomepage(candidates: string[], options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<HomepageResult | null> {
  let firstFailure: HomepageResult | null = null;
  for (const url of homepageCandidates(candidates).slice(0, MAX_CANDIDATES)) {
    const result = await fetchHomepage(url, options);
    if (result.status === "ok") return result;
    firstFailure ??= result;
  }
  return firstFailure;
}
