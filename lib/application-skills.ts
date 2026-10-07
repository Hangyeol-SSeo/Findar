import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadVendorSkills } from "./vendor-skills";

export function loadApplicationSkills() {
  const stages = ["plan", "materials", "write", "review"] as const;
  const instructions = Object.fromEntries(stages.map((stage) => {
    const text = readFileSync(join(process.cwd(), "skills", `application-${stage}`, "SKILL.md"), "utf8");
    if (!text.trim()) throw new Error(`작성 스킬 ${stage}의 지침이 없습니다.`);
    return [stage, text];
  })) as Record<typeof stages[number], string>;
  // 소재 배치·작성·검토에는 외부 스킬 원문(skills/vendor)의 해당 절을 Findar 지침 뒤에 붙인다.
  const vendor = loadVendorSkills();
  instructions.materials = `${instructions.materials}\n${vendor.materials}`;
  instructions.write = `${instructions.write}\n${vendor.write}`;
  instructions.review = `${instructions.review}\n${vendor.review}`;
  return { ...instructions, version: createHash("sha256").update(stages.map((stage) => instructions[stage]).join("\n")).digest("hex").slice(0, 16) };
}
