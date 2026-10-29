import * as cheerio from "cheerio";
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
}

export interface WatchAdapter {
  list(base: string, fetcher: WatchFetcher): Promise<WatchPosting[]>;
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

export const WATCH_ADAPTERS: Record<WatchAdapterType, WatchAdapter> = {
  greeting: greetingAdapter,
  saraminAts: saraminAtsAdapter,
  recruiterAppsite: recruiterAppsiteAdapter,
};
