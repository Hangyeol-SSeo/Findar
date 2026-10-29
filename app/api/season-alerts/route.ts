import { after } from "next/server";
import { dismissSeasonAlert, getSeasonChecks } from "@/lib/db";
import { activeSeasonAlerts, isHiringSeason, isSeasonCheckRunning, runSeasonCheck, seasonLabel, seasonTargets } from "@/lib/hiring-season";
import { isSameOrigin } from "@/lib/request-origin";
import type { SeasonAlertsResponse } from "@/lib/season-alert-types";

// 공채 시즌 알림(lib/hiring-season.ts). 확인 자체는 공고 새로고침 뒤에 백그라운드로 돌고(GET /api/jobs), 여기서는 결과를 읽는다.
export async function GET() {
  const now = new Date();
  const targets = new Set(seasonTargets().map((c) => c.name));
  const checks = getSeasonChecks().filter((check) => targets.has(check.company));
  const body: SeasonAlertsResponse = {
    inSeason: isHiringSeason(now),
    season: seasonLabel(now),
    running: isSeasonCheckRunning(),
    targetCount: targets.size,
    checkedCount: checks.length,
    lastCheckedAt: checks.reduce((max, check) => Math.max(max, check.checkedAt), 0) || null,
    alerts: activeSeasonAlerts(now).map(({ id, company, title, deadline, recruitUrl, articleUrl, evidence, foundAt }) => ({ id, company, title, deadline, recruitUrl, articleUrl, evidence, foundAt })),
  };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}

// {action: "dismiss", id} 알림 닫기, {action: "check"} 시즌·간격과 상관없이 지금 전부 확인(웹 검색 비용이 든다).
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const body = await request.json().catch(() => null) as { action?: unknown; id?: unknown } | null;
  if (body?.action === "dismiss" && typeof body.id === "number") {
    if (!dismissSeasonAlert(body.id)) return Response.json({ error: "알림을 찾지 못했습니다." }, { status: 404 });
    return Response.json({ ok: true });
  }
  if (body?.action === "check") {
    after(() => runSeasonCheck({ force: true }).then((result) => console.info("[hiring-season] 수동 확인", JSON.stringify(result))));
    return Response.json({ ok: true, started: true });
  }
  return Response.json({ error: "알 수 없는 요청입니다." }, { status: 400 });
}
