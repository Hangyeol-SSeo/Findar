import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AI_FEATURES, CLAUDE_MODELS, type AIFeature, type AIModelSettings, type AIModelSettingsResponse } from "./ai-model-types";

function settingsPath() { return join(process.cwd(), "data", "ai-model-settings.json"); }
function isJobFeature(feature: AIFeature) { return feature === "summarization" || feature === "matching"; }
function freeRideModel() { return process.env.FREERIDE_MODEL || "freeride/coding"; }

function defaults(): AIModelSettings {
  return Object.fromEntries(AI_FEATURES.map(({ id }) => [id,
    isJobFeature(id)
      ? process.env.USE_FREERIDE === "true" ? freeRideModel() : "claude-haiku-4-5-20251001"
      : id === "companyResearch" ? process.env.COMPANY_RESEARCH_MODEL || "claude-sonnet-5" : "claude-sonnet-5",
  ])) as AIModelSettings;
}

function modelOptions(): AIModelSettingsResponse["options"] {
  const initial = defaults();
  return Object.fromEntries(AI_FEATURES.map(({ id }) => {
    const options = CLAUDE_MODELS.map((model) => ({ ...model }));
    if (isJobFeature(id)) options.push({ id: freeRideModel(), label: `FreeRide (${freeRideModel()})` });
    if (!options.some((option) => option.id === initial[id])) options.push({ id: initial[id], label: initial[id] });
    return [id, options];
  })) as AIModelSettingsResponse["options"];
}

export function readAIModelSettings(): AIModelSettingsResponse {
  const settings = defaults();
  const options = modelOptions();
  const path = settingsPath();
  if (existsSync(path)) {
    try {
      const saved: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        for (const { id } of AI_FEATURES) {
          const model = (saved as Record<string, unknown>)[id];
          if (options[id].some((option) => option.id === model)) settings[id] = model as string;
        }
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return { settings, options };
}

export class InvalidAIModelSettings extends Error {}

export function writeAIModelSettings(value: unknown): AIModelSettingsResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidAIModelSettings("모델 설정이 올바르지 않습니다.");
  const input = value as Record<string, unknown>;
  const options = modelOptions();
  if (Object.keys(input).length !== AI_FEATURES.length) throw new InvalidAIModelSettings("모든 기능의 모델을 선택해주세요.");
  for (const { id, label } of AI_FEATURES) {
    if (!Object.hasOwn(input, id) || !options[id].some((option) => option.id === input[id]))
      throw new InvalidAIModelSettings(`${label}에서 선택할 수 없는 모델입니다.`);
  }
  const path = settingsPath();
  mkdirSync(join(process.cwd(), "data"), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(input, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
  return readAIModelSettings();
}

export function getAIModelId(feature: AIFeature): string {
  return readAIModelSettings().settings[feature];
}

export function getJobAIConfiguration(feature: "summarization" | "matching") {
  const model = getAIModelId(feature);
  if (model === freeRideModel()) {
    return { provider: "freeride" as const, model, baseURL: process.env.FREERIDE_BASE_URL || "http://localhost:11343" };
  }
  return { provider: "claude" as const, model };
}
