import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  getJobBySeq,
  getCompanySections,
  getApplicationDraftRow,
  saveApplicationDraft,
} from "./db";
import { getCachedProfile } from "./profile";
import { normalizeCompanyName } from "./company-normalize";
import {
  readApplicantProfile,
  isApplicantProfileFilled,
  type ApplicantProfile,
} from "./applicant-profile";

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

// lib/settings의 ApplicantProfile은 사용자가 직접 적은 "정확한" 데이터라 AI가 다시
// 추론/요약할 필요가 없다 — 있는 그대로 label/value로 펼쳐서 personalFields를 채운다.
// (반대로 essayAnswers는 여전히 AI가 공고에 맞춰 새로 써야 하므로 별도로 생성한다.)
function buildPersonalFieldsFromApplicantProfile(ap: ApplicantProfile): PersonalField[] {
  const fields: PersonalField[] = [
    { label: "이름", value: ap.name },
    { label: "영문이름", value: ap.nameEn },
    { label: "성별", value: ap.gender },
    { label: "생년월일", value: ap.birthDate },
    { label: "국적", value: ap.nationality },
    {
      label: "주소",
      value: [ap.postalCode && `(${ap.postalCode})`, ap.address, ap.addressDetail]
        .filter(Boolean)
        .join(" "),
    },
    { label: "이메일", value: ap.email },
    { label: "연락처", value: ap.phone },
    {
      label: "장애여부",
      value: ap.disabilityStatus === "대상" ? `대상 (${ap.disabilityDetail})` : "비대상",
    },
    {
      label: "보훈여부",
      value: ap.veteranStatus === "대상" ? `대상 (${ap.veteranDetail})` : "비대상",
    },
  ];

  if (ap.militaryStatus) {
    const military =
      ap.militaryStatus === "군필" || ap.militaryStatus === "복무중"
        ? [
            ap.militaryStatus,
            ap.militaryBranch,
            ap.militarySpecialty,
            ap.militaryRank,
            [ap.militaryServiceStart, ap.militaryServiceEnd].filter(Boolean).join("~"),
            ap.militaryDischargeType,
          ]
            .filter(Boolean)
            .join(" / ")
        : ap.militaryStatus;
    fields.push({ label: "병역사항", value: military });
  }

  ap.education.forEach((e, i) => {
    if (!e.schoolName) return;
    const detail = [
      e.schoolLevel,
      e.degreeType,
      e.major && `${e.major}${e.majorTrack ? `(${e.majorTrack})` : ""}`,
      e.status,
      [e.startDate, e.endDate].filter(Boolean).join("~"),
      e.gpa && `학점 ${e.gpa}/${e.gpaMax || "4.5"}`,
    ]
      .filter(Boolean)
      .join(" · ");
    fields.push({ label: `학력 ${i + 1} - ${e.schoolName}`, value: detail });
  });

  ap.workExperiences.forEach((w, i) => {
    if (!w.companyName) return;
    const detail = [
      w.employmentType,
      w.department,
      w.position,
      [w.startDate, w.isCurrent ? "재직중" : w.endDate].filter(Boolean).join("~"),
      w.duties,
    ]
      .filter(Boolean)
      .join(" · ");
    fields.push({ label: `경력 ${i + 1} - ${w.companyName}`, value: detail });
  });

  ap.projects.forEach((p, i) => {
    if (!p.name) return;
    const detail = [
      p.client,
      p.role,
      [p.startDate, p.endDate].filter(Boolean).join("~"),
      p.contributionPercent && `기여도 ${p.contributionPercent}%`,
    ]
      .filter(Boolean)
      .join(" · ");
    fields.push({ label: `프로젝트 ${i + 1} - ${p.name}`, value: detail });
  });

  ap.certifications.forEach((c, i) => {
    if (!c.name) return;
    fields.push({
      label: `자격증 ${i + 1} - ${c.name}`,
      value: [c.issuer, c.issuedDate].filter(Boolean).join(" · "),
    });
  });

  ap.languageTests.forEach((t, i) => {
    if (!t.testName) return;
    fields.push({
      label: `어학시험 ${i + 1} - ${t.testName}`,
      value: `${t.score}/${t.scoreMax} (${t.date})`,
    });
  });

  ap.awards.forEach((a, i) => {
    if (!a.name) return;
    fields.push({
      label: `수상경력 ${i + 1} - ${a.name}`,
      value: [a.organizer, a.date, a.detail].filter(Boolean).join(" · "),
    });
  });

  ap.activities.forEach((a, i) => {
    if (!a.category) return;
    fields.push({
      label: `대외활동 ${i + 1} - ${a.category}`,
      value: [a.organization, a.role, a.detail].filter(Boolean).join(" · "),
    });
  });

  ap.research.forEach((r, i) => {
    if (!r.title) return;
    fields.push({
      label: `연구실적 ${i + 1} - ${r.title}`,
      value: [r.category, r.organizer, r.date].filter(Boolean).join(" · "),
    });
  });

  if (ap.portfolioLinks) fields.push({ label: "온라인 자료", value: ap.portfolioLinks });
  if (ap.skillsNote) fields.push({ label: "활용 가능 도구/언어", value: ap.skillsNote });

  return stripForbiddenFields(fields.filter((f) => f.value));
}

// essayAnswers 프롬프트에 실제 회사명/학교명/기간 같은 구체적 사실을 실어주기 위한 요약.
// personalFields처럼 낱개로 펼치지 않고, 모델이 문장을 자연스럽게 짜 넣을 수 있도록
// 사람이 읽는 요약문 형태로 압축한다.
function summarizeApplicantProfileForPrompt(ap: ApplicantProfile): string {
  const lines: string[] = [];
  if (ap.education.length) {
    lines.push(
      "학력: " +
        ap.education
          .map((e) => `${e.schoolName}(${e.major || e.schoolLevel}, ${e.status})`)
          .join(", ")
    );
  }
  if (ap.workExperiences.length) {
    lines.push(
      "경력: " +
        ap.workExperiences
          .map((w) => `${w.companyName}(${w.position || w.department || w.employmentType})`)
          .join(", ")
    );
  }
  if (ap.projects.length) {
    lines.push("프로젝트: " + ap.projects.map((p) => `${p.name}(${p.role})`).join(", "));
  }
  if (ap.certifications.length) {
    lines.push("자격증: " + ap.certifications.map((c) => c.name).join(", "));
  }
  if (ap.awards.length) {
    lines.push("수상: " + ap.awards.map((a) => a.name).join(", "));
  }
  if (ap.activities.length) {
    lines.push("대외활동: " + ap.activities.map((a) => `${a.category}(${a.role})`).join(", "));
  }
  if (ap.militaryStatus) lines.push(`병역: ${ap.militaryStatus}`);
  return lines.join("\n");
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

  const applicantProfile = readApplicantProfile();
  const applicantFilled = isApplicantProfileFilled(applicantProfile);

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

${
  applicantFilled
    ? `[지원 정보 (사용자가 설정에서 직접 입력, 추론 아님 — essayAnswers에 구체적으로 녹여 써도 됨)]
${summarizeApplicantProfileForPrompt(applicantProfile)}

`
    : ""
}[지원 공고]
회사: ${job.company}
제목: ${job.title}
채용유형: ${job.positionType} (${job.experienceYears})
모집직무: ${job.positions.join(", ")}
업무요약: ${job.jdSummary}
자격요건: ${job.qualifications.join(", ")}

[회사 리서치 참고자료 (있는 경우만, 없으면 무시)]
${sectionText || "(아직 리서치되지 않음)"}

아래 JSON 형식으로만 응답해. 마크다운이나 설명 없이 순수 JSON만.
{${
    applicantFilled
      ? ""
      : `
  "personalFields": [
    {"label": "이름", "value": "..."},
    {"label": "이메일", "value": "..."},
    {"label": "연락처", "value": "..."},
    {"label": "최종학력", "value": "..."},
    {"label": "경력사항 요약", "value": "..."}
  ],`
  }
  "essayAnswers": [
    {"question": "지원동기", "answer": "3-5문장, 회사 리서치 내용을 반영해 구체적으로"},
    {"question": "성장과정/강점", "answer": "..."},
    {"question": "입사 후 포부", "answer": "..."}
  ],
  "notesForUser": ["초안이니 반드시 직접 검토 후 사용하라는 안내"${
    applicantFilled ? "" : ', "프로필에서 확인 안 되는 정보는 직접 채워야 한다는 안내"'
  }]
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

  // 지원 정보가 채워져 있으면 AI가 추측한 personalFields 대신 사용자가 직접 적은 정확한
  // 값으로 통째로 교체한다 — 이름 철자, 학교명, 재직기간 같은 건 AI가 다시 요약할 이유가 없다.
  if (applicantFilled) {
    draft.personalFields = buildPersonalFieldsFromApplicantProfile(applicantProfile);
  }

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
