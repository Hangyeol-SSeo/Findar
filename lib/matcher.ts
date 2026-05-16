import { query } from "@anthropic-ai/claude-agent-sdk";
import type { JobSummary } from "./summarizer";
import type { Profile } from "./profile";

export interface JobMatch {
  matchScore: number; // 0-100
  matchVerdict: "추천" | "보통" | "비추천";
  matchStrengths: string[];
  matchGaps: string[];
  matchReasoning: string;
}

const FALLBACK_MATCH: JobMatch = {
  matchScore: 0,
  matchVerdict: "비추천",
  matchStrengths: [],
  matchGaps: [],
  matchReasoning: "평가 실패",
};

function clampScore(n: unknown): number {
  const v = typeof n === "number" ? n : parseInt(String(n));
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function normalizeVerdict(v: unknown, score: number): JobMatch["matchVerdict"] {
  const s = String(v ?? "");
  if (s.includes("추천") && !s.includes("비")) return "추천";
  if (s.includes("비추")) return "비추천";
  if (s.includes("보통")) return "보통";
  if (score >= 75) return "추천";
  if (score >= 50) return "보통";
  return "비추천";
}

export async function matchJob(
  profile: Profile,
  job: JobSummary
): Promise<JobMatch> {
  const prompt = `지원자 프로필과 채용공고를 비교해 적합도를 평가해. JSON으로만 응답.

[지원자]
이름: ${profile.name}
경력: ${profile.experienceYears}
기술: ${profile.skills.join(", ")}
도메인: ${profile.domains.join(", ")}
프로젝트:
${profile.projects.map((p) => `- ${p.name} (${p.role}, ${p.stack.join("/")}) — ${p.summary}`).join("\n")}

소개:
${profile.narrative}

[채용공고]
회사: ${job.company}
제목: ${job.title}
채용유형: ${job.positionType} (${job.experienceYears})
모집직무: ${job.positions.join(", ")}
업무요약: ${job.jdSummary}
자격요건:
${job.qualifications.map((q) => `- ${q}`).join("\n")}

평가 기준:
- 보유 기술/경험과 자격요건의 일치도
- 채용유형과 경력 수준 적합성 (신입공고에 경력 지원자도 매칭 가능하다고 봐)
- 도메인 적합성

JSON 형식:
{
  "matchScore": 0~100 정수,
  "matchVerdict": "추천 / 보통 / 비추천 중 하나",
  "matchStrengths": ["적합한 강점 1-3개"],
  "matchGaps": ["부족한/우려되는 부분 1-3개"],
  "matchReasoning": "한두 문장 종합 평가"
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
    const jsonMatch =
      resultText.match(/```(?:json)?\s*([\s\S]*?)```/) ||
      resultText.match(/(\{[\s\S]*\})/);
    const parsed = JSON.parse(jsonMatch?.[1]?.trim() || "{}");
    const score = clampScore(parsed.matchScore);
    return {
      matchScore: score,
      matchVerdict: normalizeVerdict(parsed.matchVerdict, score),
      matchStrengths: Array.isArray(parsed.matchStrengths)
        ? parsed.matchStrengths.slice(0, 5)
        : [],
      matchGaps: Array.isArray(parsed.matchGaps)
        ? parsed.matchGaps.slice(0, 5)
        : [],
      matchReasoning: parsed.matchReasoning || "",
    };
  } catch {
    return FALLBACK_MATCH;
  }
}
