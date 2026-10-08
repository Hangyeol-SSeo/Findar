export const AI_FEATURES = [
  { id: "summarization", label: "공고 요약", description: "채용공고의 직무와 지원 조건을 정리합니다." },
  { id: "matching", label: "공고 매칭", description: "이력서와 공고의 적합도를 평가합니다." },
  { id: "companyResearch", label: "회사 리서치", description: "웹 검색과 공시 자료를 바탕으로 회사를 조사합니다." },
  { id: "industryResearch", label: "업계 사례 조사", description: "자기소개서 첨삭에 필요한 업계 사례를 웹에서 찾아 정리합니다. 버튼을 눌렀을 때만 실행됩니다." },
  { id: "profile", label: "이력서 분석", description: "이력서에서 매칭용 프로필을 추출합니다." },
  { id: "resumeInventory", label: "이력서 항목 추출", description: "이력서의 경험과 자격을 빠짐없이 정리합니다." },
  { id: "resumeTailoring", label: "이력 구성 평가", description: "공고에 맞춰 강조하거나 줄일 이력을 판단합니다." },
  { id: "essayBank", label: "자기소개서 소재 추출", description: "기존 자기소개서에서 참고할 경험을 추출합니다." },
  { id: "applicationDraft", label: "지원서 작성", description: "문항 구상, 초안 작성과 검토에 사용합니다." },
  { id: "applicationFill", label: "지원서 입력칸 매핑", description: "저장된 지원 정보와 실제 입력칸을 연결합니다." },
] as const;

export type AIFeature = typeof AI_FEATURES[number]["id"];
export type AIModelSettings = Record<AIFeature, string>;
export interface AIModelOption { id: string; label: string }
export interface AIModelSettingsResponse {
  settings: AIModelSettings;
  options: Record<AIFeature, AIModelOption[]>;
}

// Model IDs live here so defaults, settings, and callers share one source of truth.
export const AI_MODEL_IDS = {
  SONNET: "claude-sonnet-5-5",
  OPUS: "claude-opus-5-5",
  SONNET_4_6: "claude-sonnet-4-6",
  HAIKU: "claude-haiku-4-5-20251001",
  FREERIDE_CODING: "freeride/coding",
  LEGACY_SONNET_5: "claude-sonnet-5",
  GPT_6_LUNA: "gpt-6-luna",
  GPT_6_1_SOL: "gpt-6.1-sol",
  LEGACY_GPT_6_SOL: "gpt-6-sol",
} as const;

export const DEFAULT_AI_MODEL = AI_MODEL_IDS.SONNET;
export const DEFAULT_JOB_AI_MODEL = AI_MODEL_IDS.HAIKU;

export const CLAUDE_MODELS: AIModelOption[] = [
  { id: AI_MODEL_IDS.SONNET, label: "Claude Sonnet 5.5" },
  { id: AI_MODEL_IDS.OPUS, label: "Claude Opus 5.5" },
  { id: AI_MODEL_IDS.SONNET_4_6, label: "Claude Sonnet 4.6" },
  { id: AI_MODEL_IDS.HAIKU, label: "Claude Haiku 4.5" },
];

export const CODEX_MODELS: AIModelOption[] = [
  { id: AI_MODEL_IDS.GPT_6_LUNA, label: "Codex · GPT-6-Luna (ChatGPT 구독)" },
  { id: AI_MODEL_IDS.GPT_6_1_SOL, label: "Codex · GPT-6.1-Sol (ChatGPT 구독)" },
];

export function isCodexModel(model: string): boolean {
  return CODEX_MODELS.some((option) => option.id === model);
}

export interface CodexConnectionStatus {
  available: boolean;
  authenticated: boolean;
  message: string;
}
