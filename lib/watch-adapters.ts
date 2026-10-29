import * as cheerio from "cheerio";
import { createHash } from "crypto";
import { CHROME } from "./company-homepage";
import { WATCH_SEQ_PREFIXES, type WatchAdapterType } from "./job-source";
import { WatchFetchError, type WatchFetcher } from "./watch-fetch";

// 채용 시스템(ATS) 계열마다 어댑터 하나로 여러 회사를 받는다. 회사별 파서는 두지 않는다. AI 없음.
// 목록에서 공고 제목·링크·(알면) 마감일을 얻고, 새 공고만 본문을 연다. 확인한 구조(2026-10-29):
//  - 그리팅(*.career.greetinghr.com, careers.kait.com 같은 회사 도메인): 첫 화면 HTML의 __NEXT_DATA__에 진행 중 공고 목록
//    (queryKey ["openings"])이 있고, 공고 페이지 /{locale}/o/{openingId}의 __NEXT_DATA__ getOpeningById에 본문 HTML이 있다.
//    robots.txt는 /o/*/apply(지원서 작성)만 막는다.
//  - 사람인 기업 채용 사이트({slug}.saramin.co.kr): 두 가지 화면이 있다.
//    (1) /service/{slug}/{id}/applicant/apply/index.asp 채용 한 건의 첫 화면(제목 h1, 때로 접수기간). 루트가 이곳으로
//        가거나(예탁결제원·증권금융·키움), 진행 중 채용 여러 건의 링크를 보여 준다(거래소). 본문은 recruit_default.asp.
//    (2) /apply_site/recruit/list 목록(상태·제목·접수기간), 본문은 /apply_site/recruit/contents_data/{id}(대한토지신탁).
//    진행 중 채용이 없으면 루트가 ending_page.html로 간다(코스콤). "진행중" 표시는 마감 뒤에도 남으니 믿지 않는다.

export interface WatchPosting {
  seq: string;
  title: string;
  url: string; // 공고 원문(지원하는 곳)
  postedAt: string; // YYYY-MM-DD HH:mm:ss(서울) 또는 ""
  deadline: string; // YYYY-MM-DD 또는 ""(모름)
  contentUrl: string; // 본문을 읽을 주소
  /** 본문을 따로 열지 않고 목록 정보로 만든 본문(recruiter 구형: 본문 페이지가 robots.txt 금지). */
  inlineContent?: string;
  /** 자체 게시판 글은 채용 안내·결과 발표일 수 있다. 요약에서 모집 직무가 나오지 않으면 저장하지 않는다. */
  mayNotBePosting?: boolean;
}

/** 감시 목록 출처의 사이트별 설정(자체 게시판용). */
export interface WatchListOptions {
  /** 글 링크가 javascript:fn('92')뿐인 게시판: 숫자 ID를 넣을 상세 주소. 예: "https://www.kasset.co.kr/recruit_view.do?recruitId={id}" */
  jsLinkTemplate?: string;
  /** 글마다 링크가 없고 목록 칸에 내용이 다 있는 게시판(우리자산운용): 한 공고를 감싸는 요소. 그 글을 본문으로 쓴다. */
  itemSelector?: string;
  now?: Date;
}

export interface WatchAdapter {
  list(base: string, fetcher: WatchFetcher, options?: WatchListOptions): Promise<WatchPosting[]>;
  content(posting: WatchPosting, fetcher: WatchFetcher): Promise<string>;
}

const SEOUL_DATE_TIME = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

export function seoulDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : SEOUL_DATE_TIME.format(date);
}

/** HTML 본문을 줄바꿈을 살린 글로 바꾼다. */
export function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe, template").remove();
  $("br").replaceWith("\n");
  $("p, div, li, tr, h1, h2, h3, h4, h5, h6, table, section, article, dt, dd").each((_, el) => {
    $(el).append("\n");
  });
  $("td, th").each((_, el) => {
    $(el).append(" ");
  });
  return $.root().text()
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter((line, i, lines) => line || (i > 0 && lines[i - 1]))
    .join("\n")
    .trim();
}

function nextData(html: string): unknown {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

type Query = { queryKey?: unknown[]; state?: { data?: unknown } };
function dehydratedQueries(data: unknown): Query[] {
  const queries = (data as { props?: { pageProps?: { dehydratedState?: { queries?: Query[] } } } })?.props?.pageProps?.dehydratedState?.queries;
  return Array.isArray(queries) ? queries : [];
}

interface GreetingOpening {
  openingId?: number;
  title?: string;
  openDate?: string | null;
  dueDate?: string | null;
}

export const greetingAdapter: WatchAdapter = {
  async list(base, fetcher) {
    const page = await fetcher.text(new URL("/", base).toString());
    const query = dehydratedQueries(nextData(page.text)).find((q) => Array.isArray(q.queryKey) && q.queryKey.length === 1 && q.queryKey[0] === "openings");
    if (!query) throw new WatchFetchError("그리팅 공고 목록을 찾지 못함(페이지 구조가 바뀌었을 수 있음)");
    const openings = Array.isArray(query.state?.data) ? (query.state.data as GreetingOpening[]) : [];
    const final = new URL(page.url);
    const locale = final.pathname.split("/").filter(Boolean)[0] || "ko";
    return openings
      .filter((o) => typeof o.openingId === "number" && typeof o.title === "string")
      .map((o) => {
        const url = `${final.origin}/${locale}/o/${o.openingId}`;
        return {
          seq: `${WATCH_SEQ_PREFIXES.greeting}${o.openingId}`,
          title: o.title!.replace(/\s+/g, " ").trim(),
          url,
          postedAt: seoulDateTime(o.openDate),
          deadline: seoulDateTime(o.dueDate).slice(0, 10),
          contentUrl: url,
        };
      });
  },
  async content(posting, fetcher) {
    const page = await fetcher.text(posting.contentUrl);
    const query = dehydratedQueries(nextData(page.text)).find((q) => Array.isArray(q.queryKey) && q.queryKey[1] === "getOpeningById");
    const detail = (query?.state?.data as { data?: { openingsInfo?: { detail?: string } } } | undefined)?.data?.openingsInfo?.detail;
    if (typeof detail !== "string") throw new WatchFetchError("그리팅 공고 본문을 찾지 못함");
    return htmlToText(detail);
  },
};

// "26.08.31(월) ~ 26.09.13(일) 23:00", "2026-08-21 09:00 ~ 2026-09-06 23:59", "2026.10.20 ~ 2026.11.02" 의 끝 날짜.
export function periodEnd(text: string): string {
  const parts = text.split(/~|∼|〜/);
  if (parts.length < 2) return "";
  const match = parts[parts.length - 1].match(/(\d{2,4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/);
  if (!match) return "";
  const year = match[1].length === 2 ? `20${match[1]}` : match[1];
  return `${year}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

const SARAMIN_MICROSITE = /\/service\/([a-z0-9_]+)\/(\d+)\/applicant\/apply\/index\.asp/i;
const MAX_SARAMIN_MICROSITES = 6;

async function saraminMicrosite(url: string, fetcher: WatchFetcher, html?: string): Promise<WatchPosting | null> {
  const page = html ? { url, text: html } : await fetcher.text(url);
  const match = page.url.match(SARAMIN_MICROSITE);
  if (!match) return null;
  const $ = cheerio.load(page.text);
  const title = ($(".unified-panel h1").first().text() || $("h1").first().text()).replace(/\s+/g, " ").trim();
  if (!title) return null;
  // "접수기간 : 26.08.31(월) ~ 26.09.13(일)"을 담은 가장 작은 요소(바깥 div는 화면 전체 글을 품는다).
  const period = $("p, div, span, li, dd, td").toArray()
    .map((el) => $(el).text().replace(/\s+/g, " ").trim())
    .filter((text) => /접수\s*기간/.test(text) && /~/.test(text))
    .sort((a, b) => a.length - b.length)[0] ?? "";
  const site = new URL(page.url);
  return {
    seq: `${WATCH_SEQ_PREFIXES.saraminAts}${match[1].toLowerCase()}-${match[2]}`,
    title,
    url: `${site.origin}${site.pathname}`,
    postedAt: "",
    deadline: periodEnd(period),
    contentUrl: `${site.origin}/service/${match[1]}/${match[2]}/applicant/apply/recruit_default.asp`,
  };
}

export const saraminAtsAdapter: WatchAdapter = {
  async list(base, fetcher) {
    const root = await fetcher.text(new URL("/", base).toString());
    const finalUrl = new URL(root.url);
    if (/ending_page/i.test(finalUrl.pathname)) return [];
    if (SARAMIN_MICROSITE.test(finalUrl.pathname)) {
      const posting = await saraminMicrosite(root.url, fetcher, root.text);
      return posting ? [posting] : [];
    }
    if (/\/apply_site\//.test(root.text) || /^\/main\//.test(finalUrl.pathname)) {
      const list = await fetcher.text(`${finalUrl.origin}/apply_site/recruit/list`);
      const $ = cheerio.load(list.text);
      const slug = finalUrl.hostname.split(".")[0].toLowerCase();
      const postings: WatchPosting[] = [];
      $("a.recruit_view").each((_, el) => {
        const href = $(el).attr("href") ?? "";
        const id = href.match(/\/apply_site\/recruit\/view\/(\d+)/)?.[1];
        if (!id) return;
        const row = $(el).closest("li");
        const state = row.find(".ico").first().text().trim();
        if (/마감|발표|종료/.test(state)) return;
        postings.push({
          seq: `${WATCH_SEQ_PREFIXES.saraminAts}${slug}-${id}`,
          title: $(el).text().replace(/\s+/g, " ").trim(),
          url: new URL(href, list.url).toString(),
          postedAt: "",
          deadline: periodEnd(row.find(".tx1").first().text()),
          contentUrl: `${finalUrl.origin}/apply_site/recruit/contents_data/${id}`,
        });
      });
      return postings;
    }
    // 진행 중 채용 여러 건을 소개하는 첫 화면(거래소): 각 채용의 첫 화면을 연다.
    const links = [...new Set([...root.text.matchAll(new RegExp(SARAMIN_MICROSITE.source, "gi"))].map((m) => new URL(m[0], root.url).toString()))];
    if (links.length === 0) throw new WatchFetchError("사람인 채용 사이트에서 채용 목록을 찾지 못함(페이지 구조가 바뀌었을 수 있음)");
    const postings: WatchPosting[] = [];
    for (const link of links.slice(0, MAX_SARAMIN_MICROSITES)) {
      const posting = await saraminMicrosite(link, fetcher);
      if (posting) postings.push(posting);
    }
    return postings;
  },
  async content(posting, fetcher) {
    const page = await fetcher.text(posting.contentUrl);
    const $ = cheerio.load(page.text);
    const container = $(".recruit").first();
    return htmlToText(container.length ? container.html() ?? "" : $("body").html() ?? "");
  },
};

// recruiter.co.kr 구형 채용 사이트({slug}.recruiter.co.kr/appsite/…, 마이다스아이티). robots.txt가 `Disallow: /` 뒤에
// `Allow: /appsite/`라 목록(POST /appsite/company/getMainView, 채용 사이트 번호 appsiteSn은 /appsite/company/index의
// hidden input)만 받는다. 공고 본문 페이지(/app/jobnotice/view)는 금지 경로라 열지 않고, 목록의 제목·채용 구분·접수 기간을
// 본문 대신 저장한다(본문 자체도 대개 이미지다). 사용자는 공고 페이지 링크로 원문을 연다.
interface RecruiterJobnotice {
  jobnoticeSn?: number;
  jobnoticeName?: string;
  applyStartDate?: string | null;
  applyEndDate?: string | null;
  receiptState?: string | null;
  recruitTypeName?: string | null;
  recruitClassName?: string | null;
  systemKindCode?: string | null;
}

const RECRUITER_FIELDS_ONLY = "※ 이 채용 사이트는 공고 본문 페이지의 자동 수집을 robots.txt로 막고 있어 목록 정보만 저장했습니다. 본문은 공고 페이지에서 확인하세요.";

export const recruiterAppsiteAdapter: WatchAdapter = {
  async list(base, fetcher) {
    const origin = new URL(base).origin;
    const index = await fetcher.text(`${origin}/appsite/company/index`);
    const appsiteSn = index.text.match(/appsiteSn"\s+value="(\d+)"/)?.[1] ?? index.text.match(/id="appsiteSn"[^>]*value="(\d+)"/)?.[1];
    if (!appsiteSn) throw new WatchFetchError("recruiter 채용 사이트 번호를 찾지 못함(페이지 구조가 바뀌었을 수 있음)");
    const main = await fetcher.text(`${origin}/appsite/company/getMainView`, {
      method: "POST", body: `appsiteSn=${appsiteSn}`, contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    });
    let data: { jobnoticeInProgressList?: RecruiterJobnotice[]; message?: string };
    try { data = JSON.parse(main.text); } catch { throw new WatchFetchError("recruiter 공고 목록 응답을 읽지 못함"); }
    if (!Array.isArray(data.jobnoticeInProgressList)) throw new WatchFetchError(`recruiter 공고 목록이 없음${data.message ? `(${data.message})` : ""}`);
    const slug = new URL(origin).hostname.split(".")[0].toLowerCase();
    return data.jobnoticeInProgressList
      .filter((j) => typeof j.jobnoticeSn === "number" && typeof j.jobnoticeName === "string" && !/마감/.test(j.receiptState ?? ""))
      .map((j) => {
        const url = `${origin}/app/jobnotice/view?systemKindCode=${encodeURIComponent(j.systemKindCode || "MRS2")}&jobnoticeSn=${j.jobnoticeSn}`;
        const lines = [
          j.jobnoticeName!.trim(),
          [j.recruitTypeName, j.recruitClassName].filter(Boolean).length ? `채용 구분: ${[j.recruitTypeName, j.recruitClassName].filter(Boolean).join(" · ")}` : "",
          j.applyStartDate || j.applyEndDate ? `접수 기간: ${j.applyStartDate ?? ""} ~ ${j.applyEndDate ?? ""}` : "",
          RECRUITER_FIELDS_ONLY,
        ].filter(Boolean);
        return {
          seq: `${WATCH_SEQ_PREFIXES.recruiterAppsite}${slug}-${j.jobnoticeSn}`,
          title: j.jobnoticeName!.replace(/\s+/g, " ").trim(),
          url,
          postedAt: (j.applyStartDate ?? "").slice(0, 19),
          deadline: /^\d{4}-\d{2}-\d{2}/.test(j.applyEndDate ?? "") ? j.applyEndDate!.slice(0, 10) : "",
          contentUrl: "",
          inlineContent: lines.join("\n"),
        };
      });
  },
  async content(posting) {
    return posting.inlineContent ?? "";
  },
};

// 자체 채용 게시판(pageWatch). 사이트마다 파서를 두지 않는다. 확인한 게시판(2026-10-29): 하나자산운용·마스턴·신영자산운용
// (공지 게시판의 채용 분류)·신영부동산신탁·하나자산신탁·이지자산평가·코리아에셋(글 링크가 javascript:)·우리자산운용(링크 없음).
//  1. 게시판 첫 페이지에서 사이트 공통 메뉴(CHROME)를 빼고, 같은 사이트의 글 링크를 찾는다. 글 링크 = 게시판 주소와 다르고,
//     쪽 번호 링크가 아니며, 주소에 글 번호(숫자)가 있다. 링크 글자가 "상세보기"·"입사지원"처럼 일반적이면 그 줄의 제목 칸을 쓴다.
//  2. 줄(tr·li 등)에 "마감·채용완료"가 있거나, 접수 기간 끝이 지났거나, 적힌 연도가 모두 올해 전이면 열지 않는다
//     (게시판 첫 페이지에 몇 년 치 글이 있다 — 신영부동산신탁 2022년 공고).
//  3. 새 글만 열어 본문을 읽고, 요약에서 모집 직무가 나오지 않으면 저장하지 않는다(채용 안내·결과 발표 글).
const GENERIC_LINK_TEXT = /^(?:상세\s*보기|자세히\s*보기?|더\s*보기|입사\s*지원(?:하기)?|지원\s*하기|채용\s*마감|마감|보기|view|more|apply)$/i;
const CLOSED_MARK = /채용\s*완료|채용\s*마감|접수\s*마감|모집\s*마감|^\s*마감|종료된/;
const PAGE_PARAM = /^(?:page|pageno|pageindex|cpage|pg|p)$/i;
const ROW = "tr, li, article, dl, [class*=item], [class*=list] > div";
const TITLE = "[class*=tit], [class*=subject], [class*=title], strong, h3, h4, h5";
const DATE = /(20\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/g;

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// 같은 글이 쪽 번호·빈 검색어 인자만 달리해 나타나도(…/view/8064?keyword=&page=0) 같은 번호가 되게, 그런 인자를 빼고 해시한다.
function pageSeq(url: string): string {
  const u = new URL(url);
  const kept = [...u.searchParams.entries()].filter(([key, value]) => value !== "" && !PAGE_PARAM.test(key)).sort(([a], [b]) => a.localeCompare(b));
  const key = `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}?${kept.map(([k, v]) => `${k}=${v}`).join("&")}${u.hash}`;
  return `${WATCH_SEQ_PREFIXES.pageWatch}${createHash("sha1").update(key).digest("hex").slice(0, 12)}`;
}

// 글 링크인지: 경로가 게시판과 다르면 그 차이에 글 번호(숫자)가 있어야 하고, 경로가 같으면 게시판 주소에 없던 인자 중
// 값이 숫자뿐인 것(seq=20, wr_id=2)이 있어야 한다. 쪽 번호(page=2, /page/2/)·분류(categorySeq=96 — 게시판 주소에도 있는 인자)·
// 탭(tab=tab01)은 글이 아니다. 글 링크에도 "&page=1"이 붙곤 한다(하나자산신탁 …/jobNotice/view?seq=44&page=1).
export function isPostLink(target: URL, board: URL): boolean {
  const path = (u: URL) => u.pathname.replace(/\/page\/\d+\/?$/, "/").replace(/\/+$/, "");
  const params = (u: URL) => [...u.searchParams.entries()].filter(([key]) => !PAGE_PARAM.test(key));
  const boardPath = path(board);
  const targetPath = path(target);
  if (targetPath !== boardPath) {
    let extra = targetPath.startsWith(boardPath) ? targetPath.slice(boardPath.length) : targetPath;
    try { extra = decodeURIComponent(extra); } catch { /* 그대로 */ }
    return /\d/.test(extra) || params(target).some(([, value]) => /^\d+$/.test(value));
  }
  const boardKeys = new Set(params(board).map(([key]) => key));
  return params(target).some(([key, value]) => !boardKeys.has(key) && /^\d+$/.test(value));
}

function sameSite(a: URL, b: URL): boolean {
  return a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "");
}

/** 줄 글에서 읽은 마감일과 "이미 지난 글" 여부. */
export function rowDates(rowText: string, now: Date): { deadline: string; postedAt: string; old: boolean } {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(now);
  let deadline = periodEnd(rowText);
  // 연도 없는 마감 표기("~9.13", "~ 10/29")는 올해로 읽는다. 반년 넘게 앞선 달이면 내년(12월 글의 "~1/10").
  const short = !deadline ? rowText.match(/~\s*(\d{1,2})\s*[./]\s*(\d{1,2})(?!\d)/) : null;
  if (short && Number(short[1]) >= 1 && Number(short[1]) <= 12 && Number(short[2]) >= 1 && Number(short[2]) <= 31) {
    const month = Number(short[1]);
    const year = Number(today.slice(0, 4)) + (month < Number(today.slice(5, 7)) - 6 ? 1 : 0);
    deadline = `${year}-${String(month).padStart(2, "0")}-${short[2].padStart(2, "0")}`;
  }
  const dates = [...rowText.matchAll(DATE)].map((m) => `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`);
  const years = [...rowText.matchAll(/(?:^|[^\d])(20\d{2})(?:년|[.\-/]|\s|$)/g)].map((m) => Number(m[1]));
  const postedAt = dates.find((d) => d !== deadline) ?? "";
  const old = (deadline !== "" && deadline < today)
    || (years.length > 0 && Math.max(...years) < Number(today.slice(0, 4)))
    || (!deadline && postedAt !== "" && postedAt < new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date(now.getTime() - 60 * 86_400_000)));
  return { deadline, postedAt: postedAt ? `${postedAt} 00:00:00` : "", old };
}

function rowTitle($: cheerio.CheerioAPI, anchor: cheerio.Cheerio<never>, row: cheerio.Cheerio<never>): string {
  const own = oneLine(anchor.text());
  if (own.length >= 4 && !GENERIC_LINK_TEXT.test(own)) {
    const inner = anchor.find(TITLE).first();
    const innerText = oneLine(inner.text());
    return innerText.length >= 4 ? innerText : own;
  }
  const titled = row.find(TITLE).filter((_, el) => {
    const text = oneLine($(el).text());
    return text.length >= 4 && !GENERIC_LINK_TEXT.test(text);
  }).first();
  return oneLine(titled.text()) || oneLine(row.text()).slice(0, 120);
}

export const pageWatchAdapter: WatchAdapter = {
  async list(base, fetcher, options = {}) {
    const now = options.now ?? new Date();
    const page = await fetcher.text(base);
    const boardUrl = new URL(page.url);
    const $ = cheerio.load(page.text);
    $("script, style, noscript, template").remove();
    $(CHROME).remove();
    const postings = new Map<string, WatchPosting>();

    if (options.itemSelector) {
      $(options.itemSelector).each((_, el) => {
        const item = $(el);
        const text = htmlToText(item.html() ?? "");
        const title = oneLine(item.find(TITLE).first().text()) || text.split("\n")[0];
        if (!title || CLOSED_MARK.test(oneLine(item.text()))) return;
        const dates = rowDates(oneLine(item.text()), now);
        if (dates.old) return;
        const seq = pageSeq(`${boardUrl.origin}${boardUrl.pathname}#${title}`);
        postings.set(seq, { seq, title, url: boardUrl.toString(), postedAt: dates.postedAt, deadline: dates.deadline, contentUrl: "", inlineContent: text, mayNotBePosting: true });
      });
      return [...postings.values()];
    }

    $("a").each((_, el) => {
      const anchor = $(el) as cheerio.Cheerio<never>;
      const href = (anchor.attr("href") ?? "").trim();
      let target: URL | null = null;
      // javascript:fn_egov_select('92') → 상세 주소. 쪽 번호 함수(fn_egov_link_page(2))는 뺀다.
      const jsId = `${href} ${anchor.attr("onclick") ?? ""}`.match(/(\w+)\(\s*['"]?(\d+)['"]?\s*\)/);
      if (options.jsLinkTemplate && jsId && !/page/i.test(jsId[1])) target = new URL(options.jsLinkTemplate.replace("{id}", jsId[2]));
      else if (href && !/^(?:javascript:|#|mailto:|tel:)/i.test(href)) {
        try { target = new URL(href, boardUrl); } catch { target = null; }
      }
      if (!target || !sameSite(target, boardUrl)) return;
      target.hash = "";
      if (!isPostLink(target, boardUrl)) return;
      if (/\.(?:pdf|hwp|hwpx|docx?|xlsx?|zip|jpe?g|png|gif)(?:$|\?)/i.test(target.pathname)) return;

      const row = (anchor.closest(ROW).length ? anchor.closest(ROW) : anchor.parent()) as cheerio.Cheerio<never>;
      const rowText = oneLine(row.text());
      const title = rowTitle($, anchor, row);
      if (title.length < 4 || CLOSED_MARK.test(rowText)) return;
      const dates = rowDates(rowText, now);
      if (dates.old) return;
      const url = target.toString();
      const seq = pageSeq(url);
      if (!postings.has(seq)) postings.set(seq, { seq, title, url, postedAt: dates.postedAt, deadline: dates.deadline, contentUrl: url, mayNotBePosting: true });
    });
    return [...postings.values()];
  },
  async content(posting, fetcher) {
    if (posting.inlineContent !== undefined) return posting.inlineContent;
    const page = await fetcher.text(posting.contentUrl);
    const $ = cheerio.load(page.text);
    $("script, style, noscript, template").remove();
    $(CHROME).remove();
    // 이전글·다음글·목록 버튼(코리아에셋은 본문이 이미지라 이것만 글로 남았다).
    $("[class*=prev], [class*=next], [class*=pager], [class*=paging], [class*=btn_list], [class*=list_btn]").remove();
    $("*").filter((_, el) => /^(?:이전글|다음글)/.test(oneLine($(el).text())) && oneLine($(el).text()).length < 200).remove();
    const main = $("article, [class*=view], [class*=detail], [class*=board_read], main, #content, .content, #contents, .contents")
      .toArray().map((el) => $(el)).filter((el) => oneLine(el.text()).length >= 40)
      .sort((a, b) => oneLine(b.text()).length - oneLine(a.text()).length)[0];
    const text = htmlToText((main ?? $("body")).html() ?? "").slice(0, 30_000);
    // 본문이 이미지·첨부파일뿐이면 글이 거의 없다. 요약기가 최소한 제목은 보게 한다.
    return text.includes(posting.title) ? text : `${posting.title}\n${text}`.trim();
  },
};

export const WATCH_ADAPTERS: Record<WatchAdapterType, WatchAdapter> = {
  greeting: greetingAdapter,
  saraminAts: saraminAtsAdapter,
  recruiterAppsite: recruiterAppsiteAdapter,
  pageWatch: pageWatchAdapter,
};
