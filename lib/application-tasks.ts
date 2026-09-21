import { randomUUID } from "node:crypto";
import { taskActive, type ApplicationTask } from "./application-task-types";
// Local Node server tasks survive UI unmounts and browser reloads. No profile/file payloads
// are exposed by status APIs. Completed metadata expires with downloadable documents.
const state = globalThis as typeof globalThis & { findarApplicationTasks?: Map<string, ApplicationTask> };
const tasks = state.findarApplicationTasks ??= new Map<string, ApplicationTask>();
const TTL = 30 * 60 * 1000;
function prune() {
  for (const [id, task] of tasks) if (!taskActive(task) && Date.now() - task.updatedAt > TTL) tasks.delete(id);
}
export function listApplicationTasks(seq: string) {
  prune();
  return [...tasks.values()].filter((t) => t.seq === seq).map((t) => ({ ...t }));
}
export function getApplicationTask(seq: string, id: string) {
  return listApplicationTasks(seq).find((t) => t.id === id);
}
export function createApplicationTask(seq: string, kind: ApplicationTask["kind"], total = 1) {
  prune();
  if (kind === "writing" && listApplicationTasks(seq).some((t) => t.kind === kind && taskActive(t)))
    throw new Error("이 공고의 문항 작성이 이미 진행 중입니다. 다른 공고나 자동입력 작업은 함께 실행할 수 있습니다.");
  if ([...tasks.values()].filter(taskActive).length >= 12) throw new Error("동시 작업이 많습니다. 진행 중인 작업이 끝나면 다시 실행해주세요.");
  const now = Date.now();
  const task: ApplicationTask = { id: randomUUID(), seq, kind, status: "queued", createdAt: now, updatedAt: now, done: 0, total };
  tasks.set(task.id, task);
  return { ...task };
}
export async function executeApplicationTask(id: string, action: (progress: (done: number) => void) => Promise<ApplicationTask["result"]>) {
  const task = tasks.get(id);
  if (!task || task.status !== "queued") return;
  task.status = "running";
  try {
    task.result = await action((done) => { task.done = done; task.updatedAt = Date.now(); });
    task.done = task.total; task.status = "completed";
  } catch (e) { task.status = "failed"; task.error = e instanceof Error ? e.message : "작업에 실패했습니다."; }
  finally { task.updatedAt = Date.now(); setTimeout(() => tasks.delete(id), TTL).unref(); }
}
