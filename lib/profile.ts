import { query } from "@anthropic-ai/claude-agent-sdk";
import { getAIModelId } from "./ai-model-settings";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { basename, join } from "path";
import { hashResumeSources, LEGACY_RESUME_DIR, listPdfsIn, listResumePdfs, RESUME_DIR } from "./resume-files";
import { remapMatchProfileHash } from "./db";

const DATA_DIR = join(process.cwd(), "data");
const PROFILE_PATH = join(DATA_DIR, "profile.json");
const OVERRIDES_PATH = join(DATA_DIR, "profile-overrides.json");

mkdirSync(DATA_DIR, { recursive: true });

export interface ProfileProject {
  name: string;
  role: string;
  stack: string[];
  summary: string;
}

export interface Profile {
  sourcesHash: string;
  generatedAt: number;
  model: string;
  name: string;
  experienceYears: string;
  skills: string[];
  domains: string[];
  projects: ProfileProject[];
  narrative: string;
  // 비개발/비IT 금융 직군(리스크관리, 퀀트 등)에도 적용 가능한 전이 가능 강점.
  // 기존 profile.json 캐시엔 없을 수 있으므로 optional — 소비하는 쪽에서 ?? [] 처리.
  transferableStrengths?: string[];
  // 이력서로는 추론 불가능한, 사용자가 /settings에서 직접 쓰는 지원 의도/방향.
  // 이력서 재추출과 무관하게 매번 최신 값을 병합하므로 optional.
  careerGoals?: string;
}

function readCachedProfile(): Profile | null {
  if (!existsSync(PROFILE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(PROFILE_PATH, "utf-8")) as Profile;
  } catch {
    return null;
  }
}

function writeProfile(profile: Profile): void {
  writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2));
}

// 예전 방식(repo 루트 resume/에 직접 넣은 PDF)의 해시 — 경로/크기/수정시각 기준이었다.
function legacyHashSources(paths: string[]): string {
  const h = createHash("sha256");
  for (const p of paths) {
    const s = statSync(p);
    h.update(`${p}:${s.size}:${s.mtimeMs}\n`);
  }
  return h.digest("hex");
}

// resume/ → data/resume/ 1회 이전. 파일은 삭제하지 않고 옮기기만 하며(같은 이름이 이미
// 업로드돼 있으면 그대로 둔다), 내용이 같으면 기존 프로필 캐시·매칭 결과를 새 해시로
// 바꿔 달아서 재분석/전체 재매칭에 토큰을 쓰지 않는다.
function migrateLegacyResumeDir(): void {
  const legacy = listPdfsIn(LEGACY_RESUME_DIR);
  if (legacy.length === 0) return;
  try {
    const legacyHash = legacyHashSources(legacy);
    mkdirSync(RESUME_DIR, { recursive: true });
    let skipped = 0;
    for (const p of legacy) {
      const dest = join(RESUME_DIR, basename(p));
      if (existsSync(dest)) {
        skipped++;
        continue;
      }
      try {
        renameSync(p, dest);
      } catch {
        copyFileSync(p, dest); // 다른 파일시스템 간 이동(EXDEV) 대비
        unlinkSync(p);
      }
    }
    const cached = readCachedProfile();
    if (skipped === 0 && cached?.sourcesHash === legacyHash) {
      const newHash = hashResumeSources(listResumePdfs());
      writeProfile({ ...cached, sourcesHash: newHash });
      remapMatchProfileHash(legacyHash, newHash);
    }
    console.log(`[profile] moved ${legacy.length - skipped} legacy resume file(s) to data/resume`);
  } catch (e) {
    console.error("[profile] legacy resume migration failed:", e);
  }
}

migrateLegacyResumeDir();

// careerGoals는 이력서 추출(sourcesHash)과 무관한 별도 저장소에 둔다 — 사용자가
// /settings에서 언제든 바꿀 수 있어야 하고, 그때마다 이력서를 재분석할 필요는 없으므로.
export function readCareerGoals(): string {
  if (!existsSync(OVERRIDES_PATH)) return "";
  try {
    const parsed = JSON.parse(readFileSync(OVERRIDES_PATH, "utf-8"));
    return typeof parsed.careerGoals === "string" ? parsed.careerGoals : "";
  } catch {
    return "";
  }
}

export function writeCareerGoals(careerGoals: string): void {
  writeFileSync(OVERRIDES_PATH, JSON.stringify({ careerGoals }, null, 2));
}

async function extractProfile(
  pdfPaths: string[],
  sourcesHash: string,
  model: string
): Promise<Profile> {
  const fileList = pdfPaths.map((p) => `- ${p}`).join("\n");

  const prompt = `다음 PDF 파일들을 모두 Read 도구로 읽고 지원자의 프로필을 추출해.
이력서와 포트폴리오가 섞여 있을 수 있으니 전부 읽고 종합해야 해.

파일 목록:
${fileList}

모든 파일을 읽은 후, 아래 JSON 형식으로만 응답해. 마크다운이나 설명 없이 순수 JSON만.

{
  "name": "지원자 이름",
  "experienceYears": "경력 연차 (예: 신입, 2년, 인턴 6개월)",
  "skills": ["보유 기술/스택 리스트"],
  "domains": ["관심/경험 도메인 (예: 금융, 백엔드, 데이터)"],
  "projects": [
    {
      "name": "프로젝트명",
      "role": "역할",
      "stack": ["사용 기술"],
      "summary": "1-2문장 요약 (성과/임팩트 포함)"
    }
  ],
  "narrative": "지원자를 채용담당자에게 소개하는 2-3단락 텍스트. 강점과 차별점 위주로 자연스럽게.",
  "transferableStrengths": [
    "개발/데이터 등 IT 역량을 비개발 금융 직군(리스크관리, 퀀트, 컴플라이언스 등)에 적용할 수 있는 지점을 구체적으로 서술. 예: '복잡한 데이터 파이프라인 설계 경험 → 리스크/퀀트 분석 자동화에 적용 가능'. 지원자가 IT 외 직군에도 지원 가능성을 열어두고 있다는 전제로 작성."
  ]
}`;

  let resultText = "";
  for await (const message of query({
    prompt,
    options: {
      model,
      maxTurns: 10,
      allowedTools: ["Read"],
    },
  })) {
    if ("result" in message) {
      resultText = message.result;
    }
  }

  const jsonMatch =
    resultText.match(/```(?:json)?\s*([\s\S]*?)```/) ||
    resultText.match(/(\{[\s\S]*\})/);
  const parsed = JSON.parse(jsonMatch?.[1]?.trim() || "{}");

  return {
    sourcesHash,
    generatedAt: Date.now(),
    model,
    name: parsed.name || "",
    experienceYears: parsed.experienceYears || "",
    skills: Array.isArray(parsed.skills) ? parsed.skills : [],
    domains: Array.isArray(parsed.domains) ? parsed.domains : [],
    projects: Array.isArray(parsed.projects) ? parsed.projects : [],
    narrative: parsed.narrative || "",
    transferableStrengths: Array.isArray(parsed.transferableStrengths)
      ? parsed.transferableStrengths
      : [],
  };
}

export interface ProfileResult {
  profile: Profile | null;
  status: "missing" | "cached" | "extracted" | "error";
  error?: string;
}

function withCareerGoals(profile: Profile | null): Profile | null {
  if (!profile) return profile;
  return { ...profile, careerGoals: readCareerGoals() };
}

// 같은 이력서에 대한 추출이 동시에 두 번 돌지 않도록(공고 새로고침 + 설정 화면의 "지금 분석")
// 진행 중인 추출을 해시별로 공유한다.
const state = globalThis as typeof globalThis & { findarProfileInflight?: Map<string, Promise<ProfileResult>> };
const inflight = (state.findarProfileInflight ??= new Map<string, Promise<ProfileResult>>());

export async function ensureProfile(opts?: {
  onProgress?: (msg: string) => void;
}): Promise<ProfileResult> {
  const pdfs = listResumePdfs();
  if (pdfs.length === 0) {
    return { profile: null, status: "missing" };
  }

  const currentHash = hashResumeSources(pdfs);
  const model = getAIModelId("profile");
  const key = JSON.stringify([currentHash, model]);
  const cached = readCachedProfile();
  if (cached && cached.sourcesHash === currentHash && cached.model === model) {
    return { profile: withCareerGoals(cached), status: "cached" };
  }

  const running = inflight.get(key);
  if (running) {
    opts?.onProgress?.("이력서 분석이 이미 진행 중입니다. 완료를 기다리는 중...");
    return running;
  }
  const task = runExtraction(pdfs, currentHash, cached, model, opts);
  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}

async function runExtraction(
  pdfs: string[],
  currentHash: string,
  cached: Profile | null,
  model: string,
  opts?: { onProgress?: (msg: string) => void }
): Promise<ProfileResult> {
  opts?.onProgress?.(
    cached
      ? "이력서 또는 모델 설정이 변경되어 다시 분석 중..."
      : `이력서/포트폴리오 ${pdfs.length}개 분석 중...`
  );

  try {
    const profile = await extractProfile(pdfs, currentHash, model);
    writeProfile(profile);
    return { profile: withCareerGoals(profile), status: "extracted" };
  } catch (e) {
    console.error("[profile] extraction failed:", e);
    return {
      profile: withCareerGoals(cached),
      status: "error",
      error: (e as Error).message,
    };
  }
}

export function getCachedProfile(): Profile | null {
  return withCareerGoals(readCachedProfile());
}

// 설정 화면용: AI 호출 없이 현재 업로드된 파일과 캐시된 분석 결과가 일치하는지만 확인한다.
export function getProfileStatus(): {
  status: "missing" | "not-analyzed" | "stale" | "ready";
  analyzing: boolean;
  profile: Pick<Profile, "name" | "experienceYears" | "skills" | "domains" | "generatedAt"> | null;
} {
  const pdfs = listResumePdfs();
  const cached = readCachedProfile();
  const summary = cached
    ? { name: cached.name, experienceYears: cached.experienceYears, skills: cached.skills, domains: cached.domains, generatedAt: cached.generatedAt }
    : null;
  if (pdfs.length === 0) return { status: "missing", analyzing: false, profile: summary };
  const currentHash = hashResumeSources(pdfs);
  const model = getAIModelId("profile");
  const key = JSON.stringify([currentHash, model]);
  const analyzing = inflight.has(key);
  if (!cached) return { status: "not-analyzed", analyzing, profile: null };
  return { status: cached.sourcesHash === currentHash && cached.model === model ? "ready" : "stale", analyzing, profile: summary };
}
