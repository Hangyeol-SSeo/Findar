import { fetchPublicPage } from "@/lib/research-page-tool";
import { contentImages, fetchImage } from "@/lib/company-homepage";
import { isSameOrigin } from "@/lib/request-origin";
import { MANUAL_JOB_LIMITS } from "@/lib/manual-jobs";

// 공고 직접 추가 화면의 "링크에서 본문 읽기". 사용자가 적은 공개 주소 한 곳을 서버가 한 번 읽어 본문 후보를 돌려준다(AI 없음).
// 본문 영역의 이미지(국내 공고는 본문 전체가 이미지인 경우가 많다)도 내려받아 함께 돌려주고, 글자 판독은 화면이
// 이미지를 잘라 /api/jobs/manual/images로 따로 요청한다. 자체 채용 사이트는 대부분 화면을 스크립트로 그려서 본문이
// 비어 온다 — 그때는 사용자가 본문을 붙여 넣거나 캡처 이미지를 넣는다. 봇 차단·로그인 페이지는 우회하지 않는다.
const MIN_TEXT = 200;
const MAX_IMAGES = 8;
const IMAGE_TIMEOUT_MS = 20_000;
// 세로로 긴 공고 이미지(860×9000 같은)도 받는다. 자르는 건 화면이 한다.
const IMAGE_LIMITS = { maxSide: 30_000, maxBytes: 15_000_000 };

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json().catch(() => null) as { url?: unknown } | null;
  if (typeof body?.url !== "string" || !body.url.trim()) return Response.json({ error: "공고 링크를 입력해주세요." }, { status: 400 });
  const page = await fetchPublicPage(body.url, { textLimit: MANUAL_JOB_LIMITS.content });
  if (!page.ok) {
    const reason = page.kind === "pdf" ? "PDF 공고는 읽지 못합니다" : page.reason;
    return Response.json({ ok: false, reason: `${reason}. 채용 사이트에서 본문을 복사해 붙여 넣거나 공고 이미지를 넣어주세요.` });
  }
  const candidates = contentImages(page.html, page.url).slice(0, MAX_IMAGES);
  const images = (await Promise.all(candidates.map(async ({ url }) => {
    const image = await fetchImage(url, fetch, IMAGE_TIMEOUT_MS, IMAGE_LIMITS);
    return image ? { url, ...image } : null;
  }))).filter((image) => image !== null);
  const text = page.text.length >= MIN_TEXT ? page.text : "";
  if (!text && !images.length) {
    return Response.json({
      ok: false, url: page.url, title: page.title,
      reason: "페이지에서 본문 글자나 이미지를 찾지 못했습니다(화면을 스크립트로 그리는 채용 사이트일 수 있습니다). 채용 사이트에서 본문을 복사해 붙여 넣거나, 공고 화면을 캡처해 이미지로 넣어주세요.",
    });
  }
  return Response.json({ ok: true, url: page.url, title: page.title, text, images, notes: page.notes });
}
