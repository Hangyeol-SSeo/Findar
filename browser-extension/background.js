chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type !== "connect") return;
  (async () => {
    const origin = new URL(sender.url).origin;
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || !/^[a-f0-9]{64}$/.test(message.token) || typeof message.seq !== "string") throw new Error("Findar 연결 요청이 올바르지 않습니다.");
    const url = new URL(message.url);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("지원서 주소를 확인해주세요.");
    await chrome.storage.session.set({ findar: { origin, token: message.token, seq: message.seq } });
    await chrome.tabs.create({ url: url.href });
    respond({ ok: true });
  })().catch((error) => respond({ error: error.message }));
  return true;
});
