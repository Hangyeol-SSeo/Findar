import { readFileSync } from "node:fs";
import { join } from "node:path";

// skills/vendor/의 외부 스킬 원문(MIT)에서 필요한 절만 골라 Findar의 각 단계 지침으로 붙인다.
// 원문 파일은 고치지 않고, 원문이 전제하는 대화형 인터뷰·작업 폴더·YAML·승인 해시를 Findar에서 무엇으로
// 대신하는지는 여기의 연결 문구(VENDOR_CONTEXT)로만 설명한다. 출처와 커밋은 skills/vendor/README.md.

const VENDOR_DIR = join(process.cwd(), "skills", "vendor");
const CLT = "cover-letter-team";
const JASOSEO_REF = "jasoseo-plugin/skills/jasoseo/references";
const IM_NOT_AI_REF = "im-not-ai/skills/humanize-korean/references";

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

// 원문 용어와 Findar 자료의 대응. 원문은 사람과 대화하며 파일을 만드는 흐름이라, 이 작업에서 하지 않는 일을 분명히 한다.
const VENDOR_CONTEXT = `[외부 스킬 원문을 Findar에서 읽는 법]
원문의 EXP 경험카드는 card.* 자료(사용자가 확인한 경험 카드), RSH 회사 사실은 company.* 자료, FIT 회사 접점은 사용자가 직접 쓴 지원 동기·가치관 자료(user.current.*, memory.*)다. resume.*·profile.*·past.*는 사용자가 확인한 이력 자료다.
원문의 사용자 인터뷰·질문은 할 수 없으므로 missingInfo 질문으로 남긴다. YAML·claim-map·승인 해시·스크립트 실행·파일 저장·Director/Researcher 회송은 이 작업에서 하지 않는다(코드가 따로 검사한다). 출력 형식은 원문이 아니라 이 프롬프트가 요구하는 JSON을 따른다.`;

// im-not-ai의 범용 한국어 윤문 규칙을 자소서 편집에 쓸 때의 대응. Findar의 사실 근거·합쇼체 규칙과 jasoseo 문장 길이 기준이 우선한다.
const IM_NOT_AI_CONTEXT = `[im-not-ai 규칙을 Findar 자기소개서에서 읽는 법]
아래는 AI가 쓴 한국어 글의 티를 줄이는 범용 규칙이다. 자기소개서이므로 합쇼체를 유지하고, 사실·수치·고유명사·근거 인용은 위 사실 규칙대로 바꾸지 않는다.
문장 길이와 리듬(E 범주, 특히 "100자 넘는 장문 만들기")은 적용하지 않는다 — 문장 길이는 jasoseo·Findar 기준을 따른다. 원문의 final.md·run_id·변경률 스크립트·등급 표기 같은 실행 절차는 하지 않고, 결과는 이 프롬프트가 요구하는 JSON으로 낸다.`;

export function loadVendorSkills() {
  const interviewer = read(`${CLT}/prompts/interviewer.md`);
  const writer = read(`${CLT}/prompts/writer.md`);
  const reviewer = read(`${CLT}/prompts/reviewer.md`);
  const gaps = read(`${CLT}/references/intake-and-gaps.md`);
  const quality = read(`${CLT}/references/content-quality.md`);
  const patterns = read(`${JASOSEO_REF}/소제목_문항패턴.md`);
  const quickRules = read(`${IM_NOT_AI_REF}/quick-rules.md`);
  // 규칙 머리말(Do-NOT·서법 보존·내용 앵커·과윤문 가드)은 첫 범주 앞에 있다. 파일 생성 안내 주석은 뺀다.
  const quickRulesPreamble = quickRules.slice(0, quickRules.indexOf("\n## A.")).replace(/<!--[\s\S]*?-->/g, "").trim();
  return {
    // 과거 자소서·면접 대본을 경험 카드로 바꿀 때.
    cards: block("cover-letter-team 경험카드", [
      markdownSection(interviewer, "## 경험카드 스키마 (experience-cards.yaml)"),
      markdownSection(interviewer, "## 검증 질문 (경험마다 반드시)"),
      markdownSection(interviewer, "## 구체성 규칙 (날조 유도 방지)"),
    ]),
    // 문항 요구와 근거의 대응(어느 소재를 어디에 쓸지, 쓸 소재가 없는지).
    materials: `${VENDOR_CONTEXT}\n${block("cover-letter-team 요건-근거 대응, jasoseo 소재 배분", [
      read(`${CLT}/prompts/evidence-planner.md`).trim(),
      markdownSection(gaps, "## 충분성"),
      markdownSection(gaps, "## 갭 상태와 처리"),
      markdownSection(patterns, "## 2. 문항 유형과 소재 배분"),
    ])}`,
    write: `${VENDOR_CONTEXT}\n${block("cover-letter-team 작성, jasoseo 본문 구성", [
      markdownSection(writer, "## 사실·의사·해석"),
      markdownSection(writer, "## 풍부함의 기준"),
      markdownSection(patterns, "## 3. 본문 구성"),
      markdownSection(patterns, "### 4-2. 다듬을 것"),
    ])}`,
    // AI 문체 점검. 생성의 편집 단계와 첨삭 받기에만 쓴다(고쳐쓰기는 사용자가 요청한 부분만 고친다).
    humanize: `${IM_NOT_AI_CONTEXT}\n${block("im-not-ai 한국어 AI 문체 규칙", [
      quickRulesPreamble,
      ...["## A. 번역투 (Translation-ese) — S1~S2", "## C. 구조적 AI 패턴 (서식·레이아웃) — S1~S2", "## D. AI 특유의 관용구 (Signature Phrases) — S1",
        "## F. 과도한 수식·중복 — S2", "## G. 과도한 Hedging (완곡) — S2", "## H. 접속사 남발 — S2", "## I. 형식명사·의존명사 과다 — S2"]
        .map((heading) => markdownSection(quickRules, heading)),
      markdownSection(quickRules, "## 자체검증 체크리스트 (monolith 윤문 후 자가 점검)"),
    ])}`,
    review: `${VENDOR_CONTEXT}\n${block("cover-letter-team 검토와 내용 완성도", [
      markdownSection(reviewer, "## 검사"),
      markdownSection(quality, "## 엄격하게 볼 것"),
      markdownSection(quality, "## 문항별 판정"),
    ])}`,
  };
}
