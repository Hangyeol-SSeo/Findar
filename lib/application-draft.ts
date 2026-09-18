import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  getJobBySeq,
  getCompanySections,
  getApplicationDraftRow,
  saveApplicationDraft,
} from "./db";
import { getCachedProfile } from "./profile";
import { normalizeCompanyName } from "./company-normalize";

const DRAFT_MODEL = "claude-haiku-4-5-20251001";

export interface PersonalField {
  label: string;
  value: string;
}

export interface EssayAnswer {
  question: string;
  answer: string;
}

export interface ApplicationDraft {
  seq: string;
  personalFields: PersonalField[];
  essayAnswers: EssayAnswer[];
  notesForUser: string[];
  model: string;
  generatedAt: number;
}

// 모델이 실수로 생성하더라도 자동 입력 후보에 절대 올리면 안 되는 민감정보.
// 이런 필드가 실제 지원폼에 있으면 초안에 넣지 않고 사용자가 직접 채우게 둔다(설계상 의도적).
const FORBIDDEN_FIELD_KEYWORDS = [
  "주민등록번호",
  "주민번호",
  "계좌번호",
  "카드번호",
  "비밀번호",
  "여권번호",
];

function stripForbiddenFields(fields: PersonalField[]): PersonalField[] {
  return fields.filter((f) => !FORBIDDEN_FIELD_KEYWORDS.some((kw) => f.label.includes(kw)));
}

function parseDraft(seq: string, resultText: string): ApplicationDraft | null {
  try {
    const jsonMatch =
      resultText.match(/```(?:json)?\s*([\s\S]*?)```/) || resultText.match(/(\{[\s\S]*\})/);
    const parsed = JSON.parse(jsonMatch?.[1]?.trim() || "{}");
    return {
      seq,
      personalFields: stripForbiddenFields(
        Array.isArray(parsed.personalFields) ? parsed.personalFields : []
      ),
      essayAnswers: Array.isArray(parsed.essayAnswers) ? parsed.essayAnswers : [],
      notesForUser: Array.isArray(parsed.notesForUser) ? parsed.notesForUser : [],
      model: DRAFT_MODEL,
      generatedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

// 이력서 PDF 자체를 다시 읽지 않고 이미 추출된 Profile(구조화된 정보)만 사용한다 —
// lib/profile.ts의 extractProfile()과 달리 원본 PDF 접근 권한이 필요 없고 비용도 훨씬 싸다.
export async function generateApplicationDraft(seq: string): Promise<ApplicationDraft | null> {
  const job = getJobBySeq(seq);
  if (!job) return null;

  const profile = getCachedProfile();
  if (!profile) return null; // 프로필이 없으면 초안을 만들 재료가 없다 (이력서 먼저 필요)

  const normalizedName = normalizeCompanyName(job.company);
  const sections = getCompanySections(normalizedName);
  const sectionText = sections
    .filter((s) => s.status !== "failed" && s.content)
    .map((s) => `[${s.sectionType}] ${s.content}`)
    .join("\n\n");

  const prompt = `당신은 지원자의 채용 지원서 작성을 돕는 도우미입니다. 아래 정보를 바탕으로 (1) 여러 지원폼에서 반복되는 개인정보 필드 값과 (2) 자주 나오는 자기소개 항목 답변 초안을 작성해주세요. 이건 초안일 뿐이며 지원자가 반드시 직접 검토·수정 후 사용한다는 전제로, 성실하고 구체적으로 작성해.

[지원자 프로필]
이름: ${profile.name}
경력: ${profile.experienceYears}
기술: ${profile.skills.join(", ")}
도메인: ${profile.domains.join(", ")}
프로젝트:
${profile.projects.map((p) => `- ${p.name} (${p.role}) — ${p.summary}`).join("\n")}
비개발 직군 전이 강점: ${(profile.transferableStrengths ?? []).join(", ") || "(없음)"}
지원 의도/방향(본인 작성): ${profile.careerGoals || "(작성 안 함)"}
소개: ${profile.narrative}

[지원 공고]
회사: ${job.company}
제목: ${job.title}
채용유형: ${job.positionType} (${job.experienceYears})
모집직무: ${job.positions.join(", ")}
업무요약: ${job.jdSummary}
자격요건: ${job.qualifications.join(", ")}

[회사 리서치 참고자료 (있는 경우만, 없으면 무시)]
${sectionText || "(아직 리서치되지 않음)"}

아래 JSON 형식으로만 응답해. 마크다운이나 설명 없이 순수 JSON만.
{
  "personalFields": [
    {"label": "이름", "value": "..."},
    {"label": "이메일", "value": "..."},
    {"label": "연락처", "value": "..."},
    {"label": "최종학력", "value": "..."},
    {"label": "경력사항 요약", "value": "..."}
  ],
  "essayAnswers": [
    {"question": "지원동기", "answer": "3-5문장, 회사 리서치 내용을 반영해 구체적으로"},
    {"question": "성장과정/강점", "answer": "..."},
    {"question": "입사 후 포부", "answer": "..."}
  ],
  "notesForUser": ["초안이니 반드시 직접 검토 후 사용하라는 안내, 프로필에서 확인 안 되는 정보는 직접 채워야 한다는 안내 등"]
}

주의: 프로필에 실제로 없는 정보(생년월일, 주소, 전화번호 등)는 지어내지 말고 값에 "(직접 입력 필요)"라고 써. 주민등록번호/계좌번호/비밀번호 등 민감정보는 personalFields에 절대 포함하지 마.`;

  let resultText = "";
  try {
    for await (const message of query({
      prompt,
      options: { model: DRAFT_MODEL, maxTurns: 1, allowedTools: [] },
    })) {
      if ("result" in message) resultText = message.result;
    }
  } catch (e) {
    console.error("[application-draft] 초안 생성 호출 실패:", e);
    return null;
  }

  const draft = parseDraft(seq, resultText);
  if (!draft) return null;

  saveApplicationDraft(seq, JSON.stringify(draft), DRAFT_MODEL);
  return draft;
}

export function getCachedApplicationDraft(seq: string): ApplicationDraft | null {
  const row = getApplicationDraftRow(seq);
  if (!row) return null;
  try {
    return JSON.parse(row.draftJson) as ApplicationDraft;
  } catch {
    return null;
  }
}
