// A bounded handshake also works with the already-installed 1.1 extension.
// No server requests are needed to detect the content script.
export function detectBrowserExtension(signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(false); return; }
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    function finish(ready: boolean) {
      clearTimeout(timer);
      window.removeEventListener("message", receive);
      signal?.removeEventListener("abort", abort);
      resolve(ready);
    }
    function receive(event: MessageEvent) {
      if (event.source === window && event.origin === location.origin && event.data?.type === "FINDAR_READY") finish(true);
    }
    function abort() { finish(false); }
    function ping() {
      if (attempts++ >= 5) { finish(false); return; }
      window.postMessage({ type: "FINDAR_PING" }, location.origin);
      timer = setTimeout(ping, 400);
    }
    window.addEventListener("message", receive);
    signal?.addEventListener("abort", abort, { once: true });
    ping();
  });
}
