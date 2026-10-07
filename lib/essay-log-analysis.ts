import { splitSentences } from "./essay-diff";
import { ANONYMIZED_SOURCE, HEDGE, inspectEssayStyle, OPINION_ENDING, type StyleIssueCode } from "./essay-style";

// 자기소개서 작성 기록(essay-log)의 형식과, 기록을 해석하는 순수 함수들. DB에 의존하지 않아 테스트와
// 화면 양쪽에서 쓸 수 있다. 사건(event)마다 "누가, 무엇을 요청했고, 글의 어느 부분이 어떻게 바뀌었으며,
// 어떤 문체 문제가 사라지고 생겼는지"를 남겨, 나중에 사용자가 어디에 불만을 느끼고 무엇을 고치는지 읽어낼 수 있게 한다.

export const ESSAY_EVENT_ACTORS = {
  draft_requested: "user", draft_generated: "ai", draft_failed: "system",
  answer_imported: "user", manual_edit: "user",
  revision_requested: "user", revision_proposed: "ai", revision_needs_info: "ai", revision_failed: "system",
  revision_accepted: "user", revision_discarded: "user", needs_info_dismissed: "user",
  review_requested: "user", review_received: "ai", review_failed: "system",
  suggestion_applied: "user", suggestion_dismissed: "user", feedback_closed: "user",
  research_requested: "user", research_scoped: "ai", research_sources_selected: "user", research_collected: "ai",
  research_failed: "system", research_closed: "user",
  version_restored: "user", saved_to_bank: "user",
} as const;
export type EssayEventType = keyof typeof ESSAY_EVENT_ACTORS;
export type EssayEventActor = (typeof ESSAY_EVENT_ACTORS)[EssayEventType];
export const ESSAY_EVENT_TYPES = Object.keys(ESSAY_EVENT_ACTORS) as EssayEventType[];

export type EssayZone = "도입" | "본문" | "마무리";
export type EssayChangeTag =
  | "어미만 변경" | "단서 제거" | "단서 추가" | "의견형→단정형" | "단정형→의견형"
  | "축약" | "확장" | "문장 분리" | "문장 병합" | "수치 변경" | "익명 출처 제거";

// 연속해서 바뀐 문장 묶음 하나. before/after는 그 묶음의 원문 전체다.
export interface EssaySentenceChange {
  op: "replace" | "insert" | "delete";
  before: string;
  after: string;
  zone: EssayZone;
  paragraph: number; // 1부터. 바꾸기·삭제는 이전 글 기준, 추가는 새 글 기준
  tags: EssayChangeTag[];
}

export interface EssayChangeAnalysis {
  charsBefore: number;
  charsAfter: number;
  sentencesBefore: number;
  sentencesAfter: number;
  unchangedSentences: number;
  changedRatio: number; // 이전 글 문장 중 바뀌거나 지워진 비율(0~1)
  changes: EssaySentenceChange[];
  style: { before: StyleIssueCode[]; after: StyleIssueCode[]; resolved: StyleIssueCode[]; introduced: StyleIssueCode[] };
}

export interface EssayEvent {
  id: string;
  seq: string;
  question: string;
  type: EssayEventType;
  actor: EssayEventActor;
  // 요청 → AI 결과 → 반영/버리기처럼 한 흐름에 속한 사건을 묶는다.
  threadId: string | null;
  textBefore: string | null;
  textAfter: string | null;
  detail: Record<string, unknown>;
  analysis: EssayChangeAnalysis | null;
  createdAt: number;
}

type Op = { type: "same" | "removed" | "added"; a: number; b: number };

function sentenceOps(a: string[], b: string[]): Op[] {
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i][j] = a[i].trim() === b[j].trim() ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i].trim() === b[j].trim()) ops.push({ type: "same", a: i++, b: j++ });
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push({ type: "removed", a: i++, b: j });
    else ops.push({ type: "added", a: i, b: j++ });
  }
  while (i < a.length) ops.push({ type: "removed", a: i++, b: j });
  while (j < b.length) ops.push({ type: "added", a: i, b: j++ });
  return ops;
}

// splitSentences는 줄바꿈을 앞 문장 끝에 붙여두므로, 앞 문장들의 줄바꿈 수로 문단 번호를 센다.
function paragraphOf(sentences: string[], index: number): number {
  let paragraph = 1;
  for (let k = 0; k < Math.min(index, sentences.length); k++) if (/\n/.test(sentences[k])) paragraph++;
  return paragraph;
}

// 문단이 셋 이상이면 첫 문단을 도입, 마지막 문단을 마무리로 본다. 문단 구분이 없는 짧은 글은 문장 위치로 나눈다.
function zoneOf(sentences: string[], index: number): EssayZone {
  const paragraphs = paragraphOf(sentences, sentences.length - 1);
  if (paragraphs >= 3) {
    const paragraph = paragraphOf(sentences, index);
    return paragraph === 1 ? "도입" : paragraph >= paragraphs ? "마무리" : "본문";
  }
  if (sentences.length <= 1) return "본문";
  const ratio = index / sentences.length;
  return ratio < 0.2 ? "도입" : ratio >= 0.8 ? "마무리" : "본문";
}

const count = (text: string, pattern: RegExp) => text.match(new RegExp(pattern.source, "g"))?.length ?? 0;
const numbers = (text: string) => [...(text.match(/\d[\d,.]*%?/g) ?? [])].sort().join("|");
const lastWord = (s: string) => s.trim().replace(/[.!?。！？]+$/, "").split(/\s+/);

function changeTags(removed: string[], added: string[]): EssayChangeTag[] {
  const before = removed.join(" ").trim(), after = added.join(" ").trim();
  const tags: EssayChangeTag[] = [];
  if (removed.length === 1 && added.length === 1) {
    const x = lastWord(before), y = lastWord(after);
    if (x.length === y.length && x.length > 1 && x.slice(0, -1).join(" ") === y.slice(0, -1).join(" ") && x.at(-1) !== y.at(-1))
      tags.push("어미만 변경");
  }
  const hedgeDelta = count(after, HEDGE) - count(before, HEDGE);
  if (hedgeDelta < 0) tags.push("단서 제거");
  if (hedgeDelta > 0) tags.push("단서 추가");
  const opinions = (list: string[]) => list.filter((s) => OPINION_ENDING.test(s.trim())).length;
  const opinionDelta = opinions(added) - opinions(removed);
  if (removed.length && added.length && opinionDelta < 0) tags.push("의견형→단정형");
  if (removed.length && added.length && opinionDelta > 0) tags.push("단정형→의견형");
  if (removed.length && added.length) {
    const ratio = Array.from(after).length / Math.max(1, Array.from(before).length);
    if (ratio < 0.8) tags.push("축약");
    if (ratio > 1.25) tags.push("확장");
    if (removed.length === 1 && added.length >= 2) tags.push("문장 분리");
    if (removed.length >= 2 && added.length === 1) tags.push("문장 병합");
    if (numbers(before) !== numbers(after)) tags.push("수치 변경");
  }
  if (count(before, ANONYMIZED_SOURCE) > count(after, ANONYMIZED_SOURCE)) tags.push("익명 출처 제거");
  return tags;
}

// 두 글의 변화를 AI 없이 해석한다. 바뀐 문장 묶음마다 위치(도입·본문·마무리, 문단)와 성격(축약, 단서 제거 등)을 붙이고,
// 자동 문체 점검 결과를 전후로 비교해 이번 변화로 사라진(resolved)·새로 생긴(introduced) 문제를 남긴다.
export function analyzeEssayChange(before: string, after: string): EssayChangeAnalysis {
  const a = splitSentences(before).filter((s) => s.trim());
  const b = splitSentences(after).filter((s) => s.trim());
  const ops = sentenceOps(a, b);
  const changes: EssaySentenceChange[] = [];
  let removed: Op[] = [], added: Op[] = [];
  const push = (rem: Op[], add: Op[]) => {
    const fromBefore = rem.length > 0;
    const anchor = rem[0] ?? add[0];
    changes.push({
      op: rem.length && add.length ? "replace" : rem.length ? "delete" : "insert",
      before: rem.map((o) => a[o.a]).join("").trim(),
      after: add.map((o) => b[o.b]).join("").trim(),
      zone: fromBefore ? zoneOf(a, anchor.a) : zoneOf(b, anchor.b),
      paragraph: fromBefore ? paragraphOf(a, anchor.a) : paragraphOf(b, anchor.b),
      tags: changeTags(rem.map((o) => a[o.a]), add.map((o) => b[o.b])),
    });
  };
  // 여러 문단에 걸친 큰 묶음(통째로 다시 쓴 경우)은 문단 순서대로 짝지어 나눠야 어느 부분이 어떻게 바뀌었는지 보인다.
  const byParagraph = (list: Op[], sentences: string[], index: (o: Op) => number) => {
    const groups: Op[][] = [];
    let last = -1;
    for (const o of list) {
      const p = paragraphOf(sentences, index(o));
      if (p !== last) groups.push([]);
      groups.at(-1)!.push(o);
      last = p;
    }
    return groups;
  };
  const flush = () => {
    if (!removed.length && !added.length) return;
    const rem = byParagraph(removed, a, (o) => o.a), add = byParagraph(added, b, (o) => o.b);
    if (rem.length > 1 || add.length > 1)
      for (let k = 0; k < Math.max(rem.length, add.length); k++) push(rem[k] ?? [], add[k] ?? []);
    else push(removed, added);
    removed = []; added = [];
  };
  for (const op of ops) {
    if (op.type === "same") flush();
    else if (op.type === "removed") removed.push(op);
    else added.push(op);
  }
  flush();
  const unchanged = ops.filter((o) => o.type === "same").length;
  const styleBefore = inspectEssayStyle(before).map((i) => i.code);
  const styleAfter = inspectEssayStyle(after).map((i) => i.code);
  return {
    charsBefore: Array.from(before).length,
    charsAfter: Array.from(after).length,
    sentencesBefore: a.length,
    sentencesAfter: b.length,
    unchangedSentences: unchanged,
    changedRatio: a.length ? Number(((a.length - unchanged) / a.length).toFixed(3)) : 0,
    changes,
    style: {
      before: styleBefore, after: styleAfter,
      resolved: styleBefore.filter((c) => !styleAfter.includes(c)),
      introduced: styleAfter.filter((c) => !styleBefore.includes(c)),
    },
  };
}

// 본문 안의 구절이 글의 어디쯤(도입·본문·마무리, 몇 번째 문단)에 있는지. 첨삭 제안의 위치를 남기는 데 쓴다.
export function locateInEssay(text: string, phrase: string): { zone: EssayZone; paragraph: number } | null {
  const at = phrase ? text.indexOf(phrase) : -1;
  if (at < 0) return null;
  const sentences = splitSentences(text).filter((s) => s.trim());
  let offset = text.length - sentences.join("").length; // 앞쪽 공백
  for (let i = 0; i < sentences.length; i++) {
    offset += sentences[i].length;
    if (at < offset) return { zone: zoneOf(sentences, i), paragraph: paragraphOf(sentences, i) };
  }
  return null;
}

// ---- 기록 해석 ----

export type RequestOutcome = "반영" | "버림" | "보완 질문" | "실패" | "결과 대기" | "결과 받음" | "작성됨";
export interface UserRequestRecord {
  threadId: string;
  seq: string;
  question: string;
  kind: "새로 쓰기" | "고쳐쓰기" | "첨삭 받기" | "업계 조사";
  text: string; // 사용자가 쓴 요청·관점·보완 지시 원문
  createdAt: number;
  outcome: RequestOutcome;
  // 결과가 글에 반영됐을 때, 실제로 바뀐 위치와 성격
  zones: EssayZone[];
  tags: EssayChangeTag[];
}
export interface SuggestionStats { proposed: number; applied: number; dismissed: number; untouched: number }
export interface EssayLogSummary {
  eventCount: number;
  firstAt: number | null;
  lastAt: number | null;
  byType: Partial<Record<EssayEventType, number>>;
  questions: { seq: string; question: string; events: number; textChanges: number; firstAt: number; lastAt: number }[];
  requests: UserRequestRecord[];
  revisions: { proposed: number; accepted: number; discarded: number; needsInfo: number; failed: number };
  suggestions: Record<string, SuggestionStats>; // 첨삭 카테고리별
  dismissedSuggestions: { category: string; original: string; replacement: string; reason: string; createdAt: number }[];
  manualEdits: {
    count: number;
    zones: Partial<Record<EssayZone, number>>;
    tags: Partial<Record<EssayChangeTag, number>>;
    styleResolved: Partial<Record<StyleIssueCode, number>>; // 사용자가 직접 고쳐서 사라진 문체 문제
    examples: { before: string; after: string; zone: EssayZone; tags: EssayChangeTag[]; createdAt: number }[];
  };
  aiStyleIntroduced: Partial<Record<StyleIssueCode, number>>; // AI 초안·수정본이 새로 만든 문체 문제
}

const bump = <K extends string>(map: Partial<Record<K, number>>, key: K, by = 1) => { map[key] = (map[key] ?? 0) + by; };
const str = (value: unknown) => (typeof value === "string" ? value : "");

// 사건 목록(시간순)을 사람이 읽을 수 있는 통계로 묶는다. 사용자가 무엇을 요청했고 결과를 받아들였는지,
// 어떤 첨삭 유형을 넘기는지, 직접 고칠 때 글의 어느 부분을 어떤 식으로 바꾸는지가 핵심이다.
export function summarizeEssayEvents(input: EssayEvent[], exampleLimit = 30): EssayLogSummary {
  const events = [...input].sort((x, y) => x.createdAt - y.createdAt);
  const summary: EssayLogSummary = {
    eventCount: events.length, firstAt: events[0]?.createdAt ?? null, lastAt: events.at(-1)?.createdAt ?? null,
    byType: {}, questions: [], requests: [],
    revisions: { proposed: 0, accepted: 0, discarded: 0, needsInfo: 0, failed: 0 },
    suggestions: {}, dismissedSuggestions: [],
    manualEdits: { count: 0, zones: {}, tags: {}, styleResolved: {}, examples: [] },
    aiStyleIntroduced: {},
  };
  const questions = new Map<string, EssayLogSummary["questions"][number]>();
  const requests = new Map<string, UserRequestRecord>();
  const proposals = new Map<string, EssayChangeAnalysis | null>();
  const stats = (category: string) => (summary.suggestions[category] ??= { proposed: 0, applied: 0, dismissed: 0, untouched: 0 });
  const request = (e: EssayEvent, kind: UserRequestRecord["kind"], text: string) => {
    if (!e.threadId) return;
    requests.set(e.threadId, { threadId: e.threadId, seq: e.seq, question: e.question, kind, text, createdAt: e.createdAt, outcome: "결과 대기", zones: [], tags: [] });
  };
  const resolve = (e: EssayEvent, outcome: RequestOutcome, analysis?: EssayChangeAnalysis | null) => {
    const record = e.threadId ? requests.get(e.threadId) : undefined;
    if (!record) return;
    record.outcome = outcome;
    if (analysis) {
      record.zones = [...new Set(analysis.changes.map((c) => c.zone))];
      record.tags = [...new Set(analysis.changes.flatMap((c) => c.tags))];
    }
  };

  for (const e of events) {
    bump(summary.byType, e.type);
    const key = `${e.seq}\u0000${e.question}`;
    const q = questions.get(key) ?? { seq: e.seq, question: e.question, events: 0, textChanges: 0, firstAt: e.createdAt, lastAt: e.createdAt };
    q.events++; q.lastAt = e.createdAt;
    if (e.textAfter !== null && e.textBefore !== e.textAfter && e.actor === "user") q.textChanges++;
    if (e.type === "draft_generated") q.textChanges++;
    questions.set(key, q);

    switch (e.type) {
      case "draft_requested": request(e, "새로 쓰기", str(e.detail.guidance)); break;
      case "draft_generated":
        resolve(e, e.detail.status === "needs_info" ? "보완 질문" : "작성됨", e.analysis);
        for (const code of e.analysis?.style.introduced ?? []) bump(summary.aiStyleIntroduced, code);
        break;
      case "draft_failed": resolve(e, "실패"); break;
      case "revision_requested": request(e, "고쳐쓰기", str(e.detail.instruction)); break;
      case "revision_proposed":
        summary.revisions.proposed++;
        if (e.threadId) proposals.set(e.threadId, e.analysis);
        resolve(e, "결과 받음", e.analysis);
        for (const code of e.analysis?.style.introduced ?? []) bump(summary.aiStyleIntroduced, code);
        break;
      case "revision_needs_info": summary.revisions.needsInfo++; resolve(e, "보완 질문"); break;
      case "revision_failed": summary.revisions.failed++; resolve(e, "실패"); break;
      case "revision_accepted": summary.revisions.accepted++; resolve(e, "반영", e.analysis ?? proposals.get(e.threadId ?? "")); break;
      case "revision_discarded": summary.revisions.discarded++; resolve(e, "버림", proposals.get(e.threadId ?? "")); break;
      case "review_requested": request(e, "첨삭 받기", str(e.detail.focus)); break;
      case "review_received": {
        resolve(e, "결과 받음");
        const list = Array.isArray(e.detail.suggestions) ? e.detail.suggestions as { category?: string }[] : [];
        for (const s of list) { const st = stats(str(s.category) || "기타"); st.proposed++; st.untouched++; }
        break;
      }
      case "review_failed": resolve(e, "실패"); break;
      case "suggestion_applied": case "suggestion_dismissed": {
        const st = stats(str(e.detail.category) || "기타");
        if (st.untouched > 0) st.untouched--;
        if (e.type === "suggestion_applied") { st.applied++; resolve(e, "반영"); }
        else {
          st.dismissed++;
          summary.dismissedSuggestions.push({ category: str(e.detail.category), original: str(e.detail.original), replacement: str(e.detail.replacement), reason: str(e.detail.reason), createdAt: e.createdAt });
        }
        break;
      }
      case "research_requested": request(e, "업계 조사", str(e.detail.topic)); break;
      case "research_scoped": case "research_collected": resolve(e, "결과 받음"); break;
      case "research_failed": resolve(e, "실패"); break;
      case "manual_edit": {
        summary.manualEdits.count++;
        for (const change of e.analysis?.changes ?? []) {
          bump(summary.manualEdits.zones, change.zone);
          for (const tag of change.tags) bump(summary.manualEdits.tags, tag);
          summary.manualEdits.examples.push({ before: change.before, after: change.after, zone: change.zone, tags: change.tags, createdAt: e.createdAt });
        }
        for (const code of e.analysis?.style.resolved ?? []) bump(summary.manualEdits.styleResolved, code);
        break;
      }
    }
  }
  summary.questions = [...questions.values()].sort((x, y) => y.lastAt - x.lastAt);
  summary.requests = [...requests.values()].sort((x, y) => y.createdAt - x.createdAt);
  summary.manualEdits.examples = summary.manualEdits.examples.slice(-exampleLimit).reverse();
  summary.dismissedSuggestions = summary.dismissedSuggestions.slice(-exampleLimit).reverse();
  return summary;
}
