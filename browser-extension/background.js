const connectionKey = (tabId) => `findar-connection-${tabId}`;
const jobKey = (tabId) => `findar-job-${tabId}`;
const locks = new Set();
const active = (job) => job && ["starting", "running"].includes(job.status);
async function api(connection, body) {
  const response = await fetch(`${connection.origin}/api/applications/${encodeURIComponent(connection.seq)}/fill/web`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${connection.token}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "입력칸 분석에 실패했습니다.");
  return data;
}
async function update(tabId, job) { await chrome.storage.session.set({ [jobKey(tabId)]: job }); }
async function poll(tabId) {
  if (locks.has(tabId)) return;
  locks.add(tabId);
  let job;
  try {
    job = (await chrome.storage.session.get(jobKey(tabId)))[jobKey(tabId)];
    if (!active(job)) return;
    if (Date.now() - job.startedAt > 5 * 60 * 1000) throw new Error("입력 작업 시간이 초과되었습니다. 다시 실행해주세요.");
    if (!job.taskId) return;
    const { task } = await api(job.connection, { taskId: job.taskId });
    if (task.status === "failed") throw new Error(task.error);
    if (task.status !== "completed") return;
    const tab = await chrome.tabs.get(tabId);
    if (tab.url !== job.url) throw new Error("페이지가 이동되었습니다. 현재 양식에서 다시 실행해주세요.");
    const plan = task.result.plan;
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId },
      func: (assignments, scanId) => {
        if (globalThis.__findarForm?.scanId !== scanId) throw new Error("지원서가 다시 열렸습니다. 다시 실행해주세요.");
        return globalThis.__findarForm.apply(assignments);
      }, args: [plan.assignments, job.scanId] });
    await update(tabId, { status: "completed", message: `${result.filter((r) => r.filled).length}개 입력 완료. 화면에서 내용을 확인해주세요.`,
      report: [...result, ...plan.skipped].map((r) => `${r.filled ? "✓" : "—"} ${r.label}${r.reason ? `: ${r.reason}` : ""}`).join("\n") });
  } catch (error) {
    if (job) await update(tabId, { status: "failed", message: error.message || "자동입력에 실패했습니다." });
  } finally { locks.delete(tabId); }
}
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "findar-fill") return;
  const stored = await chrome.storage.session.get(null);
  await Promise.all(Object.entries(stored).filter(([key, job]) => key.startsWith("findar-job-") && active(job)).map(([key]) => poll(Number(key.slice("findar-job-".length)))));
});
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove([connectionKey(tabId), jobKey(tabId)]));
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    if (message.type === "connect") {
      const origin = new URL(sender.url).origin;
      if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || !/^[a-f0-9]{64}$/.test(message.token) || typeof message.seq !== "string") throw new Error("Findar 연결 요청이 올바르지 않습니다.");
      const url = new URL(message.url);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("지원서 주소를 확인해주세요.");
      const tab = await chrome.tabs.create({ url: url.href });
      await chrome.storage.session.set({ [connectionKey(tab.id)]: { origin, token: message.token, seq: message.seq } });
      return { ok: true, seq: message.seq };
    }
    // Only the extension popup may start/read a fill job, never a website content script.
    if (sender.url !== chrome.runtime.getURL("popup.html")) throw new Error("확장 기능에서 실행해주세요.");
    const tabId = message.tabId;
    if (!Number.isInteger(tabId)) throw new Error("지원서 탭을 찾지 못했습니다.");
    if (message.type === "status") {
      void poll(tabId);
      const job = (await chrome.storage.session.get(jobKey(tabId)))[jobKey(tabId)];
      return { status: job?.status, message: job?.message, report: job?.report };
    }
    if (message.type !== "fill") return {};
    if (locks.has(tabId)) throw new Error("이 탭의 작업이 진행 중입니다.");
    locks.add(tabId);
    try {
      const stored = await chrome.storage.session.get([connectionKey(tabId), jobKey(tabId)]);
      if (active(stored[jobKey(tabId)])) throw new Error("이 탭의 작업이 진행 중입니다.");
      const connection = stored[connectionKey(tabId)];
      if (!connection) throw new Error("먼저 Findar에서 이 지원서를 웹 지원서 연결로 열어주세요.");
      const tab = await chrome.tabs.get(tabId);
      if (!/^https?:\/\//.test(tab.url) || new URL(tab.url).origin === connection.origin) throw new Error("실제 지원서 페이지에서 실행해주세요.");
      await chrome.scripting.executeScript({ target: { tabId }, files: ["form-engine.js"] });
      const [{ result: scan }] = await chrome.scripting.executeScript({ target: { tabId }, func: () => ({ targets: globalThis.__findarForm.targets, scanId: globalThis.__findarForm.scanId }) });
      if (!scan.targets.length) throw new Error("작성 가능한 빈 입력칸이 없습니다. iframe 내부 입력칸은 현재 지원하지 않습니다.");
      const job = { status: "starting", startedAt: Date.now(), connection, url: tab.url, scanId: scan.scanId,
        message: `${scan.targets.length}개 입력칸을 분석 중입니다. 팝업을 닫거나 탭을 이동해도 계속 진행됩니다.` };
      await update(tabId, job);
      await chrome.alarms.create("findar-fill", { periodInMinutes: 0.5 });
      const { task } = await api(connection, { targets: scan.targets });
      job.taskId = task.id; job.status = "running";
      await update(tabId, job);
      return { status: job.status, message: job.message };
    } catch (error) {
      // Do not replace an already-running task on duplicate clicks.
      const job = (await chrome.storage.session.get(jobKey(tabId)))[jobKey(tabId)];
      if (!job?.taskId || !active(job)) await update(tabId, { status: "failed", message: error.message });
      throw error;
    } finally { locks.delete(tabId); }
  })().then(respond).catch((error) => respond({ error: error.message }));
  return true;
});
