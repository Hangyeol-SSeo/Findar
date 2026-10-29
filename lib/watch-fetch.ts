import { decode, isPublicHost } from "./company-homepage";

// 채용 사이트 감시(lib/company-watch.ts)가 쓰는 요청 함수. 금투협 크롤러와 같은 원칙을 지킨다.
//  - 이 도구임을 밝힌다(FindarResearch UA). 브라우저로 위장하지 않는다.
//  - robots.txt를 호스트별로 하루 한 번 받아 Google 방식(가장 긴 규칙 우선, Allow가 같은 길이면 이김)으로 판정하고,
//    금지된 경로는 요청하지 않는다. Python 기본 파서처럼 먼저 나온 규칙이 이기면 `Disallow: / … Allow: /appsite/`를 잘못 읽는다.
//  - 같은 호스트에는 1초 이상 간격을 둔다.
//  - 401/403/429·봇 차단 확인 페이지는 WatchBlockedError로 알리고, 우회하지 않는다.
//  - 인증서 검증을 끄지 않는다.

export const WATCH_USER_AGENT = "Mozilla/5.0 (compatible; FindarResearch/1.0; job postings for a job applicant)";
const ROBOTS_TOKEN = "findarresearch";
const HOST_GAP_MS = 1000;
const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 3_000_000;
const CHALLENGE = /awsWafCookieDomainList|gokuProps|challenge-platform|cf-chl-|<title>\s*Just a moment/i;

export class WatchBlockedError extends Error {}
export class WatchFetchError extends Error {}

interface RobotsRule { allow: boolean; pattern: string }

/** robots.txt에서 이 도구에 적용할 규칙. FindarResearch 그룹이 있으면 그것, 없으면 `*` 그룹(여러 개면 합친다). */
export function parseRobots(text: string): RobotsRule[] {
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let current: { agents: string[]; rules: RobotsRule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const match = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const field = match[1].toLowerCase();
    const value = match[2].trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === "allow" || field === "disallow") {
      lastWasAgent = false;
      if (!current || !value) continue; // 빈 Disallow는 "모두 허용"
      current.rules.push({ allow: field === "allow", pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  const own = groups.filter((g) => g.agents.some((a) => a !== "*" && ROBOTS_TOKEN.startsWith(a)));
  const chosen = own.length > 0 ? own : groups.filter((g) => g.agents.includes("*"));
  return chosen.flatMap((g) => g.rules);
}

function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = body.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${regex}${anchored ? "$" : ""}`).test(path);
}

/** path(검색어 포함)가 허용되는지. 가장 긴 규칙이 이기고, 길이가 같으면 Allow가 이긴다. */
export function robotsAllows(rules: RobotsRule[], path: string): boolean {
  let best: RobotsRule | null = null;
  for (const rule of rules) {
    if (!patternMatches(rule.pattern, path)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule;
  }
  return !best || best.allow;
}

export interface WatchFetcher {
  /** HTML·텍스트 페이지를 받는다(EUC-KR 해석 포함). 최종 주소도 돌려준다. */
  text(url: string, init?: { method?: "GET" | "POST"; body?: string; contentType?: string }): Promise<{ url: string; text: string }>;
  /** 첨부파일·이미지를 받는다(maxBytes를 넘으면 실패). 파일 이름은 Content-Disposition에서 읽는다. */
  bytes?(url: string, maxBytes: number): Promise<{ url: string; bytes: Uint8Array; contentType: string; filename: string }>;
}

// Content-Disposition의 파일 이름. filename*=UTF-8''… 를 먼저, 국내 사이트는 filename="…"에 UTF-8·EUC-KR 바이트를 그대로
// 넣거나 퍼센트 인코딩하는 경우가 많다.
export function dispositionFilename(header: string | null): string {
  if (!header) return "";
  const star = header.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  if (star) { try { return decodeURIComponent(star[1].trim()); } catch { /* 아래로 */ } }
  const plain = header.match(/filename\s*=\s*"?([^";]+)"?/)?.[1]?.trim() ?? "";
  if (!plain) return "";
  try { if (/%[0-9a-f]{2}/i.test(plain)) return decodeURIComponent(plain.replace(/\+/g, " ")); } catch { /* 그대로 */ }
  // fetch는 헤더를 latin1로 준다. UTF-8·EUC-KR 바이트였다면 다시 해석한다.
  const raw = Uint8Array.from([...plain].map((c) => c.charCodeAt(0) & 0xff));
  for (const charset of ["utf-8", "euc-kr"]) {
    try { return new TextDecoder(charset, { fatal: true }).decode(raw); } catch { /* 다음 */ }
  }
  return plain;
}

export function createWatchFetcher(fetchImpl: typeof fetch = fetch, { gapMs = HOST_GAP_MS, signal }: { gapMs?: number; signal?: AbortSignal } = {}): WatchFetcher {
  const robots = new Map<string, { rules: RobotsRule[] | null; at: number }>();
  const lastRequest = new Map<string, number>();

  async function wait(host: string) {
    const last = lastRequest.get(host);
    if (last !== undefined) {
      const gap = last + gapMs - Date.now();
      if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
    }
    lastRequest.set(host, Date.now());
  }

  async function raw(url: string, init: { method?: string; body?: string; contentType?: string } = {}) {
    if (signal?.aborted) throw new WatchFetchError("취소됨");
    const host = new URL(url).host;
    await wait(host);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort);
    try {
      return await fetchImpl(url, {
        method: init.method ?? "GET",
        body: init.body,
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": WATCH_USER_AGENT,
          "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          "Accept-Language": "ko-KR,ko;q=0.9",
          ...(init.contentType ? { "Content-Type": init.contentType } : {}),
        },
      });
    } catch (error) {
      if (controller.signal.aborted) throw new WatchFetchError(signal?.aborted ? "취소됨" : "응답 시간 초과");
      const cause = (error as { cause?: { code?: string } }).cause?.code ?? "";
      throw new WatchFetchError(`연결 실패${cause ? ` (${cause})` : ""}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async function rulesFor(origin: string): Promise<RobotsRule[]> {
    const cached = robots.get(origin);
    if (cached && Date.now() - cached.at < ROBOTS_TTL_MS) {
      if (!cached.rules) throw new WatchFetchError("robots.txt를 확인하지 못함");
      return cached.rules;
    }
    let rules: RobotsRule[] | null;
    try {
      const res = await raw(`${origin}/robots.txt`);
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        robots.set(origin, { rules: null, at: Date.now() });
        throw new WatchBlockedError(`robots.txt 요청이 막힘 (HTTP ${res.status})`);
      }
      if (res.status >= 500) rules = null;
      else if (!res.ok) rules = []; // 404 등: robots.txt 없음 → 모두 허용
      else {
        const body = await res.text();
        // 없는 경로에 HTML·JSON을 돌려주는 사이트가 있다. robots.txt 형식이 아니면 규칙이 없는 것으로 본다.
        rules = /^\s*[<{]/.test(body) ? [] : parseRobots(body);
      }
    } catch (error) {
      if (error instanceof WatchBlockedError) throw error;
      rules = null;
    }
    robots.set(origin, { rules, at: Date.now() });
    if (!rules) throw new WatchFetchError("robots.txt를 확인하지 못함");
    return rules;
  }

  async function assertAllowed(url: string) {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new WatchFetchError("http(s) 주소가 아님");
    if (!isPublicHost(u.hostname)) throw new WatchFetchError("내부 주소");
    const rules = await rulesFor(u.origin);
    if (!robotsAllows(rules, `${u.pathname}${u.search}`)) throw new WatchBlockedError(`robots.txt가 ${u.pathname}을(를) 금지함`);
  }

  return {
    async bytes(url, maxBytes) {
      await assertAllowed(url);
      const res = await raw(url);
      const finalUrl = res.url || url;
      if (finalUrl !== url) await assertAllowed(finalUrl);
      if (res.status === 401 || res.status === 403 || res.status === 429) throw new WatchBlockedError(`HTTP ${res.status} — 자동 접근이 막힘`);
      if (!res.ok) throw new WatchFetchError(`HTTP ${res.status}`);
      const length = Number(res.headers.get("content-length") ?? 0);
      if (length > maxBytes) throw new WatchFetchError("파일이 너무 큼");
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > maxBytes) throw new WatchFetchError("파일이 너무 큼");
      return { url: finalUrl, bytes, contentType: res.headers.get("content-type") ?? "", filename: dispositionFilename(res.headers.get("content-disposition")) };
    },
    async text(url, init = {}) {
      await assertAllowed(url);
      const res = await raw(url, init);
      const finalUrl = res.url || url;
      if (finalUrl !== url) await assertAllowed(finalUrl);
      if (res.status === 401 || res.status === 403 || res.status === 429) throw new WatchBlockedError(`HTTP ${res.status} — 자동 접근이 막힘`);
      if (!res.ok) throw new WatchFetchError(`HTTP ${res.status}`);
      const contentType = res.headers.get("content-type") ?? "";
      const text = decode((await res.arrayBuffer()).slice(0, MAX_BYTES), contentType);
      if (res.status === 202 || (text.length < 40_000 && CHALLENGE.test(text))) throw new WatchBlockedError("봇 차단 확인 페이지");
      return { url: finalUrl, text };
    },
  };
}
