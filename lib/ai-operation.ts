import { AsyncLocalStorage } from "node:async_hooks";

const state = globalThis as typeof globalThis & { findarAIAbortScope?: AsyncLocalStorage<AbortSignal> };
const scope = state.findarAIAbortScope ??= new AsyncLocalStorage<AbortSignal>();
export const getAIAbortSignal = () => scope.getStore();
export function throwIfAIAborted() { getAIAbortSignal()?.throwIfAborted(); }
export function withAIAbortSignal<T>(signal: AbortSignal, action: () => T): T {
  return scope.run(signal, action);
}

// Shared source extraction belongs to its remaining consumers, not the first caller.
export interface SharedAIWork<T> {
  controller: AbortController;
  promise: Promise<T>;
  consumers: number;
  settled: boolean;
}
export function createSharedAIWork<T>(action: () => Promise<T>): SharedAIWork<T> {
  const work: SharedAIWork<T> = { controller: new AbortController(), promise: undefined!, consumers: 0, settled: false };
  work.promise = withAIAbortSignal(work.controller.signal, () => Promise.resolve().then(async () => {
    throwIfAIAborted();
    const result = await action();
    throwIfAIAborted();
    return result;
  }))
    .finally(() => { work.settled = true; });
  return work;
}
export function waitForAIWork<T>(work: SharedAIWork<T>): Promise<T> {
  const signal = getAIAbortSignal();
  signal?.throwIfAborted();
  work.consumers++;
  return new Promise<T>((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener("abort", abort);
      if (--work.consumers === 0 && !work.settled) work.controller.abort(new DOMException("작업을 취소했습니다.", "AbortError"));
    };
    const abort = () => {
      release();
      // The last caller waits for provider cleanup before its task releases the job lock.
      if (work.consumers === 0 && !work.settled) void work.promise.then(() => reject(signal?.reason), () => reject(signal?.reason));
      else reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    work.promise.then((value) => {
      release();
      if (signal?.aborted) reject(signal.reason);
      else resolve(value);
    }, (error) => { release(); reject(signal?.aborted ? signal.reason : error); });
  });
}
