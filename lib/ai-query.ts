import { query as queryClaude, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { isCodexModel } from "./ai-model-types";
import { runCodex, type CodexUsage, type InputImage } from "./codex-ai";
import { getAIAbortSignal, throwIfAIAborted } from "./ai-operation";

type QueryInput = Parameters<typeof queryClaude>[0] & {
  inputFiles?: string[];
  // 텍스트 프롬프트 앞에 붙일 이미지(base64). 회사 홈페이지의 글자 이미지를 읽을 때 쓴다.
  inputImages?: InputImage[];
  webToolLimit?: number;
  // Codex 호출 제한 시간. 자기소개서 작성처럼 긴 요청은 기본값(240초)보다 길게 준다.
  timeoutMs?: number;
};

interface CodexResult {
  type: "result";
  subtype: "success";
  is_error: false;
  result: string;
  num_turns: number;
  total_cost_usd?: number;
  modelUsage?: unknown;
  codexUsage?: CodexUsage;
}

/** Keep each caller's validation/caching intact while choosing its execution provider. */
export async function* query(input: QueryInput): AsyncGenerator<SDKMessage | CodexResult> {
  throwIfAIAborted();
  const taskSignal = getAIAbortSignal();
  const controller = input.options?.abortController ?? new AbortController();
  const abort = () => controller.abort(taskSignal?.reason);
  taskSignal?.addEventListener("abort", abort, { once: true });
  try {
    const { inputFiles, inputImages, webToolLimit, timeoutMs, ...claudeInput } = input;
    claudeInput.options = { ...claudeInput.options, abortController: controller };
    const model = input.options?.model || "";
    if (inputImages?.length && typeof input.prompt !== "string") throw new Error("이미지는 텍스트 프롬프트와 함께 보내야 합니다.");
    if (!isCodexModel(model)) {
      if (inputImages?.length) claudeInput.prompt = imageMessage(input.prompt as string, inputImages);
      for await (const message of queryClaude(claudeInput)) {
        throwIfAIAborted();
        yield message;
      }
      return;
    }
    if (typeof input.prompt !== "string") throw new Error("Codex 요청에는 텍스트 프롬프트가 필요합니다.");
    const systemPrompt = typeof input.options?.systemPrompt === "string" ? input.options.systemPrompt : undefined;
    const tools = input.options?.allowedTools || [];
    let codexUsage: CodexUsage | undefined;
    const result = await runCodex({
      model, prompt: input.prompt, systemPrompt, inputFiles, inputImages,
      signal: controller.signal,
      effort: input.options?.effort === "high" ? "high" : "medium",
      webSearch: tools.includes("WebSearch") || tools.includes("WebFetch"),
      webToolLimit,
      timeoutMs,
      onUsage: (usage) => { codexUsage = usage; },
    });
    throwIfAIAborted();
    yield { type: "result", subtype: "success", is_error: false, result, num_turns: 1, codexUsage };
  } catch (error) {
    throwIfAIAborted();
    throw error;
  } finally { taskSignal?.removeEventListener("abort", abort); }
}

async function* imageMessage(text: string, images: InputImage[]): AsyncGenerator<SDKUserMessage> {
  yield {
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: [
      ...images.map((image) => ({ type: "image" as const, source: { type: "base64" as const, media_type: image.mediaType, data: image.data } })),
      { type: "text" as const, text },
    ] },
  };
}
