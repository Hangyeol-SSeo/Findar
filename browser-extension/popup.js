const button = document.getElementById("fill");
button.addEventListener("click", async () => {
  button.disabled = true;
  const status = document.getElementById("status");
  const report = document.getElementById("report");
  report.textContent = "";
  try {
    const { findar } = await chrome.storage.session.get("findar");
    if (!findar) throw new Error("먼저 Findar 지원 도우미에서 웹 지원서 연결을 눌러주세요.");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!/^https?:\/\//.test(tab.url) || new URL(tab.url).origin === findar.origin) throw new Error("실제 지원서 페이지를 열고 실행해주세요.");
    status.textContent = "현재 입력칸을 읽고 있습니다. 완료될 때까지 이 창을 열어두세요.";
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["form-engine.js"] });
    const [{ result: targets }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => globalThis.__findarForm.targets });
    if (!targets.length) throw new Error("작성 가능한 빈 입력칸이 없습니다. 로그인 후 실제 지원서 페이지에서 실행해주세요. iframe 내부 입력칸은 현재 지원하지 않습니다.");
    status.textContent = `${targets.length}개 입력칸과 저장 정보를 연결하고 있습니다.`;
    const response = await fetch(`${findar.origin}/api/applications/${encodeURIComponent(findar.seq)}/fill/web`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${findar.token}` }, body: JSON.stringify({ targets }), signal: AbortSignal.timeout(150000),
    });
    const plan = await response.json();
    if (!response.ok) throw new Error(plan.error || "입력칸 분석에 실패했습니다.");
    const current = await chrome.tabs.get(tab.id);
    if (current.url !== tab.url) throw new Error("페이지가 이동되었습니다. 현재 양식에서 다시 실행해주세요.");
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (assignments) => globalThis.__findarForm.apply(assignments), args: [plan.assignments] });
    status.textContent = `${result.filter((r) => r.filled).length}개 입력 완료. 화면에서 내용을 확인해주세요.`;
    report.textContent = [...result, ...plan.skipped].map((r) => `${r.filled ? "✓" : "—"} ${r.label}${r.reason ? `: ${r.reason}` : ""}`).join("\n");
  } catch (error) { status.textContent = error.message || "연결에 실패했습니다."; }
  finally { button.disabled = false; }
});
