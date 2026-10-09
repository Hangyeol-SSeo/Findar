import { insertAIUsage, listAIUsage, type AIUsageRow } from "./db";
import { isCodexModel } from "./ai-model-types";

// AI 호출마다 모델이 알려 주는 실제 사용량을 남긴다. 추정이 아니라 이 값으로 비용 변화를 확인한다.
// inputTokens는 캐시에서 읽지 않고 새로 처리한 입력만 센다(Claude의 input_tokens와 같은 뜻). Codex는 전체 입력에서
// 캐시 적중분을 빼서 같은 뜻으로 맞춘다. 기록은 부가 기능이라 실패해도 본 작업을 막지 않는다.

export type AIUsageMode = "fresh" | "resumed" | "stateless" | "independent";

interface ResultLike {
  usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number };
  total_cost_usd?: number;
  codexUsage?: { inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null };
}

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function recordAIUsage(input: { key?: string; feature: string; model: string; mode: AIUsageMode; promptChars: number; result: unknown }): void {
  try {
    const result = (input.result ?? {}) as ResultLike;
    const codex = result.codexUsage;
    const cached = codex ? num(codex.cachedInputTokens) : num(result.usage?.cache_read_input_tokens);
    const total = codex ? num(codex.inputTokens) : null;
    insertAIUsage({
      key: input.key ?? "", feature: input.feature, provider: isCodexModel(input.model) ? "codex" : "claude", model: input.model, mode: input.mode,
      promptChars: input.promptChars,
      inputTokens: codex ? (total === null ? null : Math.max(0, total - (cached ?? 0))) : num(result.usage?.input_tokens),
      cacheReadTokens: cached,
      cacheCreationTokens: codex ? null : num(result.usage?.cache_creation_input_tokens),
      outputTokens: codex ? num(codex.outputTokens) : num(result.usage?.output_tokens),
      costUsd: num(result.total_cost_usd),
      createdAt: Date.now(),
    });
  } catch (error) { console.error("[ai-usage] 사용량을 기록하지 못했습니다:", error); }
}

export function summarizeAIUsage(rows: AIUsageRow[]) {
  const sum = (pick: (r: AIUsageRow) => number | null) => rows.reduce((n, r) => n + (pick(r) ?? 0), 0);
  const input = sum((r) => r.inputTokens), cacheRead = sum((r) => r.cacheReadTokens);
  return {
    calls: rows.length,
    inputTokens: input, cacheReadTokens: cacheRead, cacheCreationTokens: sum((r) => r.cacheCreationTokens), outputTokens: sum((r) => r.outputTokens),
    costUsd: Math.round(sum((r) => r.costUsd) * 10000) / 10000,
    // 입력 중 캐시에서 읽은 비율. 대화를 이어 쓸 때 이 값이 높아야 비용이 줄어든다.
    cacheHitRatio: input + cacheRead ? Math.round((cacheRead / (input + cacheRead)) * 1000) / 1000 : 0,
    byMode: Object.fromEntries(["fresh", "resumed", "stateless", "independent"].map((mode) => [mode, rows.filter((r) => r.mode === mode).length])),
  };
}

export function getAIUsage(filter: { key?: string; since?: number; limit?: number } = {}) {
  const rows = listAIUsage(filter);
  return { summary: summarizeAIUsage(rows), rows };
}
