// 직접 추가한 공고(금융투자협회 게시판에 올라오지 않는 공채·자체 채용 사이트 공고 등).
// KOFIA 공고와 같은 jobs 테이블에 들어가지만 seq가 "manual-"로 시작한다 — KOFIA seq는 숫자뿐이라 겹치지 않고,
// 크롤러의 upsertJob은 KOFIA seq만 건드리므로 재크롤링이 덮어쓰지 않는다. AI 없음(클라이언트에서도 쓴다).

export const MANUAL_SEQ_PREFIX = "manual-";
export const MANUAL_JOB_LIMITS = { company: 100, title: 300, url: 2000, content: 30_000 } as const;

// 본문이 이미지인 공고. 브라우저가 이미지를 이 크기 조각으로 잘라 보내고(세로로 긴 공고 이미지는 모델의 이미지 크기 제한을 넘는다),
// 서버가 조각을 순서대로 판독해 본문 칸에 글자로 채운다(lib/posting-image-text.ts). 이미지는 저장하지 않는다.
export const POSTING_IMAGE_LIMITS = { slices: 20, sliceHeight: 2000, maxWidth: 1600, overlap: 60 } as const;

export function isManualSeq(seq: string): boolean {
  return seq.startsWith(MANUAL_SEQ_PREFIX);
}

export interface ManualJobInput {
  company: string;
  title: string;
  url: string;
  deadline: string; // YYYY-MM-DD 또는 빈 문자열(본문에서 AI가 찾는다)
  content: string;
}

export type ManualJobValidation = { ok: true; input: ManualJobInput } | { ok: false; error: string };

export function validateManualJobInput(body: unknown): ManualJobValidation {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const text = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string).trim() : "");
  const input: ManualJobInput = {
    company: text("company").replace(/\s+/g, " "),
    title: text("title").replace(/\s+/g, " "),
    url: text("url"),
    deadline: text("deadline"),
    content: text("content"),
  };
  if (!input.company) return { ok: false, error: "회사명을 입력해주세요." };
  if (!input.title) return { ok: false, error: "공고 제목을 입력해주세요." };
  if (!input.content) return { ok: false, error: "공고 본문을 붙여 넣어주세요. 링크에서 읽어 오지 못했다면 채용 사이트의 본문을 복사해 넣으면 됩니다." };
  for (const key of ["company", "title", "url", "content"] as const) {
    if (input[key].length > MANUAL_JOB_LIMITS[key]) {
      return { ok: false, error: `${FIELD_LABELS[key]}은(는) ${MANUAL_JOB_LIMITS[key].toLocaleString()}자까지 입력할 수 있습니다.` };
    }
  }
  if (input.url) {
    try {
      const url = new URL(input.url);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("protocol");
      input.url = url.toString();
    } catch {
      return { ok: false, error: "공고 링크는 http(s)로 시작하는 주소여야 합니다." };
    }
  }
  if (input.deadline && !isValidYmd(input.deadline)) return { ok: false, error: "마감일은 YYYY-MM-DD 형식으로 입력해주세요." };
  return { ok: true, input };
}

const FIELD_LABELS = { company: "회사명", title: "공고 제목", url: "공고 링크", content: "공고 본문" } as const;

function isValidYmd(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
