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
      model: "claude-haiku-4-5",
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
    return parsedToSummary(job, parsed);
  } catch {
    return fallbackSummary(job);
  }
}

export function fallbackSummary(job: JobDetail): JobSummary {
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

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x : String(x ?? "")))
    .filter((s) => s.trim().length > 0);
}

function parsedToSummary(job: JobDetail, parsed: Record<string, unknown>): JobSummary {
  return {
    seq: job.seq,
    company: job.company,
    title: job.title,
    date: job.date,
    applicationPeriod: job.applicationPeriod,
    siteUrl: job.siteUrl,
    attachments: job.attachments,
    positionType: typeof parsed.positionType === "string" ? parsed.positionType : "미분류",
    experienceYears: typeof parsed.experienceYears === "string" ? parsed.experienceYears : "미분류",
    positions: toStringArray(parsed.positions),
    jdSummary: typeof parsed.jdSummary === "string" ? parsed.jdSummary : "",
    qualifications: toStringArray(parsed.qualifications),
    deadline: typeof parsed.deadline === "string" ? parsed.deadline : "",
  };
}

/**
 * 여러 공고를 한 번의 query() 호출로 요약한다.
 * 배치 파싱에 실패한 공고는 호출측에서 summarizeJob으로 개별 재시도해야 한다(이 함수는 실패분을 결과 Map에서 누락시킬 뿐 예외를 던지지 않음).
 */
export async function summarizeJobBatch(
  jobs: JobDetail[]
): Promise<Map<string, JobSummary>> {
  const jobList = jobs
    .map(
      (job, i) => `
## 공고 ${i + 1} (seq: ${job.seq})
회원사: ${job.company}
제목: ${job.title}
접수기간: ${job.applicationPeriod}
내용:
${job.content.slice(0, 3000)}`
    )
    .join("\n");

  const prompt = `다음 채용공고들을 각각 분석해서 아래 JSON 배열 형식으로만 응답해. 마크다운이나 설명 없이 순수 JSON만 반환해.
${jobList}

JSON 배열 형식 (공고 수만큼, seq 순서 유지):
[
  {
    "seq": "공고 seq 값",
    "positionType": "신입/경력/인턴/신입경력 중 하나",
    "experienceYears": "경력 연차 (예: 3~5년, 무관, 신입)",
    "positions": ["모집 직무1", "모집 직무2"],
    "jdSummary": "핵심 업무내용 2-3문장 요약",
    "qualifications": ["자격요건1", "자격요건2"],
    "deadline": "마감일 (YYYY-MM-DD 형식, 모르면 빈 문자열)"
  }
]`;

  let resultText = "";
  for await (const message of query({
    prompt,
    options: {
      model: "claude-haiku-4-5",
      maxTurns: 1,
      allowedTools: [],
    },
  })) {
    if ("result" in message) {
      resultText = message.result;
    }
  }

  const result = new Map<string, JobSummary>();
  try {
    const jsonMatch =
      resultText.match(/```(?:json)?\s*([\s\S]*?)```/) ||
      resultText.match(/(\[[\s\S]*\])/);
    const parsed = JSON.parse(jsonMatch?.[1]?.trim() || "[]");
    if (Array.isArray(parsed)) {
      const jobBySeq = new Map(jobs.map((j) => [j.seq, j]));
      for (const item of parsed) {
        const job = jobBySeq.get(item?.seq);
        if (!job) continue;
        result.set(job.seq, parsedToSummary(job, item));
      }
    }
  } catch {
    // 파싱 실패 시 빈 맵 반환 → 호출측에서 전체 배치를 개별 재시도
  }

  return result;
}
