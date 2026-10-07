import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 외부 스킬(skills/vendor)의 검사 스크립트를 원본 그대로 실행한다. 모두 파이썬 표준 라이브러리만 쓴다.
//  - jasoseo-plugin style_check.py: 번역투·상투어·일반 명제 등 금지 표현과 문장 길이·1인칭·말버릇 범위(합격작 기준)
//  - cover-letter-team dedup_check.py: 문항 사이의 거의 같은 문장(유사도 0.8 이상) — 같은 소재·문장 재사용
//  - im-not-ai metrics_v2.py: 한국어 AI 문체 위험도(사람·AI 글 기준값 대비)와 증거 구절, 이중 피동 등 번역투 계수, 변경률
// AI 호출이 없고, 파이썬이 없거나 스크립트가 실패하면 검사를 건너뛴다(본 작업을 막지 않는다).

const VENDOR_DIR = join(process.cwd(), "skills", "vendor");
const STYLE_SCRIPT = join(VENDOR_DIR, "jasoseo-plugin", "skills", "jasoseo", "scripts", "style_check.py");
const DEDUP_SCRIPT = join(VENDOR_DIR, "cover-letter-team", "scripts", "dedup_check.py");
const IM_NOT_AI_DIR = join(VENDOR_DIR, "im-not-ai", "skills", "humanize-korean", "references");
const MAX_STYLE_NOTES = 8;
const PYTHON = () => process.env.FINDAR_PYTHON || "python3";

function runScript(script: string, markdown: string): string | null {
  const file = join(tmpdir(), `findar-check-${randomUUID()}.md`);
  writeFileSync(file, markdown);
  try {
    return execFileSync(PYTHON(), [script, file], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] });
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

// im-not-ai metrics_v2.py의 JSON 결과에서 자소서에 의미 있는 항목만 메모로 만든다. 원본이 경고하듯 계수 하나만으로는 판정하지
// 않는다: 위험도(risk_band)는 원본의 다계열 판정을 그대로 쓰고, 계수는 quick-rules의 임계값을 넘을 때만 알린다.
// "~다" 연속 종결(da_streak) 같은 지표는 합쇼체 자소서에서 늘 높게 나오므로 쓰지 않는다.
export function parseImNotAiMetrics(result: Record<string, unknown>): string[] {
  const notes: string[] = [];
  const band = String(result.risk_band ?? "");
  const evidence = (result.evidence ?? {}) as { conclusion_pivots?: unknown; safe_balances?: unknown };
  const spans = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  if (band === "medium" || band === "high")
    notes.push(`AI 문체 위험도 ${band === "high" ? "높음" : "중간"}(점수 ${result.risk_score}) — 쉼표·어휘·결론 전환 표현이 AI 글 쪽 분포에 가깝습니다`);
  const pivots = spans(evidence.conclusion_pivots), balances = spans(evidence.safe_balances);
  if (pivots.length >= 2) notes.push(`결론 전환 표현 반복(${pivots.length}회): ${pivots.slice(0, 3).map((p) => `“${p.slice(0, 40)}”`).join(", ")}`);
  if (balances.length >= 2) notes.push(`양쪽 다 챙기는 안전한 균형 표현 반복(${balances.length}회): ${balances.slice(0, 3).map((p) => `“${p.slice(0, 40)}”`).join(", ")}`);
  const v2 = (result.v2_metrics ?? {}) as Record<string, unknown>;
  const count = (k: string) => (typeof v2[k] === "number" ? (v2[k] as number) : 0);
  if (count("antithesis_count") >= 2) notes.push(`"A가 아니라 B" 대구 ${count("antithesis_count")}회(C-8) — 한 번만 살리고 나머지는 평서문으로`);
  if (count("double_passive_count") >= 1) notes.push(`이중 피동 ${count("double_passive_count")}회(A-8, "~되어지다/~지게 되다")`);
  if (count("have_make_literal_count") >= 1) notes.push(`"가지고 있다" 류 직역 ${count("have_make_literal_count")}회(A-7)`);
  if (count("by_passive_count") >= 2) notes.push(`"~에 의해" 피동 ${count("by_passive_count")}회(A-9) — 행위자를 주어로`);
  if (count("double_particle_count") >= 1) notes.push(`이중 조사 ${count("double_particle_count")}회(A-19, "~에서의/~으로의" 등)`);
  return notes;
}

export function imNotAiFindings(answer: string): string[] {
  if (!answer.trim()) return [];
  const id = randomUUID();
  const input = join(tmpdir(), `findar-humanize-${id}.txt`), output = join(tmpdir(), `findar-humanize-${id}.json`);
  writeFileSync(input, answer.trim());
  try {
    execFileSync(PYTHON(), [join(IM_NOT_AI_DIR, "metrics_v2.py"), "--input", input, "--genre", "essay", "--output", output],
      { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "ignore", "ignore"] });
    return parseImNotAiMetrics(JSON.parse(readFileSync(output, "utf8")));
  } catch (error) {
    console.error("[vendor-checks] im-not-ai 측정을 실행하지 못했습니다:", error instanceof Error ? error.message : error);
    return [];
  } finally {
    rmSync(input, { force: true });
    rmSync(output, { force: true });
  }
}

// im-not-ai의 변경률(원본 change_rate 함수 그대로, 30% 경고·50% 중단 기준). 고쳐쓰기가 요청 범위를 넘어 바꿨는지 보는 데 쓴다.
export function imNotAiChangeRate(before: string, after: string): number | null {
  const id = randomUUID();
  const a = join(tmpdir(), `findar-cr-${id}-a.txt`), b = join(tmpdir(), `findar-cr-${id}-b.txt`);
  writeFileSync(a, before);
  writeFileSync(b, after);
  try {
    const code = "import sys; sys.path.insert(0, sys.argv[1]); import metrics_v2 as m; print(m.change_rate(open(sys.argv[2], encoding='utf-8').read(), open(sys.argv[3], encoding='utf-8').read()))";
    const value = Number(execFileSync(PYTHON(), ["-c", code, IM_NOT_AI_DIR, a, b], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] }).trim());
    return Number.isFinite(value) ? value : null;
  } catch (error) {
    console.error("[vendor-checks] im-not-ai 변경률을 계산하지 못했습니다:", error instanceof Error ? error.message : error);
    return null;
  } finally {
    rmSync(a, { force: true });
    rmSync(b, { force: true });
  }
}
