// KOFIA 공고는 실제로는 "웹 지원폼"보다 "첨부 양식(hwp/docx) 작성 후 이메일 제출"이
// 훨씬 흔하다(실제 크롤링 데이터로 확인). AI 호출 없이 이미 크롤링된 attachments/본문
// 텍스트만으로 저렴하게 추정하는 휴리스틱 — 완벽한 판별이 아니라 사용자에게 "이런 것
// 같다"는 힌트를 보여주기 위한 용도이므로 다소 느슨해도 된다.
export interface Attachment {
  name: string;
  url: string;
}

export type SubmissionMethod = "email_attachment" | "web_form" | "unknown";

export interface SubmissionMethodInfo {
  method: SubmissionMethod;
  submissionEmail: string | null;
  templateAttachments: Attachment[]; // 입사지원서/자기소개서 등 작성해서 제출해야 하는 양식
  consentAttachments: Attachment[]; // 개인정보 수집·이용 동의서 등 서명만 하면 되는 첨부
}

const TEMPLATE_NAME_PATTERN = /입사지원|지원서|이력서.*양식|자기소개서.*양식|application.*form/i;
const CONSENT_NAME_PATTERN = /개인정보.*(동의서|수집|활용)/i;
const TEMPLATE_EXTENSION_PATTERN = /\.(docx?|hwpx?|pdf)$/i;
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

export function detectSubmissionMethod(
  attachments: Attachment[],
  rawContent: string,
  siteUrl: string
): SubmissionMethodInfo {
  const templateAttachments: Attachment[] = [];
  const consentAttachments: Attachment[] = [];

  for (const att of attachments) {
    if (!TEMPLATE_EXTENSION_PATTERN.test(att.name)) continue;
    // "입사지원서 및 개인정보동의서.doc"처럼 한 파일에 둘 다 포함된 경우가 흔해서,
    // 더 중요한(직접 작성해야 하는) 지원서 쪽 판정을 동의서보다 우선한다.
    if (TEMPLATE_NAME_PATTERN.test(att.name)) {
      templateAttachments.push(att);
    } else if (CONSENT_NAME_PATTERN.test(att.name)) {
      consentAttachments.push(att);
    }
  }

  const emailMatch = rawContent.match(EMAIL_PATTERN);
  const submissionEmail = emailMatch ? emailMatch[0] : null;

  let method: SubmissionMethod = "unknown";
  if (submissionEmail || templateAttachments.length > 0) {
    method = "email_attachment";
  } else if (siteUrl) {
    method = "web_form";
  }

  return { method, submissionEmail, templateAttachments, consentAttachments };
}
