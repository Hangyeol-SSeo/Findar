import { getJobBySeq } from "@/lib/db";
import { essayContextDocument } from "@/lib/essay-review";
import { companyResearchNotice } from "@/lib/company-research";
import { normalizeCompanyName } from "@/lib/company-normalize";

// 대화 세션에서 자기소개서를 쓸 때 읽는 자료 한 덩어리(마크다운 텍스트). AI 호출 없음.
export async function GET(request: Request, { params }: { params: Promise<{ seq: string }> }) {
  const { seq } = await params;
  const job = getJobBySeq(seq);
  if (!job) return new Response("공고를 찾을 수 없습니다.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const text = essayContextDocument(seq, { baseUrl: new URL(request.url).origin, researchNotice: companyResearchNotice(normalizeCompanyName(job.company)) });
  return new Response(text, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "private, no-store" } });
}
