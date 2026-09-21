const button = document.getElementById("fill");
const status = document.getElementById("status");
const report = document.getElementById("report");
let tabId;
let starting = false;
function render(data) {
  if (data.error) throw new Error(data.error);
  button.disabled = starting || ["starting", "running"].includes(data.status);
  status.textContent = data.message || "현재 지원서의 빈칸에 개인정보와 저장된 자기소개서를 입력합니다.";
  report.textContent = data.report || "";
}
async function refresh() {
  if (tabId === undefined || starting) return;
  try { render(await chrome.runtime.sendMessage({ type: "status", tabId })); }
  catch (error) { status.textContent = error.message; }
}
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  await refresh();
})();
setInterval(refresh, 1500);
button.addEventListener("click", async () => {
  starting = true; button.disabled = true;
  try {
    const data = await chrome.runtime.sendMessage({ type: "fill", tabId });
    starting = false; render(data);
  } catch (error) { starting = false; button.disabled = false; status.textContent = error.message || "연결에 실패했습니다."; }
});
