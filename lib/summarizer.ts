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
  jdSummary: string; // JD 요약
  qualifications: string[]; // 자격 요건
  deadline: string; // 마감일
}

export async function summarizeJob(job: JobDetail): Promise<JobSummary> {
  const prompt = `다음 채용공고를 분석해서 아래 JSON 형식으로만 응답해. 마크다운이나 설명 없이 순수 JSON만 반환해.

채용공고:
---
회원사: ${job.company}
제목: ${job.title}
접수기간: ${job.applicationPeriod}
내용:
${job.content.slice(0, 3000)}
---

JSON 형식:
{
  "positionType": "신입/경력/인턴/신입경력 중 하나",
  "experienceYears": "경력 연차 (예: 3~5년, 무관, 신입)",
  "positions": ["모집 직무1", "모집 직무2"],
  "jdSummary": "핵심 업무내용 2-3문장 요약",
  "qualifications": ["자격요건1", "자격요건2"],
  "deadline": "마감일 (YYYY-MM-DD 형식, 모르면 빈 문자열)"
}`;

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
        jdSummary: "요약 실패",
        qualifications: [],
        deadline: "",
      });
    }
  }

  return results;
}
