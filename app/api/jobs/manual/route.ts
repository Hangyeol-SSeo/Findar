import { getJobBySeq } from "@/lib/db";
import { isManualSeq, validateManualJobInput } from "@/lib/manual-jobs";
import { ManualJobError, saveManualJob } from "@/lib/manual-job-save";
import { isSameOrigin } from "@/lib/request-origin";

// 직접 추가한 공고 하나를 수정 화면에 채울 값. 목록 응답에는 본문(rawContent)이 없어서 따로 읽는다.
export async function GET(request: Request) {
  const seq = new URL(request.url).searchParams.get("seq") ?? "";
  const job = isManualSeq(seq) ? getJobBySeq(seq) : undefined;
  if (!job) return Response.json({ error: "직접 추가한 공고를 찾지 못했습니다." }, { status: 404 });
  return Response.json(
    { seq: job.seq, company: job.company, title: job.title, url: job.siteUrl, deadline: job.deadline, content: job.rawContent },
    { headers: { "Cache-Control": "no-store" } }
  );
}

// {company, title, url, deadline, content} → 새 공고. seq를 함께 보내면 그 직접 추가 공고를 고친다.
// 저장하면서 요약·매칭을 한 건 돌리므로 몇 초~수십 초 걸린다.
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const validation = validateManualJobInput(body);
  if (!validation.ok) return Response.json({ error: validation.error }, { status: 400 });
  const seq = typeof body?.seq === "string" && body.seq ? body.seq : undefined;
  try {
    return Response.json(await saveManualJob(validation.input, seq));
  } catch (error) {
    if (error instanceof ManualJobError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
