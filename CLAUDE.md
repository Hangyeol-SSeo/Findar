@AGENTS.md

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Stack & commands

- **Next.js 16.2.2 (App Router) + React 19 + TypeScript + Tailwind v4.** Next 16 has breaking changes vs. earlier versions — see `AGENTS.md` and consult `node_modules/next/dist/docs/` before changing routing, server APIs, or config.
- `npm run dev` — start dev server (http://localhost:3000)
- `npm run build` / `npm run start` — production build & serve
- `npm run lint` — ESLint (flat config in `eslint.config.mjs`, extends `eslint-config-next`)
- No test runner is configured.
- Path alias: `@/*` → repo root (e.g. `@/lib/crawler`).

## Architecture

Findar scrapes the KOFIA (금융투자협회) member-firm job board and presents AI-summarized listings. The system is a **three-stage pipeline** exposed as one streaming endpoint.

### Data flow: `app/api/jobs/route.ts` (GET `/api/jobs`)

The route either returns a cached JSON payload (`{ jobs, fromCache: true }`) or streams a **Server-Sent Events** response running the pipeline:

1. **List crawl** (`lib/crawler.ts` `fetchListPage`) — paginates `kofia.or.kr/brd/m_96/list.do`, emits `crawl-list` events.
2. **Detail crawl** (`fetchDetailPage`) — fetches each job's view page, parsing the cheerio table for company/title/dates/site URL/attachments/content. Emits `crawl-detail` per item.
3. **AI summarization** (`lib/summarizer.ts` `summarizeJob`) — calls `@anthropic-ai/claude-agent-sdk`'s `query()` with a JSON-only prompt that classifies into a fixed `CATEGORIES` list and extracts `positionType`, `experienceYears`, `positions`, `qualifications`, `deadline`, `jdSummary`. Emits `summarize-progress` events that include the just-finished `job`, so the client appends results live.

A 1000 ms `sleep` separates every outbound HTTP request (both list-page and detail-page fetches) to avoid hammering KOFIA — preserve this when editing the crawler.

The full summarized array is written to cache only after the loop completes (`setCache(CACHE_KEY, summarized)` then `send({ type: "done", jobs })`).

### Cache: `lib/cache.ts`

File-based JSON cache at `.cache/jobs.json` (gitignored), 18 h TTL. Synchronous `fs` reads/writes on every call. The cache stores the **final summarized list only** — partial progress is not persisted, so an interrupted run starts over. Use `?refresh=true` to bypass.

### Config: `lib/config.ts`

Single knob: `CRAWL_PAGES` (currently 5, 10 jobs per page). Imported by both the API route and the client (`components/JobBoard.tsx`) so they stay in sync. The route also accepts `?pages=N` (clamped to 15).

### Client: `components/JobBoard.tsx` + `app/page.tsx`

`app/page.tsx` dynamically imports `JobBoard` with `ssr: false` (the board is fully client-side). The board:
- Branches on `Content-Type`: `application/json` → cache hit, parse and done. Otherwise treat the body as SSE.
- Manually parses SSE frames (`data: ...\n\n`) from `res.body.getReader()`.
- Appends each `summarize-progress.job` to `jobs` state for live rendering; final `done` event replaces the array.
- Holds an `AbortController` ref so a new `fetchJobs` cancels the previous stream.
- Builds the `직군` filter chip set dynamically from `job.categories` — adding a new category in `summarizer.ts` automatically surfaces it.

## Conventions specific to this repo

- **Korean UI strings stay in Korean** (titles, badges, status messages, filter labels).
- The `CATEGORIES` whitelist in `lib/summarizer.ts` is the source of truth for job categorization. If the AI returns anything outside it (or empty), the code falls back to `"기타"` — don't remove that fallback.
- Summarizer prompt truncates `job.content` to 2000 chars to keep token use bounded. Increasing this is a meaningful cost change.
- Failure mode for summarization is **degraded entries** (`positionType: "미분류"`, `jdSummary: "요약 실패"`), not dropped jobs — preserve this in both `summarizer.ts` and the route's catch block.
