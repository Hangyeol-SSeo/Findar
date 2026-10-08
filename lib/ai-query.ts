import { query as queryClaude, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { isCodexModel } from "./ai-model-types";
import { runCodex } from "./codex-ai";

type QueryInput = Parameters<typeof queryClaude>[0] & {
  inputFiles?: string[];
  webToolLimit?: number;
};

interface CodexResult {
  type: "result";
  subtype: "success";
  is_error: false;
  result: string;
  num_turns: number;
  total_cost_usd?: number;
  modelUsage?: unknown;
}

/** Keep each caller's validation/caching intact while choosing its execution provider. */
export async function* query(input: QueryInput): AsyncGenerator<SDKMessage | CodexResult> {
  const { inputFiles, webToolLimit, ...claudeInput } = input;
  const model = input.options?.model || "";
  if (!isCodexModel(model)) {
    yield* queryClaude(claudeInput);
    return;
  }
  if (typeof input.prompt !== "string") throw new Error("Codex 요청에는 텍스트 프롬프트가 필요합니다.");
  const systemPrompt = typeof input.options?.systemPrompt === "string" ? input.options.systemPrompt : undefined;
  const tools = input.options?.allowedTools || [];
  const result = await runCodex({
    model, prompt: input.prompt, systemPrompt, inputFiles,
    signal: input.options?.abortController?.signal,
    effort: input.options?.effort === "high" ? "high" : "medium",
    webSearch: tools.includes("WebSearch") || tools.includes("WebFetch"),
    webToolLimit,
  });
  yield { type: "result", subtype: "success", is_error: false, result, num_turns: 1 };
}
