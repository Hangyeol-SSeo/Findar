import { randomUUID } from "node:crypto";
import { taskActive, type ApplicationTask } from "./application-task-types";
import { withAIAbortSignal } from "./ai-operation";
// Local Node server tasks survive UI unmounts and browser reloads. No profile/file payloads
// are exposed by status APIs. Completed metadata expires with downloadable documents.
const state = globalThis as typeof globalThis & { findarApplicationTasks?: Map<string, ApplicationTask>; findarApplicationControllers?: Map<string, AbortController> };
const tasks = state.findarApplicationTasks ??= new Map<string, ApplicationTask>();
const controllers = state.findarApplicationControllers ??= new Map<string, AbortController>();
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
export function createApplicationTask(seq: string, kind: ApplicationTask["kind"], total = 1, question?: string) {
  prune();
  // 문항 작성과 첨삭은 같은 답변 묶음을 읽고 저장하므로, 한 공고에서 동시에 하나만 돌린다.
  const essayKinds: ApplicationTask["kind"][] = ["writing", "revision", "research"];
  if (essayKinds.includes(kind) && listApplicationTasks(seq).some((t) => essayKinds.includes(t.kind) && taskActive(t)))
    throw new Error("이 공고의 문항 작성·첨삭·조사가 이미 진행 중입니다. 끝난 뒤 다시 실행해주세요. 다른 공고나 자동입력 작업은 함께 실행할 수 있습니다.");
  if (kind === "tailoring" && listApplicationTasks(seq).some((t) => t.kind === kind && taskActive(t)))
    throw new Error("이 공고의 이력 평가가 이미 진행 중입니다.");
  if ([...tasks.values()].filter(taskActive).length >= 12) throw new Error("동시 작업이 많습니다. 진행 중인 작업이 끝나면 다시 실행해주세요.");
  const now = Date.now();
  const task: ApplicationTask = { id: randomUUID(), seq, kind, status: "queued", createdAt: now, updatedAt: now, done: 0, total, ...(question ? { question } : {}) };
  tasks.set(task.id, task);
  controllers.set(task.id, new AbortController());
  return { ...task };
}
export function cancelApplicationTask(seq: string, id: string) {
  const task = tasks.get(id);
  if (!task || task.seq !== seq) return null;
  if (!taskActive(task) || task.status === "cancelling") return { ...task };
  const controller = controllers.get(id);
  if (!controller) throw new Error("작업을 취소할 수 없습니다. 서버가 다시 시작되었을 수 있습니다.");
  const queued = task.status === "queued";
  task.status = queued ? "cancelled" : "cancelling";
  task.updatedAt = Date.now();
  controller.abort(new DOMException("작업을 취소했습니다.", "AbortError"));
  if (queued) { controllers.delete(id); setTimeout(() => tasks.delete(id), TTL).unref(); }
  return { ...task };
}
export async function executeApplicationTask(id: string, action: (progress: (done: number) => void, signal: AbortSignal) => Promise<ApplicationTask["result"]>) {
  const task = tasks.get(id);
  if (!task || task.status !== "queued") return;
  const controller = controllers.get(id)!;
  task.status = "running";
  try {
    const result = await withAIAbortSignal(controller.signal, () => action((done) => {
      controller.signal.throwIfAborted(); task.done = done; task.updatedAt = Date.now();
    }, controller.signal));
    controller.signal.throwIfAborted();
    task.result = result;
    task.done = task.total; task.status = "completed";
  } catch (e) {
    if (controller.signal.aborted) { task.status = "cancelled"; delete task.result; }
    else { task.status = "failed"; task.error = e instanceof Error ? e.message : "작업에 실패했습니다."; }
  }
  finally { controllers.delete(id); task.updatedAt = Date.now(); setTimeout(() => tasks.delete(id), TTL).unref(); }
}
