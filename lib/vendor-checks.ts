import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 외부 스킬(skills/vendor)의 검사 스크립트를 원본 그대로 실행한다. 둘 다 파이썬 표준 라이브러리만 쓴다.
//  - jasoseo-plugin style_check.py: 번역투·상투어·일반 명제 등 금지 표현과 문장 길이·1인칭·말버릇 범위(합격작 기준)
//  - cover-letter-team dedup_check.py: 문항 사이의 거의 같은 문장(유사도 0.8 이상) — 같은 소재·문장 재사용
// AI 호출이 없고, 파이썬이 없거나 스크립트가 실패하면 검사를 건너뛴다(본 작업을 막지 않는다).

const VENDOR_DIR = join(process.cwd(), "skills", "vendor");
const STYLE_SCRIPT = join(VENDOR_DIR, "jasoseo-plugin", "skills", "jasoseo", "scripts", "style_check.py");
const DEDUP_SCRIPT = join(VENDOR_DIR, "cover-letter-team", "scripts", "dedup_check.py");
const MAX_STYLE_NOTES = 8;

function runScript(script: string, markdown: string): string | null {
  const file = join(tmpdir(), `findar-check-${randomUUID()}.md`);
  writeFileSync(file, markdown);
  try {
    return execFileSync(process.env.FINDAR_PYTHON || "python3", [script, file], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    // style_check.py는 금지 표현이 있으면 종료 코드 1로 끝나지만 결과는 stdout에 있다.
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout === "string" && stdout.trim()) return stdout;
    console.error("[vendor-checks] 검사 스크립트를 실행하지 못했습니다:", script, error instanceof Error ? error.message : error);
    return null;
  } finally {
    rmSync(file, { force: true });
  }
}

// style_check.py 출력의 "  [분류] 내용" 줄만 모아 검토 메모로 쓴다.
export function parseStyleCheck(output: string): string[] {
  return output.split("\n").map((line) => line.match(/^\s+\[([^\]]+)\]\s*(.+)$/)).filter((m): m is RegExpMatchArray => !!m)
    .map((m) => `[${m[1]}] ${m[2].trim()}`);
}

// 한 답변의 문체 점검. 원본 스크립트는 "## 문항 N" 섹션 단위로 검사한다.
export function jasoseoStyleFindings(answer: string): string[] {
  if (!answer.trim()) return [];
  const output = runScript(STYLE_SCRIPT, `## 문항 1\n${answer.trim()}\n`);
  return output ? parseStyleCheck(output).slice(0, MAX_STYLE_NOTES) : [];
}

export interface DuplicateSentence { questionA: string; questionB: string; sentenceA: string; sentenceB: string; ratio: number }

// dedup_check.py 출력: "[Q-01] ↔ [Q-02] 유사도 0.93" 다음 두 줄에 각 문장.
export function parseDedupCheck(output: string, questions: string[]): DuplicateSentence[] {
  const lines = output.split("\n");
  const result: DuplicateSentence[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\[(Q-\d+)[^\]]*\] ↔ \[(Q-\d+)[^\]]*\] 유사도 ([\d.]+)/);
    if (!m) continue;
    const label = (id: string) => questions[Number(id.slice(2)) - 1] ?? id;
    result.push({ questionA: label(m[1]), questionB: label(m[2]), sentenceA: (lines[i + 1] ?? "").trim(), sentenceB: (lines[i + 2] ?? "").trim(), ratio: Number(m[3]) });
  }
  return result;
}

// 같은 지원서의 여러 답변 사이에서 거의 같은 문장을 찾는다. 원본 스크립트는 "## Q-01 제목" 섹션을 문항으로 본다.
export function duplicateSentences(answers: { question: string; answer: string }[]): DuplicateSentence[] {
  const usable = answers.filter((a) => a.answer.trim());
  if (usable.length < 2) return [];
  const markdown = usable.map((a, i) => `## Q-${String(i + 1).padStart(2, "0")} ${a.question.replace(/\s+/g, " ").slice(0, 60)}\n${a.answer.trim()}\n`).join("\n");
  const output = runScript(DEDUP_SCRIPT, markdown);
  return output ? parseDedupCheck(output, usable.map((a) => a.question)) : [];
}
