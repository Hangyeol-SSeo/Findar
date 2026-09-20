// No applicant information crosses window.postMessage. Only a short-lived capability from Findar.
window.addEventListener("message", async (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  if (event.data?.type === "FINDAR_PING") window.postMessage({ type: "FINDAR_READY" }, location.origin);
  if (event.data?.type !== "FINDAR_CONNECT") return;
  try {
    const result = await chrome.runtime.sendMessage({ type: "connect", token: event.data.token, seq: event.data.seq, url: event.data.url });
    window.postMessage({ type: "FINDAR_CONNECTED", ...result }, location.origin);
  } catch { window.postMessage({ type: "FINDAR_CONNECTED", error: "확장 기능에 연결하지 못했습니다." }, location.origin); }
});
window.postMessage({ type: "FINDAR_READY" }, location.origin);
