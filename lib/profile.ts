import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { createHash } from "crypto";
import { join } from "path";

const RESUME_DIR = join(process.cwd(), "resume");
const DATA_DIR = join(process.cwd(), "data");
const PROFILE_PATH = join(DATA_DIR, "profile.json");

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
}

function listResumePdfs(): string[] {
  if (!existsSync(RESUME_DIR)) return [];
  return readdirSync(RESUME_DIR)
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .map((f) => join(RESUME_DIR, f))
    .sort();
}

function hashSources(paths: string[]): string {
  const h = createHash("sha256");
  for (const p of paths) {
    const s = statSync(p);
    h.update(`${p}:${s.size}:${s.mtimeMs}\n`);
  }
  return h.digest("hex");
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

async function extractProfile(
  pdfPaths: string[],
  sourcesHash: string
): Promise<Profile> {
  const model = "claude-sonnet-4-6";
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
  "narrative": "지원자를 채용담당자에게 소개하는 2-3단락 텍스트. 강점과 차별점 위주로 자연스럽게."
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
  };
}

export interface ProfileResult {
  profile: Profile | null;
  status: "missing" | "cached" | "extracted" | "error";
  error?: string;
}

export async function ensureProfile(opts?: {
  onProgress?: (msg: string) => void;
}): Promise<ProfileResult> {
  const pdfs = listResumePdfs();
  if (pdfs.length === 0) {
    return { profile: null, status: "missing" };
  }

  const currentHash = hashSources(pdfs);
  const cached = readCachedProfile();
  if (cached && cached.sourcesHash === currentHash) {
    return { profile: cached, status: "cached" };
  }

  opts?.onProgress?.(
    cached
      ? "이력서가 변경되어 다시 분석 중..."
      : `이력서/포트폴리오 ${pdfs.length}개 분석 중...`
  );

  try {
    const profile = await extractProfile(pdfs, currentHash);
    writeProfile(profile);
    return { profile, status: "extracted" };
  } catch (e) {
    console.error("[profile] extraction failed:", e);
    return {
      profile: cached ?? null,
      status: "error",
      error: (e as Error).message,
    };
  }
}

export function getCachedProfile(): Profile | null {
  return readCachedProfile();
}
