import { query as queryClaude, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { isCodexModel } from "./ai-model-types";
import { runCodex } from "./codex-ai";
import { getAIAbortSignal, throwIfAIAborted } from "./ai-operation";

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
  throwIfAIAborted();
  const taskSignal = getAIAbortSignal();
  const controller = input.options?.abortController ?? new AbortController();
  const abort = () => controller.abort(taskSignal?.reason);
  taskSignal?.addEventListener("abort", abort, { once: true });
  try {
    const { inputFiles, webToolLimit, ...claudeInput } = input;
    claudeInput.options = { ...claudeInput.options, abortController: controller };
    const model = input.options?.model || "";
    if (!isCodexModel(model)) {
      for await (const message of queryClaude(claudeInput)) {
        throwIfAIAborted();
        yield message;
      }
      return;
    }
    if (typeof input.prompt !== "string") throw new Error("Codex 요청에는 텍스트 프롬프트가 필요합니다.");
    const systemPrompt = typeof input.options?.systemPrompt === "string" ? input.options.systemPrompt : undefined;
    const tools = input.options?.allowedTools || [];
    const result = await runCodex({
      model, prompt: input.prompt, systemPrompt, inputFiles,
      signal: controller.signal,
      effort: input.options?.effort === "high" ? "high" : "medium",
      webSearch: tools.includes("WebSearch") || tools.includes("WebFetch"),
      webToolLimit,
    });
    throwIfAIAborted();
    yield { type: "result", subtype: "success", is_error: false, result, num_turns: 1 };
  } catch (error) {
    throwIfAIAborted();
    throw error;
  } finally { taskSignal?.removeEventListener("abort", abort); }
}
