import { parsePostingImages, transcribePostingImages } from "@/lib/posting-image-text";
import { isSameOrigin } from "@/lib/request-origin";

// 공고 직접 추가의 "이미지에서 글자 읽기". {images: [{data: base64}]}(브라우저가 잘라 보낸 조각, 위에서 아래 순서)를
// 한 번의 AI 호출로 판독해 {text}를 돌려준다. 이미지는 저장하지 않는다. 결과는 저장 전에 사용자가 본문 칸에서 확인한다.
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "Forbidden" }, { status: 403 });
  const parsed = parsePostingImages(await request.json().catch(() => null));
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  try {
    return Response.json({ text: await transcribePostingImages(parsed.images) });
  } catch (error) {
    console.error("[manual-job] 공고 이미지 판독 실패:", error);
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: `이미지에서 글자를 읽지 못했습니다: ${message}` }, { status: 502 });
  }
}
