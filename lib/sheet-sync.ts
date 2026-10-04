import {
  clearSheetSyncPending,
  getApplication,
  getApplicationRole,
  getJobBySeq,
  getPendingSheetSyncSeqs,
  markSheetSyncPending,
  recordSheetSyncFailure,
} from "./db";
import type { ApplicationStatus } from "./application-status";

// 지원 상태가 바뀌면 사용자의 지원 현황 Google 시트에 한 행씩 기록한다.
// 시트 쪽에는 scripts/google-sheet-sync.gs(Apps Script 웹 앱)를 배포해 두고, 그 URL과 토큰을
// FINDAR_SHEET_SYNC_URL / FINDAR_SHEET_SYNC_TOKEN으로 넘긴다. 둘 중 하나라도 없으면 아무것도 안 한다.
// 시트 전송이 실패해도 상태 저장은 이미 끝난 뒤이고, seq를 sheet_sync_pending에 남겨 다음 기회에 재전송한다.

const SEND_TIMEOUT_MS = 30_000;

// 시트에는 실제로 지원서를 낸 뒤의 단계만 적는다(검토중/작성중은 아직 지원 전).
const SYNCED_STATUSES: ApplicationStatus[] = ["제출완료", "서류합격", "면접", "불합격", "최종합격"];

export interface SheetRowPayload {
  seq: string;
  company: string;
  appliedDate: string;
  career: string;
  position: string;
  link: string;
  stage: string;
  result: "" | "합격" | "탈락";
}

function sheetSyncConfig(): { url: string; token: string } | null {
  const url = process.env.FINDAR_SHEET_SYNC_URL;
  const token = process.env.FINDAR_SHEET_SYNC_TOKEN;
  return url && token ? { url, token } : null;
}

export function isSheetSyncConfigured(): boolean {
  return sheetSyncConfig() !== null;
}

function isSyncedStatus(status: string): status is ApplicationStatus {
  return (SYNCED_STATUSES as string[]).includes(status);
}

// 시트의 "단계"/"결과" 열 표기. 불합격은 마지막으로 도달한 단계에서 떨어진 것으로 본다.
function stageAndResult(status: ApplicationStatus, history: { status: string }[]): Pick<SheetRowPayload, "stage" | "result"> {
  switch (status) {
    case "서류합격":
      return { stage: "서류", result: "합격" };
    case "면접":
      return { stage: "면접", result: "" };
    case "최종합격":
      return { stage: "최종", result: "합격" };
    case "불합격": {
      const reached = [...history].reverse().find((h) => h.status === "면접" || h.status === "서류합격");
      return { stage: reached ? "면접" : "서류", result: "탈락" };
    }
    default:
      return { stage: "서류", result: "" };
  }
}

function formatYyMmDd(ms: number): string {
  // en-CA는 YYYY-MM-DD 형식이라 앞 두 자리만 떼어내면 시트 표기(26-01-19)와 같아진다.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(ms)).slice(2);
}

export function buildSheetRowPayload(seq: string): SheetRowPayload | null {
  const application = getApplication(seq);
  const job = getJobBySeq(seq);
  if (!application || !job || !isSyncedStatus(application.status)) return null;

  const history = JSON.parse(application.history) as { status: string; at: number }[];
  // submittedAt은 '제출완료'를 거쳐야만 기록되므로, 곧바로 서류합격 등으로 바꾼 경우엔 첫 지원 이후 단계 시각을 쓴다.
  const appliedAt =
    application.submittedAt ?? history.find((h) => isSyncedStatus(h.status))?.at ?? application.updatedAt;

  return {
    seq,
    company: job.company,
    appliedDate: formatYyMmDd(appliedAt),
    career: job.positionType === "미분류" ? "" : job.positionType,
    position: getApplicationRole(seq).role || job.positions.join(", ") || job.title,
    link: `https://www.kofia.or.kr/brd/m_96/view.do?seq=${seq}`,
    ...stageAndResult(application.status, history),
  };
}

async function send(seq: string): Promise<void> {
  const config = sheetSyncConfig();
  if (!config) return;
  const payload = buildSheetRowPayload(seq);
  if (!payload) {
    clearSheetSyncPending(seq);
    return;
  }
  try {
    // Apps Script 웹 앱은 302로 결과 페이지에 리다이렉트한다. fetch가 이를 GET으로 따라가 응답 JSON을 받는다.
    const res = await fetch(config.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: config.token, ...payload }),
      redirect: "follow",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!res.ok || !body?.ok) throw new Error(body?.error || `HTTP ${res.status}`);
    clearSheetSyncPending(seq);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordSheetSyncFailure(seq, message);
    console.warn(`[sheet-sync] seq=${seq} 시트 기록 실패: ${message}`);
  }
}

// 전송은 한 줄로 세운다. 상태를 연달아 바꿨을 때 먼저 만든 요청이 나중에 도착해 시트를
// 옛 상태로 되돌리는 일을 막기 위해서다(각 전송은 자기 차례에 최신 상태로 payload를 만든다).
let queue: Promise<void> = Promise.resolve();

function enqueue(task: () => Promise<void>): Promise<void> {
  queue = queue.then(task, task);
  return queue;
}

export function syncApplicationToSheet(seq: string): Promise<void> {
  if (!isSheetSyncConfigured()) return Promise.resolve();
  markSheetSyncPending(seq);
  // 방금 실패한 seq는 바로 다시 보내지 않고 다음 flush 때 재시도한다.
  return enqueue(() => send(seq)).then(() => flushPendingSheetSync(seq));
}

let flushing = false;

// 이전에 실패해 남아 있는 전송을 다시 보낸다. 지원 현황을 불러올 때와 상태를 바꿀 때 호출된다.
export async function flushPendingSheetSync(skipSeq?: string): Promise<void> {
  if (!isSheetSyncConfigured() || flushing) return;
  flushing = true;
  try {
    for (const seq of getPendingSheetSyncSeqs()) {
      if (seq === skipSeq) continue;
      await enqueue(() => send(seq));
    }
  } finally {
    flushing = false;
  }
}
