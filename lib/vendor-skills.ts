import { readFileSync } from "node:fs";
import { join } from "node:path";

// skills/vendor/의 외부 스킬 원문(MIT)에서 필요한 절만 골라 쓴다. 지금은 경험 카드 추출에만 쓴다 — 자기소개서 작성은
// lib/essay-writer.ts의 짧은 작성 기준으로 바뀌었다. 원문 파일은 고치지 않는다. 출처와 커밋은 skills/vendor/README.md.

const VENDOR_DIR = join(process.cwd(), "skills", "vendor");
const CLT = "cover-letter-team";

function read(path: string): string {
  return readFileSync(join(VENDOR_DIR, path), "utf8");
}

// 마크다운에서 heading으로 시작하는 절을 다음 같은 수준 이상의 heading 전까지 꺼낸다. 코드 블록 안의 #는 heading이 아니다.
export function markdownSection(text: string, heading: string): string {
  const lines = text.split("\n");
  const level = heading.match(/^#+/)?.[0].length ?? 0;
  let inFence = false, start = -1, end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    const m = lines[i].match(/^(#+)\s/);
    if (start < 0) { if (lines[i].trim() === heading) start = i; continue; }
    if (m && m[1].length <= level) { end = i; break; }
  }
  if (start < 0) throw new Error(`외부 스킬 원문에서 "${heading}" 절을 찾지 못했습니다. skills/vendor 파일을 확인해주세요.`);
  return lines.slice(start, end).join("\n").trim();
}

function block(title: string, parts: string[]): string {
  return `[외부 스킬 원문: ${title}]\n${parts.join("\n\n")}\n[외부 스킬 원문 끝]`;
}

export function loadVendorSkills() {
  const interviewer = read(`${CLT}/prompts/interviewer.md`);
  return {
    // 과거 자소서·면접 대본을 경험 카드로 바꿀 때(lib/experience-cards.ts).
    cards: block("cover-letter-team 경험카드", [
      markdownSection(interviewer, "## 경험카드 스키마 (experience-cards.yaml)"),
      markdownSection(interviewer, "## 검증 질문 (경험마다 반드시)"),
      markdownSection(interviewer, "## 구체성 규칙 (날조 유도 방지)"),
    ]),
  };
}
