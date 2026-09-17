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

Findar scrapes the KOFIA (금융투자협회) member-firm job board, AI-summarizes and matches postings against the user's resume, does on-demand deep research on the hiring company, and drafts application content. Persistence is **SQLite via `better-sqlite3`** (`lib/db.ts`, file at `data/findar.db`) — there is no file-based JSON cache anymore (an older `lib/cache.ts` was fully replaced; `lib/db.ts` still has a one-time `migrateLegacyCache()` importer for the legacy `.cache/jobs.json` shape, but that file doesn't exist in a fresh checkout).

### Job pipeline: `app/api/jobs/route.ts` (GET `/api/jobs`)

Always streams **Server-Sent Events** (`data: {...}\n\n` frames) — there is no non-streaming JSON response mode. Query params: `pages` (default `CRAWL_PAGES`, clamped to 50 — not 15), `match` (`"false"` disables matching).

1. Sends `{type:"cached", jobs}` immediately from `getActiveJobs()` so the UI isn't blank while crawling starts.
2. Resolves the resume profile (`lib/profile.ts` `ensureProfile()`) unless matching is disabled; emits `profile-ready`.
3. **List crawl** (`lib/crawler.ts` `fetchListPage`) — paginates `kofia.or.kr/brd/m_96/list.do`, emits `crawl-list`.
4. **Detail crawl** (`fetchDetailPage`) — only for seqs not already summarized (`getExistingSeqs`); emits `crawl-detail`.
5. **AI summarization** (`lib/summarizer.ts`, batched via `SUMMARIZE_BATCH_SIZE`) + **matching** (`lib/matcher.ts`, batched) per chunk, persisted via `upsertJob`/`updateJobMatch`. Emits `summarize-progress` (job included) then, if profile changed, a `rematch` phase + `rematch-progress` for existing jobs whose `matchProfileHash` is stale.
6. Emits `done` with `getActiveJobs()` (the authoritative final list) + `newCount`/`hasProfile`.

A 1000 ms `sleep` separates every outbound KOFIA HTTP request (list and detail pages) — preserve this. Summarizer/matcher prompts truncate `job.content` to **3000 chars** (not 2000).

### Database: `lib/db.ts`

Five tables, all keyed off the crawler's `seq` (job posting id) or a normalized company name:

- **`jobs`** — one row per posting. `categories` is populated by `categorizePositions()` (`lib/position-categories.ts`) inside `upsertJob()` itself, so every caller (route, legacy migration) gets it for free; a one-time `backfillCategories()` fixes rows written before this existed. `getActiveJobs()`/`getJobsNeedingMatch()` both `LEFT JOIN applications` (see below) — **never query `jobs` alone when the result reaches the client**, or `applicationStatus` silently reverts to `미지원`.
- **`applications`** — per-job application status (`lib/application-status.ts`: 미지원/검토중/작성중/제출완료/서류합격/면접/불합격/최종합격), `notes`, an append-only `history` JSON array, `submittedAt` (set once, on first transition into `제출완료`, never overwritten). Written via `upsertApplicationStatus()`, exposed as `POST /api/applications` (`{seq, status, notes?}`, same shape as the pre-existing `/api/jobs/hide`). Deliberately a separate table from `jobs` — like `hidden`, this must survive a recrawl's `upsertJob` without being clobbered.
- **`companies`** / **`company_sections`** — company research cache, see below.
- **`application_drafts`** — one cached AI-drafted application per `seq` (see below).

### Company research: `lib/dart.ts` + `lib/company-research.ts`

KOFIA postings carry **no company ID**, only a free-text `company` string, and no financial data at all. `lib/company-normalize.ts`'s `normalizeCompanyName()` (strips `(주)`/`㈜`/`주식회사`/whitespace) is the *only* identity key — always use it, never re-derive normalization elsewhere.

- **`lib/dart.ts`** — OpenDART (전자공시시스템) client, gated on `process.env.DART_API_KEY` (`isDartConfigured()`). There is no company-name search API, so `findCorpCode()` downloads the full corp-code list (`corpCode.xml`, unzipped via the system `unzip` binary — not a new npm dep — and parsed with `cheerio`'s `xmlMode`) once, caches it to `data/dart-corpcodes.json` (refreshed every `DART_CORP_CODE_REFRESH_DAYS`), and matches locally (exact, then substring fuzzy). `fetchKeyFinancials()` matches accounts by **`account_id` (IFRS code) first, falling back to exact `account_nm` match** — a real bug was found and fixed here: substring-matching account names picked up `자본과부채총계` (assets total) for a `부채총계` (liabilities) search, because `.includes()` matched the wrong row.
- **`lib/company-research.ts`** — five independent sections (`lib/company-section-types.ts`: `overview`, `culture`, `governance_structure`, `financials`, `news`), each with its own TTL (`COMPANY_SECTION_TTL_DAYS` in `lib/config.ts`) so a "refresh" never re-runs sections that are still fresh. `financials`/`governance_structure` pre-fetch DART data in plain code and do a **single-turn, tool-free** summarization call; `overview`/`culture`/`news` are agentic `query()` calls with `allowedTools: ["WebSearch"]`. These calls intentionally **bypass `getSummaryModelOptions()`/FreeRide** and always hit Anthropic directly — WebSearch is a native Anthropic server tool a local FreeRide gateway likely can't proxy. Sources are extracted from the model's own `[title](url)` markdown links in its answer, not from parsing tool-call internals. Research is **lazy and manual-only** — there is no config flag or background job that researches all KOFIA members automatically; a company is only looked up when its "회사 리서치" tab is opened and the user clicks the refresh button, and only stale/missing sections are (re)run then.
- API: `GET /api/companies/[normalizedName]` (pure cache read, no AI cost, upserts the `companies` row from `?displayName=`) and `POST /api/companies/[normalizedName]/research` (SSE, same `data: ...\n\n` framing as the jobs route; body `{displayName, sections?}`).

### Profile & matching: `lib/profile.ts` + `lib/matcher.ts`

- Resume PDFs go in the gitignored `resume/` dir; `ensureProfile()` extracts a structured `Profile` agentically (`allowedTools: ["Read"]`, the SDK reads the PDFs itself) and caches it to `data/profile.json`, keyed by a hash of the PDF files' path/size/mtime. This call **always uses the raw Anthropic API**, never FreeRide, since resumes are PII.
- `Profile.transferableStrengths` (extracted from the resume) and `Profile.careerGoals` (user-authored, **not** inferable from a resume) both feed the matcher prompt so a CS/dev-heavy resume doesn't implicitly get scored as IT-only fit. `careerGoals` lives in a separate file, `data/profile-overrides.json` (`readCareerGoals`/`writeCareerGoals`), edited at `/settings` (`GET`/`PUT /api/profile/overrides`) — kept independent of the resume-hash cache so editing it never triggers (or requires) a resume re-extraction. `getCachedProfile()`/`ensureProfile()` both merge the override in fresh on every call via `withCareerGoals()`.
- `lib/matcher.ts` has **no category gate** — it already scores every job regardless of category; `positionType`/category bias, if any, comes from the profile's own material, not a code-level restriction.

### Application drafting: `lib/application-draft.ts` + `lib/application-method.ts`

- `generateApplicationDraft(seq)` builds personal-info fields + essay-question answers from the cached `Profile` (not the raw PDFs — cheaper, no `Read` tool needed) + the job + any cached `company_sections`. `stripForbiddenFields()` hard-deletes anything matching 주민등록번호/계좌번호/비밀번호/etc. even if the model produces it. Unknown fields (email, birthdate, school name — nothing in `Profile`'s schema covers these) are explicitly prompted to come back as `(직접 입력 필요)` rather than fabricated. Cached in `application_drafts`; `GET`/`POST`/`PUT /api/applications/[seq]/draft`.
- `detectSubmissionMethod()` (`lib/application-method.ts`) is a **pure, AI-free heuristic** run fresh on every draft `GET` (cheap enough not to cache): scans `job.attachments` filenames for an application-template pattern (입사지원서/지원서/...) vs. a consent-form pattern (개인정보...동의서), and `job.rawContent` for a submission email. Real crawled data showed **KOFIA postings are dominated by email+attachment submission**, not web ATS forms — check both signals, don't assume `siteUrl` means a fillable web form.
- **No Playwright / in-app browser automation.** It was prototyped and removed: real ATS forms (tested live against a greetinghr-hosted form) vary too much site-to-site — inconsistent labels, deeply nested field names, file uploads, consent checkboxes — for a hardcoded field-matcher to be reliable. Instead, `ApplicationDraftPanel` surfaces a copyable prompt (`이 공고 지원 도와줘 (seq=N)`) for the user to hand to a live Claude Code + Claude-in-Chrome session, which reads the real page and fills it with judgment. Findar's job stops at producing a good draft + submission-method hint; it never automates the actual site, and never has code capable of clicking a submit button.

### Client: `components/JobBoard.tsx` + `app/page.tsx` + `app/settings/page.tsx`

`app/page.tsx` dynamically imports `JobBoard` with `ssr: false`. The board manually parses SSE frames (`res.body.getReader()`), dedupes `summarize-progress` jobs by `seq`, and replaces the whole array on `done`. The job detail side panel has three tabs, each backed by its own component:
- **공고 상세** — inline in `JobBoard.tsx` (match score, application-status `<select>`, apply links: `siteUrl` — the company's real apply link, scraped but previously never rendered — shown as the primary CTA when present, KOFIA's own posting as a secondary link).
- **회사 리서치** — `components/CompanyResearchPanel.tsx`.
- **지원 도우미** — `components/ApplicationDraftPanel.tsx`.

`app/settings/page.tsx` is a small standalone client page (not part of `JobBoard`) for `careerGoals`.

### Env vars

None are committed (`.env*` is gitignored). Relevant ones: `DART_API_KEY` (OpenDART; company research degrades gracefully without it — company-research sections just report "DART 연동이 설정되지 않았습니다", nothing crashes), `USE_FREERIDE`/`FREERIDE_BASE_URL`/`FREERIDE_MODEL` (see FreeRide note above; standard Anthropic auth env vars are consumed inside the SDK and never referenced by name in app code).

## Conventions specific to this repo

- **Korean UI strings stay in Korean** (titles, badges, status messages, filter labels, prompts).
- Category classification (`lib/position-categories.ts`) has **no fixed whitelist in the AI prompt** — `CATEGORY_RULES` is a client+server-shared keyword-matching table, order-sensitive (first match wins, so more specific categories like 퀀트/WM-PB must precede broad ones like IT/개발). AI-returned `positions` are always free text; categorization happens afterward in code.
- Failure mode for summarization/matching/company-research/drafting is **degraded entries**, never dropped/thrown data: `positionType: "미분류"`/`jdSummary: "요약 실패"` for jobs, `FALLBACK_MATCH` for matches, `status: "failed"|"partial"` rows (with an explanatory `content` string) for company sections — preserve this pattern in any new AI call.
- New mutable per-job user state (status, hidden, drafts) gets its **own table**, never a new `jobs` column with a default — `upsertJob()`'s `ON CONFLICT DO UPDATE` would silently reset it on the next recrawl otherwise.
- AI calls that only see *derived* data (summaries, profile fields, public company info) may route through `getSummaryModelOptions()`/FreeRide, matching `matcher.ts`'s existing precedent; calls touching raw resume PDFs (`lib/profile.ts`) or Anthropic-native server tools like WebSearch (`lib/company-research.ts`) always call the Anthropic API directly.
- Never add code capable of submitting a third-party form or clicking a submit-like control — the whole application-assist feature set is designed to stop one step before that, by construction, not just by prompt instruction.
