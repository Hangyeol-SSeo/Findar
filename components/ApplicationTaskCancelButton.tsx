"use client";

import { useState } from "react";
import { taskActive, type ApplicationTask } from "@/lib/application-task-types";

export default function ApplicationTaskCancelButton({ task, onUpdate, onError }: {
  task: ApplicationTask;
  onUpdate: (task: ApplicationTask) => void;
  onError: (message: string) => void;
}) {
  const [pending, setPending] = useState(false);
  if (!taskActive(task)) return null;
  const cancelling = pending || task.status === "cancelling";
  const label = task.kind === "writing" ? "자기소개서" : task.kind === "revision" ? "첨삭" : task.kind === "research" ? "업계 사례 조사" : task.kind === "tailoring" ? "이력 평가" : "Word 입력";
  async function cancel() {
    setPending(true);
    try {
      const response = await fetch(`/api/applications/${encodeURIComponent(task.seq)}/tasks?id=${encodeURIComponent(task.id)}`, { method: "DELETE" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "작업을 취소하지 못했습니다.");
      onUpdate(result.task);
    } catch (error) { onError(error instanceof Error ? error.message : "작업을 취소하지 못했습니다."); }
    finally { setPending(false); }
  }
  return <button type="button" onClick={() => void cancel()} disabled={cancelling} aria-label={`${label} 작업 취소`}
    className="rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50">
    {cancelling ? "취소 중..." : "작업 취소"}
  </button>;
}
