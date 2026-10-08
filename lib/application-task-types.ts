import type { ApplicationDraft } from "./application-draft";
import type { FillPlan } from "./application-fill";
export interface DocumentFillResult {
  downloadUrl: string; filename: string; filled: number; total: number;
  skipped: { label: string; reason: string }[]; note: string;
}
export interface ApplicationTask {
  id: string; seq: string; kind: "writing" | "document" | "web" | "tailoring" | "revision" | "research";
  // 첨삭·조사 작업이 어느 문항의 것인지 — 끝났을 때 화면이 그 답변으로 이동하는 데 쓴다.
  question?: string;
  status: "queued" | "running" | "cancelling" | "cancelled" | "completed" | "failed";
  createdAt: number; updatedAt: number; done: number; total: number;
  error?: string;
  result?: { draft?: ApplicationDraft; needsInfo?: number; document?: DocumentFillResult; plan?: FillPlan; outcome?: "pending-revision" | "feedback" | "needs-info" | "candidates" | "findings" };
}
export const taskActive = (task: ApplicationTask) => task.status === "queued" || task.status === "running" || task.status === "cancelling";
