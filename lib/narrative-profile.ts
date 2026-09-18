import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";

// lib/applicant-profile.ts가 "무엇을 했는가/어떤 사실을 가졌는가"를, lib/profile.ts(이력서
// AI 추출)가 "무엇을 잘하는가"를 담는다면, 이 모듈은 그 어느 쪽도 담지 못하는 축 — "왜
// 그렇게 선택해왔고 왜 지금 이 방향인가"를 담는다. applicant-profile.ts와 동일하게 100%
// 사용자 직접 작성, AI 추출/가공 전혀 없음 — 이 데이터는 이력서처럼 자동 추출될 수 없고,
// AI가 대신 지어내는 순간 "지원자가 생각을 AI에 맡겼다"는, 사용자가 가장 우려하는 인상
// 그 자체가 된다.
//
// core(고정 소수 필드, applicant-profile.ts 스타일 전체교체)와 episodes(essay-bank.ts
// 스타일 성장형 append 목록)를 한 파일에 같이 둔다. profile.ts가 careerGoals를
// profile-overrides.json으로 분리한 이유(이력서 재추출과 무관해야 한다는 캐시-무효화
// 필요성)가 여기엔 아예 없으므로, 굳이 두 파일로 쪼갤 이유가 없다.
const DATA_DIR = join(process.cwd(), "data");
const NARRATIVE_PROFILE_PATH = join(DATA_DIR, "narrative-profile.json");

mkdirSync(DATA_DIR, { recursive: true });

// 과거의 구체적인 한 선택/전환점/실패. situation(무슨 일이 있었나 — 사실)과 reasoning
// (그때 실제로 무엇을 기준으로 판단했나 — 가치관이 드러나는 지점)을 분리해서, 프롬프트에
// 넣을 때 AI가 사실과 동기를 뭉개지 않고 reasoning을 "진짜 이유"로 그대로 인용할 수 있게
// 한다.
export interface NarrativeEpisode {
  id: string;
  promptId: string; // NARRATIVE_SEED_QUESTIONS[].id 참조, 사용자가 만든 질문이면 "custom"
  prompt: string; // 실제 질문 문구 — essay-bank.ts의 EssayEntry.question처럼 id가 아니라
  // 텍스트 자체를 저장해, 나중에 시드 질문 문구가 바뀌어도 과거 항목 표시가 깨지지 않는다.
  title: string; // 목록에 보여줄 짧은 라벨 (예: "휴학하고 독학으로 방향을 튼 이유")
  situation: string;
  reasoning: string;
  lesson: string; // 그 경험이 지금의 가치관/방향에 남긴 것, 지금과 어떻게 이어지는지
  tags: string[]; // SUGGESTED_NARRATIVE_TAGS 중 선택 + 자유 입력 혼용. 스킬이 아니라 가치/
  // 태도/동기 축의 태그.
  source: "seed" | "added"; // seed=최초 시드 질문에 답한 것, added=이후 "경험 추가"로 누적
  createdAt: number;
  updatedAt: number;
}

// episodes보다 훨씬 덜 바뀌는, "본인을 한 줄씩 요약하면" 급 정보 — 매 프롬프트에 전문
// 그대로, 잘리지 않고 들어간다. opennessToNewFields는 "왜 익숙한 분야를 벗어난 도전에도
// 열려 있는가"를 정확히 묻도록 설계된, 이 스키마 전체에서 원거리 직무 매칭 브릿징의 가장
// 직접적인 재료다.
export interface CoreNarrative {
  coreValues: string; // 일/커리어에서 가장 중요하게 여기는 가치관 2~3가지와 그 이유
  workCriteria: string; // 일/회사를 고를 때 실제로 기준 삼는 것, 절대 타협 안 하는 것
  futureDirection: string; // 5~10년 뒤 일을 통해 만들고 싶은 모습과 그 방향을 갖게 된 계기
  opennessToNewFields: string; // 이력서 궤적과 다른 분야/직무에도 관심을 갖는 이유
  updatedAt: number; // 0이면 아직 저장 안 함
}

export interface NarrativeProfile {
  core: CoreNarrative;
  episodes: NarrativeEpisode[];
}

function emptyCoreNarrative(): CoreNarrative {
  return { coreValues: "", workCriteria: "", futureDirection: "", opennessToNewFields: "", updatedAt: 0 };
}

function emptyNarrativeProfile(): NarrativeProfile {
  return { core: emptyCoreNarrative(), episodes: [] };
}

export function readNarrativeProfile(): NarrativeProfile {
  if (!existsSync(NARRATIVE_PROFILE_PATH)) return emptyNarrativeProfile();
  try {
    const parsed = JSON.parse(readFileSync(NARRATIVE_PROFILE_PATH, "utf-8"));
    // applicant-profile.ts와 동일한 필드추가 안전장치: 신규 필드가 예전 저장 파일에 없어도
    // undefined가 되지 않도록 빈 값 위에 덮어쓴다.
    return {
      ...emptyNarrativeProfile(),
      ...parsed,
      core: { ...emptyCoreNarrative(), ...parsed.core },
      episodes: Array.isArray(parsed.episodes) ? parsed.episodes : [],
    };
  } catch {
    return emptyNarrativeProfile();
  }
}

function writeNarrativeProfile(profile: NarrativeProfile): void {
  writeFileSync(NARRATIVE_PROFILE_PATH, JSON.stringify(profile, null, 2));
}

// 설정 페이지의 "핵심 가치관" 섹션(4개 텍스트영역)이 저장 버튼 하나로 통째 PUT —
// applicant-profile.ts의 writeApplicantProfile()과 동일한 전체교체 방식.
export function writeCoreNarrative(core: Omit<CoreNarrative, "updatedAt">): void {
  const profile = readNarrativeProfile();
  profile.core = { ...core, updatedAt: Date.now() };
  writeNarrativeProfile(profile);
}

// 시드 질문에 처음 답할 때도, 이후 "경험 추가" 버튼으로 계속 쌓을 때도 이 함수 하나로
// 처리한다 — essay-bank.ts의 appendEssayEntry와 동일한 append-only 패턴.
export function appendNarrativeEpisode(input: {
  promptId: string;
  prompt: string;
  title: string;
  situation: string;
  reasoning: string;
  lesson: string;
  tags: string[];
  source?: "seed" | "added";
}): void {
  if (!input.situation.trim() && !input.reasoning.trim()) return;
  const profile = readNarrativeProfile();
  const now = Date.now();
  profile.episodes.push({
    id: randomUUID(),
    promptId: input.promptId,
    prompt: input.prompt,
    title: input.title || input.situation.slice(0, 30),
    situation: input.situation,
    reasoning: input.reasoning,
    lesson: input.lesson,
    tags: input.tags,
    source: input.source ?? "added",
    createdAt: now,
    updatedAt: now,
  });
  writeNarrativeProfile(profile);
}

export function updateNarrativeEpisode(
  id: string,
  patch: Partial<Pick<NarrativeEpisode, "title" | "situation" | "reasoning" | "lesson" | "tags">>
): void {
  const profile = readNarrativeProfile();
  const idx = profile.episodes.findIndex((e) => e.id === id);
  if (idx === -1) return;
  profile.episodes[idx] = { ...profile.episodes[idx], ...patch, updatedAt: Date.now() };
  writeNarrativeProfile(profile);
}

export function deleteNarrativeEpisode(id: string): void {
  const profile = readNarrativeProfile();
  profile.episodes = profile.episodes.filter((e) => e.id !== id);
  writeNarrativeProfile(profile);
}

export function isNarrativeProfileFilled(profile: NarrativeProfile): boolean {
  return profile.core.updatedAt > 0 || profile.episodes.length > 0;
}

// buildDraftContext가 호출해 backgroundPromptBlock에 그대로 끼워넣는 프롬프트 조각.
// essay-bank.ts의 summarizeEssayBankForPrompt와 같은 자리지만 선택 로직이 다르다:
// jobKeywords와 겹치는 태그/제목의 episode를 우선하되, 전부 0점이어도(=이력과 먼 직무일
// 때 실제로 가장 흔한 경우) 결과를 비우지 않고 최신순으로 limit개를 채운다 — 태그가 하나도
// 안 겹치는 순간이야말로 이 자료가 가장 필요한 순간이므로 "관련 없어 보이면 생략"이 아니라
// "그래도 넣는다"가 이 함수의 핵심 설계. 별도의 프로그램적 "거리 판정"은 하지 않는다 —
// 모델이 이미 job과 narrativeText 전문을 문맥으로 갖고 있으므로, 우선순위는 호출부의
// 프롬프트 지시문(먼 직무일수록 이 자료를 근거로 쓰라는) 한 줄로 충분하다.
export function summarizeNarrativeForPrompt(
  profile: NarrativeProfile,
  jobKeywords: string[],
  limit = 5
): string {
  const filled = profile.episodes.filter((e) => e.situation.trim() || e.reasoning.trim());
  if (filled.length === 0 && profile.core.updatedAt === 0) return "";

  const kw = jobKeywords.map((k) => k.toLowerCase()).filter(Boolean);
  const scored = filled.map((e) => {
    const haystack = `${e.title} ${e.tags.join(" ")}`.toLowerCase();
    const score = kw.reduce((n, k) => (haystack.includes(k) ? n + 1 : n), 0);
    return { e, score };
  });
  const ranked = scored.sort((a, b) => b.score - a.score || b.e.createdAt - a.e.createdAt);
  const picked = ranked.slice(0, limit).map((r) => r.e);

  const coreLines = [
    profile.core.coreValues && `핵심 가치관: ${profile.core.coreValues}`,
    profile.core.workCriteria && `일/회사를 고르는 기준: ${profile.core.workCriteria}`,
    profile.core.futureDirection && `앞으로의 방향: ${profile.core.futureDirection}`,
    profile.core.opennessToNewFields && `새로운 분야에도 열려 있는 이유: ${profile.core.opennessToNewFields}`,
  ].filter(Boolean);

  const episodeLines = picked.map(
    (e) =>
      `- [${e.tags.join(", ") || "태그 없음"}] ${e.situation.slice(0, 300)}\n  → 진짜 이유: ${e.reasoning.slice(0, 300)}\n  → 지금과의 연결: ${e.lesson.slice(0, 200)}`
  );

  return [...coreLines, picked.length ? "선택/전환점의 진짜 이유:" : "", ...episodeLines]
    .filter(Boolean)
    .join("\n");
}
