import { readNarrativeProfile, writeCoreNarrative, appendNarrativeEpisode } from "@/lib/narrative-profile";

// 설정 페이지 "핵심 가치관/성장 서사" 탭 조회 — AI 호출 없음.
export async function GET() {
  return Response.json({ profile: readNarrativeProfile() });
}

// core(고정 4필드) 전체교체 저장.
export async function PUT(request: Request) {
  const { coreValues, workCriteria, futureDirection, opennessToNewFields } = await request.json();
  if (
    typeof coreValues !== "string" ||
    typeof workCriteria !== "string" ||
    typeof futureDirection !== "string" ||
    typeof opennessToNewFields !== "string"
  ) {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  writeCoreNarrative({ coreValues, workCriteria, futureDirection, opennessToNewFields });
  return Response.json({ profile: readNarrativeProfile() });
}

// 시드 질문 답변 또는 "경험 추가"로 새 episode 하나 저장.
export async function POST(request: Request) {
  const body = await request.json();
  if (
    typeof body.situation !== "string" ||
    typeof body.reasoning !== "string" ||
    (!body.situation.trim() && !body.reasoning.trim())
  ) {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  appendNarrativeEpisode({
    promptId: typeof body.promptId === "string" ? body.promptId : "",
    prompt: typeof body.prompt === "string" ? body.prompt : "",
    title: typeof body.title === "string" ? body.title : "",
    situation: body.situation,
    reasoning: body.reasoning,
    lesson: typeof body.lesson === "string" ? body.lesson : "",
    tags: Array.isArray(body.tags) ? body.tags : [],
    source: body.source === "seed" || body.source === "added" ? body.source : "added",
  });
  return Response.json({ profile: readNarrativeProfile() });
}
