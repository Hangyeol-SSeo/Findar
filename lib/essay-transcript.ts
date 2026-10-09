import type { ConversationHistory } from "./ai-conversation";
import { listEssayEventRowsAfter } from "./db";
import type { EssayChangeAnalysis, EssayEventType } from "./essay-log-analysis";

// 자기소개서 작업 대화의 기억: essay_events(작성 기록)를 대화에 넣을 글로 바꾼다. 기록이 원본이라 모델을 바꾸거나
// 세션을 새로 시작해도 같은 기억을 이어받는다. 사건 하나의 표현은 그 사건만으로 정해져(뒤의 사건에 따라 바뀌지 않음)
// 기록이 늘어도 앞부분이 그대로 유지된다 — 모델 쪽 캐시가 앞부분을 다시 쓸 수 있게 하기 위해서다.

export interface TranscriptEvent {
  rowid: number;
  question: string;
  type: EssayEventType | string;
  textBefore: string | null;
  textAfter: string | null;
  detail: Record<string, unknown>;
  analysis: EssayChangeAnalysis | null;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).filter(Boolean) : []);
const label = (question: string) => `「${question.length > 80 ? `${question.slice(0, 80)}…` : question}」`;

// 바뀐 문장만. 분석이 없으면(예전 기록) 바뀐 뒤 전문을 넣는다.
function changes(e: TranscriptEvent): string {
  const items = e.analysis?.changes ?? [];
  if (!items.length) return e.textAfter ? `바뀐 뒤 전문:\n${e.textAfter}` : "(바뀐 문장 없음)";
  return items.map((c) => c.op === "insert" ? `- 추가(${c.zone}): “${c.after}”`
    : c.op === "delete" ? `- 삭제(${c.zone}): “${c.before}”`
    : `- (${c.zone}) “${c.before}” → “${c.after}”`).join("\n");
}

function suggestion(d: Record<string, unknown>): string {
  return `[${str(d.category) || "제안"}] “${str(d.original)}” → “${str(d.replacement) || "(삭제)"}”${str(d.reason) ? ` — ${str(d.reason)}` : ""}`;
}

// omitBody: 이후 새 글로 대체된 오래된 본문을 생략할 때(새 세션의 기록 정리용).
export function renderEssayEvent(e: TranscriptEvent, omitBody = false): string | null {
  const q = label(e.question);
  const d = e.detail ?? {};
  const body = (text: string | null) => (omitBody ? "(이후 새 글로 대체되어 본문 생략)" : text ?? "");
  switch (e.type) {
    case "task_cancel_requested": return `${q} 사용자가 진행 중인 AI 작업을 취소했다.`;
    case "draft_requested": return `${q} 사용자: 새로 작성 요청${str(d.guidance) ? ` — 추가 요청: ${str(d.guidance)}` : ""}${d.maxChars ? ` (글자 수 ${d.maxChars}자 이내)` : ""}`;
    case "draft_generated": return e.textAfter
      ? `${q} AI 작성 결과:\n${body(e.textAfter)}`
      : `${q} AI가 쓰지 못하고 보완 질문을 남겼다: ${list(d.missingInfo).join(" / ")}`;
    case "draft_failed": return `${q} AI 작성 실패: ${str(d.error)}`;
    case "answer_imported": return `${q} 사용자가 직접 쓴 글을 가져왔다:\n${body(e.textAfter)}`;
    case "manual_edit": return `${q} 사용자가 직접 고쳤다:\n${changes(e)}`;
    case "revision_requested": return `${q} 사용자 고쳐쓰기 요청: ${str(d.instruction)}`;
    case "revision_proposed": return `${q} AI 수정본 제안${list(d.changeSummary).length ? ` — ${list(d.changeSummary).join("; ")}` : ""}:\n${changes(e)}`;
    case "revision_needs_info": return `${q} AI가 고쳐쓰기에 필요한 정보를 물었다: ${list(d.questions).join(" / ")}`;
    case "revision_failed": return `${q} 고쳐쓰기 실패: ${str(d.error)}`;
    case "revision_accepted": return `${q} 사용자가 수정본을 반영했다.`;
    case "revision_discarded": return `${q} 사용자가 수정본을 버렸다(원하지 않음).`;
    case "needs_info_dismissed": return `${q} 사용자가 보완 질문을 닫았다.`;
    case "review_requested": return `${q} 사용자 첨삭 받기 요청${str(d.focus) ? ` — 중점: ${str(d.focus)}` : ""}`;
    case "review_received": {
      const suggestions = Array.isArray(d.suggestions) ? (d.suggestions as Record<string, unknown>[]).map(suggestion) : [];
      return `${q} AI 첨삭: ${str(d.summary)}${list(d.issues).length ? `\n보완할 점: ${list(d.issues).join(" / ")}` : ""}${suggestions.length ? `\n제안:\n${suggestions.map((s) => `- ${s}`).join("\n")}` : ""}`;
    }
    case "review_failed": return `${q} 첨삭 실패: ${str(d.error)}`;
    case "suggestion_applied": return `${q} 사용자가 첨삭 제안을 반영했다: ${suggestion(d)}`;
    case "suggestion_dismissed": return `${q} 사용자가 첨삭 제안을 넘겼다(원하지 않음): ${suggestion(d)}`;
    case "feedback_closed": {
      const untouched = Array.isArray(d.untouched) ? d.untouched.length : 0;
      return `${q} 사용자가 첨삭을 닫았다${untouched ? ` — 손대지 않은 제안 ${untouched}개` : ""}.`;
    }
    case "research_requested": return `${q} 사용자 업계 사례 조사 요청: ${str(d.topic) || str(d.instruction)}`;
    case "research_scoped": return `${q} AI가 조사 후보를 찾았다${str(d.direction) ? ` — ${str(d.direction)}` : ""}.`;
    case "research_sources_selected": return `${q} 사용자가 조사할 출처를 골랐다${str(d.direction) ? ` — 방향: ${str(d.direction)}` : ""}.`;
    case "research_collected": {
      const findings = Array.isArray(d.findings) ? (d.findings as Record<string, unknown>[]).map((f) => `- ${str(f.fact)}${str(f.title) ? ` (${str(f.title)})` : ""}`) : [];
      return `${q} AI가 조사 결과를 모았다${findings.length ? `:\n${findings.join("\n")}` : "."}`;
    }
    case "research_failed": return `${q} 업계 조사 실패: ${str(d.error)}`;
    case "research_closed": return `${q} 사용자가 업계 조사를 닫았다.`;
    case "version_restored": return `${q} 사용자가 ${d.versionNumber ?? "이전"}번째 버전으로 되돌렸다:\n${body(e.textAfter)}`;
    case "saved_to_bank": return `${q} 사용자가 이 답변을 확정한 자료로 저장했다.`;
    default: return null;
  }
}

const BODY_TYPES = new Set(["draft_generated", "answer_imported", "version_restored"]);

// 새 세션에 넣을 전체 기록(budget 글자 이내). 길면 먼저 문항마다 가장 최근 본문만 남기고 그 전의 본문(이후 새 글로 대체됨)을
// 생략한다 — 요청·반영·버림·제안 같은 사용자 판단은 남긴다(무엇을 원하고 무엇을 싫어했는지가 첨삭에서 가장 필요한 기억이다).
// 그래도 넘치면 오래된 사건부터 덜어내고 몇 건을 덜었는지 적는다. 문항별 최신 본문은 작업 지시에도 따로 들어간다.
export function renderEssayTranscript(events: TranscriptEvent[], budget = 40_000, redact: (text: string) => string = (t) => t): string {
  const render = (omit: (e: TranscriptEvent) => boolean) =>
    events.map((e) => renderEssayEvent(e, omit(e))).filter((x): x is string => !!x).map(redact);
  const full = render(() => false);
  if (full.join("\n\n").length <= budget) return full.join("\n\n");
  const latestBody = new Map<string, number>();
  for (const e of events) if (BODY_TYPES.has(e.type) && e.textAfter) latestBody.set(e.question, e.rowid);
  const compact = render((e) => BODY_TYPES.has(e.type) && !!e.textAfter && latestBody.get(e.question) !== e.rowid);
  const kept: string[] = [];
  let size = 0;
  for (let i = compact.length - 1; i >= 0 && size + compact[i].length + 2 <= budget; i--) { kept.unshift(compact[i]); size += compact[i].length + 2; }
  const dropped = compact.length - kept.length;
  return `${dropped ? `(오래된 기록 ${dropped}건은 길어서 생략)\n\n` : ""}${kept.join("\n\n")}`;
}

function parse<T>(text: string | null, fallback: T): T {
  try { return text ? JSON.parse(text) as T : fallback; } catch { return fallback; }
}

// redact: 공통 자료와 같은 가림 처리(다른 지원 회사·학교·프로젝트 이름 → [비공개 명칭]). 직접 쓴 글·고친 문장·버린 수정본에
// 남은 이름이 대화에 들어가 답변으로 새어 나오지 않게 한다.
export function essayHistory(seq: string, redact: (text: string) => string = (t) => t): ConversationHistory {
  return {
    render(afterRowid, budget) {
      const rows = listEssayEventRowsAfter(seq, afterRowid ?? 0);
      const events: TranscriptEvent[] = rows.map((r) => ({
        rowid: r.rowid, question: r.question, type: r.type, textBefore: r.textBefore, textAfter: r.textAfter,
        detail: parse(r.detail, {}), analysis: parse(r.analysis, null),
      }));
      const lastRowid = rows.at(-1)?.rowid ?? afterRowid ?? 0;
      return {
        text: afterRowid === null ? renderEssayTranscript(events, budget, redact)
          : events.map((e) => renderEssayEvent(e)).filter((x): x is string => !!x).map(redact).join("\n\n"),
        lastRowid,
      };
    },
  };
}
