import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { query } from "./ai-query";
import { isCodexModel } from "./ai-model-types";
import { throwIfAIAborted } from "./ai-operation";
import { recordAIUsage, type AIUsageMode } from "./ai-usage";
import { deleteAIConversationRow, getAIConversationRow, saveAIConversationRow } from "./db";

// 한 공고의 AI 작업을 하나의 대화로 이어 가는 실행기. 작성·재작성·첨삭·수정이 모두 같은 대화에 쌓인다.
//
// 기억과 비용을 나눠 다룬다.
//  - 기억: 대화의 원본은 Findar가 가진 기록(history — 자기소개서는 essay_events)이다. 모델·시간과 무관하게 남고,
//    Claude·Codex·이후 추가하는 모델이 모두 같은 기록에서 대화를 이어받는다.
//  - 비용: 모델 서버는 대화를 기억하지 않아 매 턴 앞의 대화 전체가 다시 입력된다. 그래서 공통 머리말(규칙·자료)을 맨 앞에
//    고정하고 기록을 뒤에 덧붙이는 순서로 보내, 앞부분이 캐시에서 읽히게 한다. Claude는 네이티브 세션을 이어 써서(resume)
//    이전 턴을 다시 보내지 않고 새 기록과 지시만 덧붙인다. 세션을 이어 쓸 수 없으면(머리말이 바뀜, 세션이 너무 김,
//    다른 모델에서 돌아옴, 세션 파일 없음) 같은 기록으로 새 세션을 시작한다 — 기억은 그대로이고 캐시만 한 번 새로 쓴다.
//  - Codex 등 세션을 이어 쓸 수 없는 모델은 매번 머리말+기록+이번 작업의 앞선 턴을 같은 순서로 보낸다(앞부분 캐시는 모델 쪽 자동).

export interface ConversationHistory {
  // afterRowid가 null이면 처음부터(새 세션용 — budget 글자 안으로 정리해서), 숫자면 그 뒤에 쌓인 기록만(이어 쓰기용) 돌려준다.
  render(afterRowid: number | null, budget?: number): { text: string; lastRowid: number };
}

export interface ConversationOptions {
  key: string;
  feature: string;
  model: string;
  header: string;
  history: ConversationHistory;
  timeoutMs?: number;
  // 시험용으로 한도를 바꿀 때만 준다. 평소에는 모델이 알려 주는 문맥 크기로 정한다.
  maxContextTokens?: number;
}

export interface AIConversation {
  readonly model: string;
  readonly provider: "claude" | "codex";
  // followUp: 방금 응답을 고치거나 이어 받는 턴(검증 실패 수정·편집 등). 이 작업의 원래 지시에 기대므로, 새 세션으로 넘어가도
  // 그 지시부터 지금까지의 주고받음을 빠짐없이 함께 보낸다.
  ask(turn: string, signal?: AbortSignal, options?: { followUp?: boolean }): Promise<string>;
}

const SESSION_DIR = join(process.cwd(), "data", "ai-sessions");
const DEFAULT_TIMEOUT_MS = 600_000;
// 세션의 문맥이 한도를 넘을 것 같으면 정리한 기록으로 새로 시작한다. 모델의 문맥 한도에 닿기 전에 끊어야 호출 실패나
// Claude Code의 자동 요약(기억이 흐려지고 캐시가 깨짐)을 피한다. 한도는 모델이 알려 주는 문맥 크기에서 출력 몫과 여유분을
// 뺀 값이고(처음엔 Sonnet 기준 20만으로 가정), 판단은 실제 사용량(토큰)으로 한다. 새로 붙일 글은 한국어 기준으로
// 넉넉하게 글자 수 = 토큰 수로 어림한다.
// 출력 몫은 모델이 알려 주는 최대 출력(Sonnet 5.5는 12.8만)이 아니라 실제로 쓰는 양에 맞춘다(생각 포함 실측 최대 약 3.3만).
// 최대 출력을 그대로 빼면 한도가 6.4만으로 줄어, 머리말(약 8만 자)만으로 넘쳐 매 턴 새 세션이 열리고 캐시를 다시 썼다.
const DEFAULT_WINDOW = { contextWindow: 200_000, maxOutputTokens: 32_000 };
const OUTPUT_RESERVE_TOKENS = 40_000;
const SAFETY_TOKENS = 8_000;
const windows = new Map<string, { contextWindow: number; maxOutputTokens: number }>();
const contextLimit = (model: string) => {
  const w = windows.get(model) ?? DEFAULT_WINDOW;
  return w.contextWindow - Math.min(w.maxOutputTokens, OUTPUT_RESERVE_TOKENS) - SAFETY_TOKENS;
};
function learnWindow(model: string, result: unknown) {
  const usage = (result as { modelUsage?: Record<string, { contextWindow?: unknown; maxOutputTokens?: unknown }> } | null)?.modelUsage?.[model];
  if (typeof usage?.contextWindow === "number" && usage.contextWindow > 0)
    windows.set(model, { contextWindow: usage.contextWindow, maxOutputTokens: typeof usage.maxOutputTokens === "number" ? usage.maxOutputTokens : DEFAULT_WINDOW.maxOutputTokens });
}
// 새 세션을 열 때, 머리말을 뺀 남은 자리에서 기록과 "이번 작업의 앞선 주고받음"에 나눠 줄 몫과 상한(글자).
// 새 세션 직후에도 몇 턴은 이어 쓸 수 있게 GROWTH_RESERVE만큼 비워 둔다.
const GROWTH_RESERVE = 30_000;
const HISTORY_MAX = 40_000;
const OP_LOG_MAX = 30_000;

const locks = new Map<string, Promise<unknown>>();
// 같은 공고의 대화는 한 번에 하나씩 이어 간다(턴 순서가 섞이면 기록과 세션이 어긋난다).
function serialize<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  const tail = next.catch(() => undefined);
  locks.set(key, tail);
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return next;
}

const deny = async () => ({ behavior: "deny" as const, message: "자기소개서 작업에는 외부 도구를 사용하지 않습니다." });

interface RunResult { text: string; sessionId: string | null; lastMessageId: string | null; result: unknown }

// 이번 호출에서 모델이 처리한 전체 문맥(새 입력 + 캐시 읽기 + 캐시 쓰기 + 출력). 사용량이 없으면 null.
function contextTokensOf(result: unknown): number | null {
  const usage = (result as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const total = n(usage.input_tokens) + n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens) + n(usage.output_tokens);
  return total > 0 ? total : null;
}

async function run(prompt: string, model: string, session: { resume: string; at: string | null } | null, persist: boolean, signal: AbortSignal | undefined, timeoutMs: number): Promise<RunResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  if (persist) mkdirSync(SESSION_DIR, { recursive: true });
  let sessionId: string | null = null;
  let lastMessageId: string | null = null;
  try {
    for await (const message of query({ prompt, timeoutMs, options: {
      model, maxTurns: 3, tools: [], allowedTools: [], settingSources: [], canUseTool: deny, abortController: controller,
      persistSession: persist,
      // 세션 파일을 앱 전용 폴더 기준으로 둬, 사용자의 Claude Code 대화 목록에 섞이지 않게 한다.
      ...(persist ? { cwd: SESSION_DIR } : {}),
      ...(session ? { resume: session.resume, ...(session.at ? { resumeSessionAt: session.at } : {}) } : {}),
    } })) {
      const m = message as { type: string; session_id?: string; uuid?: string; subtype?: string; is_error?: boolean; result?: string; num_turns?: number };
      if (typeof m.session_id === "string") sessionId = m.session_id;
      if (m.type === "assistant" && typeof m.uuid === "string") lastMessageId = m.uuid;
      if (m.type === "result") {
        if (m.subtype !== "success" || m.is_error) {
          console.error("[ai-conversation] 모델 결과 실패:", JSON.stringify({ model, subtype: m.subtype, is_error: m.is_error, turns: m.num_turns, resumed: !!session }));
          throw new Error("작성 모델 호출이 실패했습니다. 잠시 후 다시 시도해주세요.");
        }
        return { text: m.result ?? "", sessionId, lastMessageId, result: message };
      }
    }
    throw new Error("작성 결과를 받지 못했습니다.");
  } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
}

export function openConversation(options: ConversationOptions): AIConversation {
  const { key, feature, model, header, history } = options;
  const provider = isCodexModel(model) ? "codex" as const : "claude" as const;
  const headerHash = createHash("sha256").update(header).digest("hex");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTokens = () => options.maxContextTokens ?? contextLimit(model);
  // 새 세션에서 기록·앞선 주고받음에 줄 몫. 머리말이 커서 자리가 모자라면 그만큼 줄인다.
  const budgets = () => {
    const room = Math.max(0, maxTokens() - header.length - GROWTH_RESERVE);
    // 머리말이 아주 커도 최근 기억은 남긴다(최소 몫).
    return { history: Math.max(8_000, Math.min(HISTORY_MAX, Math.floor(room * 0.6))), opLog: Math.max(4_000, Math.min(OP_LOG_MAX, Math.floor(room * 0.4))) };
  };
  // 이번 작업에서 주고받은 턴(지시+응답 한 쌍씩). 세션을 새로 시작하거나 세션 없이 보낼 때 이 작업의 앞선 맥락을 잃지 않게 함께 보낸다.
  const opLog: { text: string; followUp: boolean }[] = [];
  let session: { id: string; at: string | null } | null = null;
  let checkedStored = false;
  let synced = 0;
  let contextTokens = 0;

  // 이번 작업의 앞선 주고받음은 최근 것부터 상한까지만 넣는다(문항이 많은 일괄 작성에서 끝없이 커지지 않게).
  // 다만 이어지는 턴(followUp)이면 그 턴이 기대는 원래 지시부터 지금까지는 상한과 관계없이 모두 넣는다 — 빠지면 모델이
  // 요구 형식도 고칠 글도 모른 채 답한다(실제로 고쳐쓰기 수정 호출이 형식을 지어내 실패했다).
  const recentOpLog = (budget: number, followUp: boolean) => {
    let start = opLog.length;
    if (followUp) {
      start = opLog.findLastIndex((e) => !e.followUp);
      if (start < 0) start = 0;
    }
    const kept = opLog.slice(start).map((e) => e.text);
    let size = kept.reduce((n, t) => n + t.length, 0);
    for (let i = start - 1; i >= 0 && size + opLog[i].text.length <= budget; i--) { kept.unshift(opLog[i].text); size += opLog[i].text.length; }
    if (!kept.length) return "";
    const omitted = opLog.length - kept.length;
    return `\n\n[이번 작업에서 이미 주고받은 내용${omitted ? ` — 앞선 ${omitted}건은 생략(저장된 결과는 작업 기록에 있음)` : ""}]\n${kept.join("\n\n")}`;
  };

  const freshPrompt = (turn: string, followUp: boolean) => {
    const budget = budgets();
    const full = history.render(null, budget.history);
    const prompt = `${header}\n\n[지금까지의 작업 기록]\n${full.text || "아직 없음"}${recentOpLog(budget.opLog, followUp)}\n\n${turn}`;
    return { prompt, lastRowid: full.lastRowid };
  };

  async function once(turn: string, signal: AbortSignal | undefined, allowResume: boolean, followUp: boolean): Promise<string> {
    if (provider === "claude" && allowResume && !checkedStored) {
      checkedStored = true;
      const row = getAIConversationRow(key, provider);
      if (row?.sessionId && row.headerHash === headerHash) {
        session = { id: row.sessionId, at: row.lastMessageId };
        synced = row.syncedRowid;
        contextTokens = row.contextTokens;
      }
    }
    let prompt = "", lastRowid = 0, mode: AIUsageMode = "fresh";
    let resumable = provider === "claude" && allowResume && session !== null;
    if (resumable) {
      const delta = history.render(synced);
      prompt = `${delta.text ? `[직전 작업 이후의 작업 기록]\n${delta.text}\n\n` : ""}${turn}`;
      lastRowid = Math.max(synced, delta.lastRowid);
      mode = "resumed";
      // 매 턴 전에 확인한다(한 작업 안에서도 문항이 많으면 커진다). 넘칠 것 같으면 같은 기록으로 새 세션을 연다.
      if (contextTokens + prompt.length > maxTokens()) resumable = false;
    }
    if (!resumable) {
      ({ prompt, lastRowid } = freshPrompt(turn, followUp));
      mode = provider === "claude" ? "fresh" : "stateless";
    }
    const current = resumable ? session : null;
    const result = await run(prompt, model, current ? { resume: current.id, at: current.at } : null, provider === "claude", signal, timeoutMs);
    recordAIUsage({ key, feature, model, mode, promptChars: prompt.length, result: result.result });
    learnWindow(model, result.result);
    opLog.push({ text: `[지시]\n${turn}\n\n[응답]\n${result.text}`, followUp });
    if (provider === "claude" && result.sessionId) {
      session = { id: result.sessionId, at: result.lastMessageId };
      contextTokens = contextTokensOf(result.result) ?? (mode === "resumed" ? contextTokens : 0) + prompt.length + result.text.length;
      synced = lastRowid;
      saveAIConversationRow({ key, provider, sessionId: session.id, lastMessageId: session.at, headerHash, syncedRowid: synced, contextTokens, model, updatedAt: Date.now() });
    } else if (provider === "claude") {
      // 세션 id를 받지 못하면 이번 작업의 나머지는 세션 없이(머리말+기록+앞선 턴을 매번) 보낸다. 기억은 그대로다.
      session = null;
    }
    return result.text;
  }

  return {
    model, provider,
    ask(turn, signal, options) {
      const followUp = options?.followUp === true;
      return serialize(key, async () => {
        throwIfAIAborted();
        try { return await once(turn, signal, true, followUp); }
        catch (error) {
          throwIfAIAborted();
          if (signal?.aborted) throw error;
          console.error(`[ai-conversation] 모델 호출 실패, ${session ? "새 세션으로" : "한 번 더"} 다시 시도합니다:`, error);
          // 세션을 이어 쓰다 실패하면(세션 파일 손상·만료 등) 같은 기록으로 새 세션을 시작한다.
          if (session && provider === "claude") { deleteAIConversationRow(key, provider); session = null; }
          return await once(turn, signal, false, followUp);
        }
      });
    },
  };
}
