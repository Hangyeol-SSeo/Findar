import { query } from "@anthropic-ai/claude-agent-sdk";
import type { JobDetail } from "./crawler";

export interface JobSummary {
  seq: string;
  company: string;
  title: string;
  date: string;
  applicationPeriod: string;
  siteUrl: string;
  attachments: { name: string; url: string }[];
  // AI 요약 결과
  positionType: string; // 신입, 경력, 인턴, 신입/경력
  experienceYears: string; // e.g. "3~5년", "무관"
  positions: string[]; // 모집 직무들
  categories: string[]; // 직군 카테고리
  jdSummary: string; // JD 요약
  qualifications: string[]; // 자격 요건
  deadline: string; // 마감일
}

export async function summarizeJob(job: JobDetail): Promise<JobSummary> {
  const CATEGORIES = [
    "IT/개발", "운용", "리서치/분석", "투자/IB", "경영/기획",
    "영업/RM", "디자인/UX", "법무/컴플라이언스", "리스크",
    "재무/회계", "인사/총무", "퇴직연금", "부동산", "트레이딩", "마케팅",
  ];

  const prompt = `채용공고를 분석해서 JSON으로만 응답해. 설명 없이 순수 JSON만.

규칙:
- categories: 아래 목록에서 해당하는 것을 모두 선택. 반드시 1개 이상.
- 가능한 categories: ${CATEGORIES.join(", ")}
- 목록에 없으면 "기타"

${job.title} | ${job.company} | 접수:${job.applicationPeriod}
${job.content.slice(0, 2000)}
---
{"positionType":"신입/경력/인턴/신입경력","experienceYears":"","positions":[],"categories":[],"jdSummary":"","qualifications":[],"deadline":"YYYY-MM-DD"}`;

  let resultText = "";

  for await (const message of query({
    prompt,
    options: {
      maxTurns: 1,
      allowedTools: [],
    },
  })) {
    if ("result" in message) {
      resultText = message.result;
    }
  }

  try {
    // JSON 블록 추출 (```json ... ``` 또는 순수 JSON)
    const jsonMatch =
      resultText.match(/```(?:json)?\s*([\s\S]*?)```/) ||
      resultText.match(/(\{[\s\S]*\})/);

    const parsed = JSON.parse(jsonMatch?.[1]?.trim() || "{}");

    return {
      seq: job.seq,
      company: job.company,
      title: job.title,
      date: job.date,
      applicationPeriod: job.applicationPeriod,
      siteUrl: job.siteUrl,
      attachments: job.attachments,
      positionType: parsed.positionType || "미분류",
      experienceYears: parsed.experienceYears || "미분류",
      positions: parsed.positions || [],
      categories: parsed.categories?.length ? parsed.categories : ["기타"],
      jdSummary: parsed.jdSummary || "",
      qualifications: parsed.qualifications || [],
      deadline: parsed.deadline || "",
    };
  } catch {
    return {
      seq: job.seq,
      company: job.company,
      title: job.title,
      date: job.date,
      applicationPeriod: job.applicationPeriod,
      siteUrl: job.siteUrl,
      attachments: job.attachments,
      positionType: "미분류",
      experienceYears: "미분류",
      positions: [],
      categories: ["기타"],
      jdSummary: "요약 실패",
      qualifications: [],
      deadline: "",
    };
  }
}

export async function summarizeJobs(
  jobs: JobDetail[]
): Promise<JobSummary[]> {
  const results: JobSummary[] = [];

  for (const job of jobs) {
    try {
      const summary = await summarizeJob(job);
      results.push(summary);
    } catch (e) {
      console.error(`Failed to summarize job ${job.seq}:`, e);
      results.push({
        seq: job.seq,
        company: job.company,
        title: job.title,
        date: job.date,
        applicationPeriod: job.applicationPeriod,
        siteUrl: job.siteUrl,
        attachments: job.attachments,
        positionType: "미분류",
        experienceYears: "미분류",
        positions: [],
        categories: ["기타"],
        jdSummary: "요약 실패",
        qualifications: [],
        deadline: "",
      });
    }
  }

  return results;
}
