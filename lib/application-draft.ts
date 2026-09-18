import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  getJobBySeq,
  getCompanySections,
  getApplicationDraftRow,
  saveApplicationDraft,
  type JobWithMatch,
} from "./db";
import { getCachedProfile, type Profile } from "./profile";
import { normalizeCompanyName } from "./company-normalize";
import {
  readApplicantProfile,
  isApplicantProfileFilled,
  type ApplicantProfile,
} from "./applicant-profile";
import { ensureEssayBank, summarizeEssayBankForPrompt } from "./essay-bank";
import { COMMON_ESSAY_QUESTIONS, COMBINED_ESSAY_LABEL } from "./essay-questions";
import {
  readNarrativeProfile,
  isNarrativeProfileFilled,
  summarizeNarrativeForPrompt,
} from "./narrative-profile";

// 자소서는 실제 제출되는 글이라 품질이 중요해서, 회사 리서치와 같은 이유로 Haiku 대신
// Sonnet을 쓴다(비용보다 "이 회사를 잘 모른다"는 인상을 안 주는 게 우선).
const DRAFT_MODEL = "claude-sonnet-4-6";

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

interface DraftContext {
  job: JobWithMatch & { rawContent: string };
  profile: Profile;
  applicantProfile: ApplicantProfile;
  applicantFilled: boolean;
  sectionText: string;
  essayBankText: string;
  narrativeText: string;
}

// generateApplicationDraft와 generateCustomEssayAnswer가 똑같은 배경 정보(이력서/지원정보/
// 공고/회사 리서치/과거 자소서)를 프롬프트에 실어야 해서 조립 로직을 한 곳에 모았다.
async function buildDraftContext(seq: string): Promise<DraftContext | null> {
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

  // cover-letters/ 폴더가 바뀌었으면 여기서 재추출(에이전틱, Sonnet) — 매번 하는 게 아니라
  // sourcesHash가 같으면 캐시를 그대로 반환하므로 평소엔 파일 읽기 한 번뿐이라 저렴하다.
  const essayBank = await ensureEssayBank();
  const essayBankText = summarizeEssayBankForPrompt(essayBank);

  // 순수 파일 읽기라 essayBankText(조건부 AI 재추출)보다도 저렴 — await 불필요.
  const narrativeProfile = readNarrativeProfile();
  const jobKeywords = [job.company, job.positionType, job.jdSummary, ...job.positions, ...job.categories];
  const narrativeText = isNarrativeProfileFilled(narrativeProfile)
    ? summarizeNarrativeForPrompt(narrativeProfile, jobKeywords)
    : "";

  return { job, profile, applicantProfile, applicantFilled, sectionText, essayBankText, narrativeText };
}

function backgroundPromptBlock(ctx: DraftContext): string {
  return `[지원자 프로필]
이름: ${ctx.profile.name}
경력: ${ctx.profile.experienceYears}
기술: ${ctx.profile.skills.join(", ")}
도메인: ${ctx.profile.domains.join(", ")}
프로젝트:
${ctx.profile.projects.map((p) => `- ${p.name} (${p.role}) — ${p.summary}`).join("\n")}
비개발 직군 전이 강점: ${(ctx.profile.transferableStrengths ?? []).join(", ") || "(없음)"}
지원 의도/방향(본인 작성): ${ctx.profile.careerGoals || "(작성 안 함)"}
소개: ${ctx.profile.narrative}

${
  ctx.narrativeText
    ? `[가치관과 동기 — 사용자가 직접 쓴 진짜 생각. 지원동기/성장과정/입사 후 포부는 반드시
이 내용을 실제 근거로 삼아서 써]
${ctx.narrativeText}

`
    : ""
}${
  ctx.applicantFilled
    ? `[지원 정보 (사용자가 설정에서 직접 입력, 추론 아님 — 답변에 구체적으로 녹여 써도 됨)]
${summarizeApplicantProfileForPrompt(ctx.applicantProfile)}

`
    : ""
}[지원 공고]
회사: ${ctx.job.company}
제목: ${ctx.job.title}
채용유형: ${ctx.job.positionType} (${ctx.job.experienceYears})
모집직무: ${ctx.job.positions.join(", ")}
업무요약: ${ctx.job.jdSummary}
자격요건: ${ctx.job.qualifications.join(", ")}

[회사 리서치 참고자료 (있는 경우만, 없으면 무시)]
${ctx.sectionText || "(아직 리서치되지 않음)"}
${
  ctx.essayBankText
    ? `
[과거 자소서 참고자료 — 문체와 자주 쓰는 소재 참고용. 그대로 베끼지 말고 이번 공고에 맞게 재구성해]
${ctx.essayBankText}
`
    : ""
}`;
}

// 이력서 PDF 자체를 다시 읽지 않고 이미 추출된 Profile(구조화된 정보)만 사용한다 —
// lib/profile.ts의 extractProfile()과 달리 원본 PDF 접근 권한이 필요 없고 비용도 훨씬 싸다.
export async function generateApplicationDraft(seq: string): Promise<ApplicationDraft | null> {
  const ctx = await buildDraftContext(seq);
  if (!ctx) return null;

  const commonQuestionsSchema = COMMON_ESSAY_QUESTIONS.map((q) => `    {"question": "${q}", "answer": "..."}`).join(",\n");

  const prompt = `당신은 지원자의 채용 지원서 작성을 돕는 도우미입니다. 아래 정보를 바탕으로 (1) 여러 지원폼에서 반복되는 개인정보 필드 값과 (2) 자소서에서 가장 흔히 묻는 공통 문항들의 답변 초안을 작성해주세요. 실제 공고의 문항 문구는 이것과 다를 수 있지만, 대부분 이 주제들 중 하나로 수렴하니 미리 준비해두는 용도입니다. 이건 초안일 뿐이며 지원자가 반드시 직접 검토·수정 후 사용한다는 전제로, 성실하고 구체적으로 작성해.

${backgroundPromptBlock(ctx)}

아래 JSON 형식으로만 응답해. 마크다운이나 설명 없이 순수 JSON만.
{${
    ctx.applicantFilled
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
${commonQuestionsSchema},
    {"question": "${COMBINED_ESSAY_LABEL}", "answer": "지원동기·장단점·특기사항·입사 후 계획을 한 편의 자연스러운 글로 엮어서, 1000자 이상"}
  ],
  "notesForUser": ["초안이니 반드시 직접 검토 후 사용하라는 안내", "실제 공고 문항이 위와 다르면 '지원 도우미' 탭에서 문항을 직접 붙여넣어 맞춤 초안을 새로 받으라는 안내"${
    ctx.applicantFilled ? "" : ', "프로필에서 확인 안 되는 정보는 직접 채워야 한다는 안내"'
  }]
}

주의:
- 각 essayAnswers 항목은 최소 300자 이상, 구체적 사실(회사 리서치·경력·프로젝트 내용)을 실제로 인용해서 작성해. 뭉뚱그린 일반론 금지.
- 여러 문항에서 같은 에피소드를 반복해서 쓰지 말고, 문항 성격에 맞는 다른 경험을 배분해서 써.
- 프로필에 실제로 없는 정보(생년월일, 주소, 전화번호 등)는 지어내지 말고 값에 "(직접 입력 필요)"라고 써. 주민등록번호/계좌번호/비밀번호 등 민감정보는 personalFields에 절대 포함하지 마.
- 지원 직무/산업이 이력서상 경력·전공과 거리가 있다면, 스킬을 억지로 끼워맞추지 말고 [가치관과 동기] 자료에 있는 진짜 이유로 "왜 이 회사/직무인가"를 자연스럽게 설명해.`;

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
  if (ctx.applicantFilled) {
    draft.personalFields = buildPersonalFieldsFromApplicantProfile(ctx.applicantProfile);
  }

  saveApplicationDraft(seq, JSON.stringify(draft), DRAFT_MODEL);
  return draft;
}

// 실제 폼/첨부양식의 정확한 문항 문구를 사용자가 붙여넣었을 때, 그 문항 하나에 맞춘 답변만
// 새로 생성한다. 공통 문항 세트(generateApplicationDraft)와 같은 배경 정보를 쓰되 훨씬
// 저렴한 단발 호출 — 공고당 문항이 몇 개 안 되니 매번 전체 초안을 다시 만들 필요는 없다.
export async function generateCustomEssayAnswer(
  seq: string,
  question: string
): Promise<EssayAnswer | null> {
  const ctx = await buildDraftContext(seq);
  if (!ctx) return null;

  const prompt = `당신은 지원자의 채용 지원서 작성을 돕는 도우미입니다. 아래 배경 정보를 바탕으로, 실제 지원폼에 있는 아래 문항에 대한 답변 초안을 작성해줘. 지원자가 반드시 직접 검토·수정 후 사용한다는 전제로, 성실하고 구체적으로(최소 300자, 구체적 사실을 인용해서) 작성해.

${backgroundPromptBlock(ctx)}

[답변해야 할 문항 — 실제 지원폼에 적힌 문구 그대로]
"${question}"

문항 텍스트만 보고 판단해서(글자수 제한이 명시돼 있으면 그에 맞춰서, "자유롭게 기술" 같은 통합형이면 여러 주제를 자연스럽게 엮어서) 답변 텍스트만 작성해. 지원 직무/산업이 이력서상 경력·전공과 거리가 있다면, 스킬을 억지로 끼워맞추지 말고 [가치관과 동기] 자료에 있는 진짜 이유로 자연스럽게 연결해. JSON이나 설명 없이 답변 본문만 출력해.`;

  let resultText = "";
  try {
    for await (const message of query({
      prompt,
      options: { model: DRAFT_MODEL, maxTurns: 1, allowedTools: [] },
    })) {
      if ("result" in message) resultText = message.result;
    }
  } catch (e) {
    console.error("[application-draft] 맞춤 문항 답변 생성 실패:", e);
    return null;
  }

  const answer = resultText.trim();
  if (!answer) return null;

  // 이 문항도 기존 초안(있으면)에 이어붙여서 저장 — 다음에 지원 도우미 탭을 열어도 그대로
  // 보임. 아직 공통 문항 초안을 만든 적이 없어도(existing이 없어도) 이 답변만으로 새 초안을
  // 만들어 저장한다 — 커스텀 문항만 물어보고 끝내는 흐름에서도 유실되지 않게.
  const existing = getCachedApplicationDraft(seq);
  const newAnswer: EssayAnswer = { question, answer };
  const nextDraft: ApplicationDraft = existing
    ? {
        ...existing,
        essayAnswers: [
          ...existing.essayAnswers.filter((a) => a.question !== question),
          newAnswer,
        ],
      }
    : {
        seq,
        personalFields: ctx.applicantFilled
          ? buildPersonalFieldsFromApplicantProfile(ctx.applicantProfile)
          : [],
        essayAnswers: [newAnswer],
        notesForUser: [],
        model: DRAFT_MODEL,
        generatedAt: Date.now(),
      };
  saveApplicationDraft(seq, JSON.stringify(nextDraft), DRAFT_MODEL);

  return newAnswer;
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
