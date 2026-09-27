import { after } from "next/server";
import { isSameOrigin } from "@/lib/request-origin";
import { getJobBySeq } from "@/lib/db";
import { evaluateResumeTailoring, getCachedTailoring } from "@/lib/resume-tailoring";
import { createApplicationTask, executeApplicationTask } from "@/lib/application-tasks";
import { listResumeFiles } from "@/lib/resume-files";
import { isApplicantProfileFilled, readApplicantProfile } from "@/lib/applicant-profile";

export const runtime = "nodejs";
export const maxDuration = 900;

// 캐시된 평가 결과만 돌려준다 — AI 호출 없음.
export async function GET(_request: Request, { params }: { params: Promise<{ seq: string }> }) {
  const { seq } = await params;
  if (!getJobBySeq(seq)) return Response.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  return Response.json(
    {
      ...getCachedTailoring(seq),
      hasResume: listResumeFiles().length > 0,
      hasApplicantProfile: isApplicantProfileFilled(readApplicantProfile()),
    },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}

// 평가는 수 분 걸릴 수 있어(첫 실행 시 이력서 항목 추출 포함) 서버 백그라운드 작업으로 돌리고,
// 진행 상태는 기존 /api/applications/[seq]/tasks 폴링으로 확인한다 — 탭을 옮겨도 끊기지 않는다.
export async function POST(request: Request, { params }: { params: Promise<{ seq: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const { seq } = await params;
  if (!getJobBySeq(seq)) return Response.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  if (listResumeFiles().length === 0 && !isApplicantProfileFilled(readApplicantProfile()))
    return Response.json({ error: "평가할 이력이 없습니다. 설정에서 이력서를 올리거나 지원 정보를 먼저 입력해주세요." }, { status: 400 });
  try {
    const task = createApplicationTask(seq, "tailoring", 2);
    after(() => executeApplicationTask(task.id, async (progress) => {
      await evaluateResumeTailoring(seq, progress);
      return {};
    }));
    return Response.json({ task }, { status: 202 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "평가를 시작하지 못했습니다." }, { status: 409 });
  }
}
