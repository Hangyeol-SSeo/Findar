import { generateCustomEssayAnswer } from "@/lib/application-draft";

// 실제 폼/첨부양식에 적힌 정확한 문항 문구를 붙여넣으면 그 문항 하나에 맞춘 답변만 생성.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ seq: string }> }
) {
  const { seq } = await params;
  const { question } = await request.json();
  if (!question || typeof question !== "string" || !question.trim()) {
    return Response.json({ error: "문항을 입력해주세요." }, { status: 400 });
  }
  const answer = await generateCustomEssayAnswer(seq, question.trim());
  if (!answer) {
    return Response.json(
      { error: "이력서 프로필 또는 공고 정보를 찾을 수 없습니다." },
      { status: 400 }
    );
  }
  return Response.json({ answer });
}
