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
  // afterRowid가 null이면 처음부터(새 세션용 — 길면 정리해서), 숫자면 그 뒤에 쌓인 기록만(이어 쓰기용) 돌려준다.
  render(afterRowid: number | null): { text: string; lastRowid: number };
}

export interface ConversationOptions {
  key: string;
  feature: string;
  model: string;
  header: string;
  history: ConversationHistory;
  timeoutMs?: number;
  maxSessionChars?: number;
}

export interface AIConversation {
  readonly model: string;
  readonly provider: "claude" | "codex";
  ask(turn: string, signal?: AbortSignal): Promise<string>;
}

const SESSION_DIR = join(process.cwd(), "data", "ai-sessions");
const DEFAULT_TIMEOUT_MS = 600_000;
// 이보다 길어진 세션은 정리한 기록으로 새로 시작한다(모델의 문맥 한도와 매 턴 다시 읽는 양을 함께 묶어 둔다).
const MAX_SESSION_CHARS = 350_000;

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
    for await (const message of query({ prompt, options: {
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
  const maxChars = options.maxSessionChars ?? MAX_SESSION_CHARS;
  // 이번 작업에서 주고받은 턴. 세션을 새로 시작하거나 세션 없이 보낼 때 이 작업의 앞선 맥락을 잃지 않게 함께 보낸다.
  const opLog: string[] = [];
  let session: { id: string; at: string | null } | null = null;
  let checkedStored = false;
  let synced = 0;
  let chars = 0;

  const freshPrompt = (turn: string) => {
    const full = history.render(null);
    const prompt = `${header}\n\n[지금까지의 작업 기록]\n${full.text || "아직 없음"}${opLog.length ? `\n\n[이번 작업에서 이미 주고받은 내용]\n${opLog.join("\n\n")}` : ""}\n\n${turn}`;
    return { prompt, lastRowid: full.lastRowid };
  };

  async function once(turn: string, signal: AbortSignal | undefined, allowResume: boolean): Promise<string> {
    if (provider === "claude" && allowResume && !checkedStored) {
      checkedStored = true;
      const row = getAIConversationRow(key, provider);
      if (row?.sessionId && row.headerHash === headerHash && row.chars < maxChars) {
        session = { id: row.sessionId, at: row.lastMessageId };
        synced = row.syncedRowid;
        chars = row.chars;
      }
    }
    const resumable = provider === "claude" && allowResume && session !== null;
    let prompt: string, lastRowid: number, mode: AIUsageMode;
    if (resumable) {
      const delta = history.render(synced);
      prompt = `${delta.text ? `[직전 작업 이후의 작업 기록]\n${delta.text}\n\n` : ""}${turn}`;
      lastRowid = Math.max(synced, delta.lastRowid);
      mode = "resumed";
    } else {
      ({ prompt, lastRowid } = freshPrompt(turn));
      mode = provider === "claude" ? "fresh" : "stateless";
    }
    const current = resumable ? session : null;
    const result = await run(prompt, model, current ? { resume: current.id, at: current.at } : null, provider === "claude", signal, timeoutMs);
    recordAIUsage({ key, feature, model, mode, promptChars: prompt.length, result: result.result });
    opLog.push(`[지시]\n${turn}`, `[응답]\n${result.text}`);
    if (provider === "claude" && result.sessionId) {
      session = { id: result.sessionId, at: result.lastMessageId };
      chars = (mode === "resumed" ? chars : 0) + prompt.length + result.text.length;
      synced = lastRowid;
      saveAIConversationRow({ key, provider, sessionId: session.id, lastMessageId: session.at, headerHash, syncedRowid: synced, chars, model, updatedAt: Date.now() });
    } else if (provider === "claude") {
      // 세션 id를 받지 못하면 이번 작업의 나머지는 세션 없이(머리말+기록+앞선 턴을 매번) 보낸다. 기억은 그대로다.
      session = null;
    }
    return result.text;
  }

  return {
    model, provider,
    ask(turn, signal) {
      return serialize(key, async () => {
        throwIfAIAborted();
        try { return await once(turn, signal, true); }
        catch (error) {
          throwIfAIAborted();
          if (signal?.aborted) throw error;
          console.error(`[ai-conversation] 모델 호출 실패, ${session ? "새 세션으로" : "한 번 더"} 다시 시도합니다:`, error);
          // 세션을 이어 쓰다 실패하면(세션 파일 손상·만료 등) 같은 기록으로 새 세션을 시작한다.
          if (session && provider === "claude") { deleteAIConversationRow(key, provider); session = null; }
          return await once(turn, signal, false);
        }
      });
    },
  };
}
