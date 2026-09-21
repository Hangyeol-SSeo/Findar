import type { ApplicationDraft } from "./application-draft";
import type { FillPlan } from "./application-fill";
export interface DocumentFillResult {
  downloadUrl: string; filename: string; filled: number; total: number;
  skipped: { label: string; reason: string }[]; note: string;
}
export interface ApplicationTask {
  id: string; seq: string; kind: "writing" | "document" | "web";
  status: "queued" | "running" | "completed" | "failed";
  createdAt: number; updatedAt: number; done: number; total: number;
  error?: string;
  result?: { draft?: ApplicationDraft; needsInfo?: number; document?: DocumentFillResult; plan?: FillPlan };
}
export const taskActive = (task: ApplicationTask) => task.status === "queued" || task.status === "running";
