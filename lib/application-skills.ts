import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export function loadApplicationSkills() {
  const stages = ["plan", "materials", "write", "review"] as const;
  const instructions = Object.fromEntries(stages.map((stage) => {
    const text = readFileSync(join(process.cwd(), "skills", `application-${stage}`, "SKILL.md"), "utf8");
    if (!text.trim()) throw new Error(`작성 스킬 ${stage}의 지침이 없습니다.`);
    return [stage, text];
  })) as Record<typeof stages[number], string>;
  return { ...instructions, version: createHash("sha256").update(stages.map((stage) => instructions[stage]).join("\n")).digest("hex").slice(0, 16) };
}
