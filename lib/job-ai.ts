import { query } from "./ai-query";
import { getJobAIConfiguration } from "./ai-model-settings";

export class FreeRideRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FreeRideRequestError";
  }
}

/** Text-only job analysis uses the gateway directly, avoiding Claude Code's agent messages/tools. */
export async function queryJobAI(feature: "summarization" | "matching", prompt: string): Promise<string> {
  const configuration = getJobAIConfiguration(feature);
  if (configuration.provider !== "freeride") {
    let result = "";
    for await (const message of query({
      prompt,
      options: { model: configuration.model, maxTurns: 1, allowedTools: [] },
    })) {
      if ("result" in message) result = message.result;
    }
    return result;
  }

  const signal = AbortSignal.timeout(120_000);
  try {
    // OpenAI-format endpoint: the gateway's /v1/messages rewrites every non-claude model id to "auto",
    // so a specific free model (FREERIDE_MODEL) can only be pinned here. Presets aren't known on this route.
    const response = await fetch(`${configuration.baseURL.replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: configuration.model.startsWith("freeride/") ? "auto" : configuration.model,
        max_tokens: 8192,
        stream: false,
        messages: [{ role: "user", content: prompt }],
      }),
      signal,
      cache: "no-store",
    });
    if (!response.ok) {
      await response.body?.cancel();
      const hint = response.status === 429 || response.status === 503
        ? "무료 모델 제공자가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해주세요."
        : "FreeRide 서버 상태와 요청 호환성을 확인해주세요.";
      throw new FreeRideRequestError(`FreeRide AI 분석에 실패했습니다 (HTTP ${response.status}). ${hint}`);
    }
    const result: { choices?: { message?: { content?: unknown }; finish_reason?: string }[] } | null = await response.json();
    const choice = Array.isArray(result?.choices) ? result.choices[0] : undefined;
    if (choice?.finish_reason === "length") {
      throw new FreeRideRequestError("FreeRide 응답이 길이 제한으로 중단되어 분석을 완료하지 못했습니다.");
    }
    const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
    if (!text.trim()) throw new FreeRideRequestError("FreeRide가 분석 결과를 반환하지 않았습니다. 잠시 후 다시 시도해주세요.");
    return text;
  } catch (error) {
    if (error instanceof FreeRideRequestError) throw error;
    if (signal.aborted) throw new FreeRideRequestError("FreeRide AI 분석 응답 시간이 초과되었습니다. 잠시 후 다시 시도해주세요.");
    if (error instanceof SyntaxError) throw new FreeRideRequestError("FreeRide 응답 형식이 올바르지 않습니다. FreeRide 서버 상태를 확인해주세요.");
    throw new FreeRideRequestError("FreeRide 서버에 연결할 수 없습니다. 서버 실행 여부와 FREERIDE_BASE_URL 설정을 확인해주세요.");
  }
}
