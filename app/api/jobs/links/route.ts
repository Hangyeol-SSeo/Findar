import { clearWatchRuns, getJobBySeq, getJobLinksFor, separateJobLink } from "@/lib/db";
import { isSameOrigin } from "@/lib/request-origin";

// 다른 출처의 같은 공고로 묶인 연결(job_links). 공고 상세가 "같은 공고" 목록과 "중복 아님" 버튼에 쓴다.
export async function GET(request: Request) {
  const seq = new URL(request.url).searchParams.get("seq") ?? "";
  const links = getJobLinksFor(seq).map((link) => {
    const otherSeq = link.seq === seq ? link.canonicalSeq : link.seq;
    const other = getJobBySeq(otherSeq);
    return { seq: link.seq, otherSeq, title: other?.title ?? link.title, url: other?.siteUrl || link.url, reason: link.reason };
  });
  return Response.json({ links }, { headers: { "Cache-Control": "no-store" } });
}

// {seq}: 이 연결을 푼다(seq는 job_links.seq, 목록에서 빠졌던 쪽). 저장 안 된 채용 사이트 공고였으면
// 그 회사 출처의 확인 기록을 지워 다음 새로고침 때 공고를 받아 오게 한다.
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const body = await request.json().catch(() => null) as { seq?: unknown } | null;
  const seq = typeof body?.seq === "string" ? body.seq : "";
  const link = seq ? separateJobLink(seq) : undefined;
  if (!link) return Response.json({ error: "연결을 찾지 못했습니다." }, { status: 404 });
  const stored = getJobBySeq(link.seq);
  if (!stored) {
    const canonical = getJobBySeq(link.canonicalSeq);
    if (canonical) clearWatchRuns(canonical.company);
  }
  return Response.json({ ok: true, stored: !!stored });
}
