import * as cheerio from "cheerio";

const BASE_URL = "https://www.kofia.or.kr/brd/m_96";
const DELAY_MS = 1000;

export interface JobListItem {
  seq: string;
  company: string;
  title: string;
  date: string;
}

export interface JobDetail extends JobListItem {
  views: string;
  applicationPeriod: string;
  siteUrl: string;
  attachments: { name: string; url: string }[];
  content: string;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchListPage(page: number): Promise<JobListItem[]> {
  const url = `${BASE_URL}/list.do?page=${page}&srchFr=&srchTo=&srchWord=&srchTp=&multi_itm_seq=0&itm_seq_1=0&itm_seq_2=0&company_cd=&company_nm=`;
  const res = await fetch(url);
  const html = await res.text();
  const $ = cheerio.load(html);

  const items: JobListItem[] = [];

  $("table tbody tr").each((_, row) => {
    const tds = $(row).find("td");
    if (tds.length < 5) return;

    const titleLink = $(tds[2]).find("a");
    const href = titleLink.attr("href") || "";
    const seqMatch = href.match(/seq=(\d+)/);
    if (!seqMatch) return;

    items.push({
      seq: seqMatch[1],
      company: $(tds[1]).text().trim(),
      title: titleLink.text().trim(),
      date: $(tds[4]).text().trim(),
    });
  });

  return items;
}

export async function fetchDetailPage(seq: string): Promise<JobDetail | null> {
  const url = `${BASE_URL}/view.do?seq=${seq}`;
  const res = await fetch(url);
  const html = await res.text();
  const $ = cheerio.load(html);

  const table = $("table.common1");

  const title =
    table.find('th:contains("제목")').first().next("td").text().trim() || "";
  const date =
    table.find('th:contains("등록일")').first().next("td").text().trim() || "";
  const views =
    table.find('th:contains("조회수")').first().next("td").text().trim() || "";
  const company =
    table.find('th:contains("회원사명")').first().next("td").text().trim() || "";
  const applicationPeriod =
    table.find('th:contains("접수기간")').first().next("td").text().trim() || "";
  const siteUrl =
    table
      .find('th:contains("사이트바로가기")')
      .first()
      .next("td")
      .find("a")
      .text()
      .trim() || "";

  const attachments: { name: string; url: string }[] = [];
  table.find('th:contains("첨부")').each((_, el) => {
    const a = $(el).next("td").find("a");
    if (a.length) {
      attachments.push({
        name: a.text().trim(),
        url: `${BASE_URL}/${a.attr("href")?.replace("./", "") || ""}`,
      });
    }
  });

  const content = $("#write").text().trim() || "";

  return {
    seq,
    company,
    title,
    date,
    views,
    applicationPeriod,
    siteUrl,
    attachments,
    content,
  };
}

export async function fetchRecentJobs(
  maxPages: number = 5
): Promise<JobDetail[]> {
  const allDetails: JobDetail[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const listItems = await fetchListPage(page);
    if (listItems.length === 0) break;

    for (const item of listItems) {
      await sleep(DELAY_MS);
      const detail = await fetchDetailPage(item.seq);
      if (detail) {
        allDetails.push(detail);
      }
    }

    if (page < maxPages) {
      await sleep(DELAY_MS);
    }
  }

  return allDetails;
}
