import { clearWatchRuns, getWatchRuns } from "@/lib/db";
import { WATCH_SOURCE_LABELS, isCollectable, readWatchlist, setWatchCompanyEnabled } from "@/lib/company-watchlist";
import type { WatchlistResponse } from "@/lib/watchlist-types";
import { isSameOrigin } from "@/lib/request-origin";

// 설정 → 수집 범위. 감시 목록과 출처별 마지막 확인 결과(watch_runs). 수집 자체는 공고 새로고침(GET /api/jobs)이 한다.
export async function GET() {
  const runs = new Map(getWatchRuns().map((run) => [`${run.company}\n${run.sourceUrl}`, run]));
  const body: WatchlistResponse = {
    companies: readWatchlist().companies.map((company) => ({
      name: company.name,
      segment: company.segment,
      enabled: company.enabled,
      sources: company.sources.map((source) => {
        const run = runs.get(`${company.name}\n${source.url}`);
        return {
          type: source.type,
          label: WATCH_SOURCE_LABELS[source.type],
          url: source.url,
          note: source.note ?? "",
          collectable: isCollectable(source.type),
          lastRun: run ? { status: run.status, message: run.message, found: run.found, added: run.added, ranAt: run.ranAt } : null,
        };
      }),
    })),
  };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}

// {name, enabled} 회사 켜기/끄기, {name, recheck: true} 다음 공고 새로고침 때 바로 다시 확인.
export async function PATCH(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "Findar 화면에서 요청해주세요." }, { status: 403 });
  const body = await request.json().catch(() => null) as { name?: unknown; enabled?: unknown; recheck?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name : "";
  if (!name) return Response.json({ error: "회사를 지정해주세요." }, { status: 400 });
  if (typeof body?.enabled === "boolean") {
    if (!setWatchCompanyEnabled(name, body.enabled)) return Response.json({ error: "감시 목록에 없는 회사입니다." }, { status: 404 });
  }
  if (body?.recheck === true) clearWatchRuns(name);
  return Response.json({ ok: true });
}
