// Runs only after the user invokes the extension on the active application page.
// Store actual element references, then recheck them before writing after the async mapping step.
(() => {
  const blocked = /주민(?:등록)?번호|계좌|카드번호|비밀번호|여권|서명|동의|인증번호|password|captcha|verification|consent|signature|ssn|passport/i;
  const labelOf = (el) => [Array.from(el.labels || []).map((l) => l.innerText).join(" "), el.getAttribute("aria-label"),
    (el.getAttribute("aria-labelledby") || "").split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" "),
    el.getAttribute("placeholder"), el.name, el.id].filter(Boolean).join(" / ").slice(0, 1500);
  const contextOf = (el) => (el.closest("fieldset")?.querySelector("legend")?.innerText || el.closest("tr")?.innerText || "").slice(0, 4000);
  const writable = (el) => {
    if (!el.isConnected || el.disabled || el.readOnly || el.value || !el.getClientRects().length) return false;
    if (el.closest('[inert], [aria-hidden="true"]')) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
    if (el.tagName === "INPUT" && !["text", "email", "tel", "url", "date", "month", "number"].includes(el.type)) return false;
    if (blocked.test(labelOf(el) + " " + contextOf(el))) return false;
    if (/password|one-time-code|cc-|username/.test(el.autocomplete || "")) return false;
    if (el.form?.querySelector('input[type="password"]')) return false;
    return true;
  };
  const elements = [...document.querySelectorAll("input, textarea, select")].filter(writable).slice(0, 250);
  const refs = elements.map((el, index) => ({ el, id: `field-${index}`, label: labelOf(el), context: contextOf(el) }));
  const pageUrl = location.href;
  globalThis.__findarForm = {
    targets: refs.map(({ el, id, label, context }) => ({ id, label, context, type: el.tagName === "SELECT" ? "select" : el.type,
      ...(el.tagName === "SELECT" ? { options: [...el.options].filter((o) => o.value && !o.disabled).map((o) => o.text.trim()) } : {}) })),
    async apply(assignments) {
      if (location.href !== pageUrl) throw new Error("페이지가 바뀌었습니다. 다시 실행해주세요.");
      const results = [];
      const written = [];
      for (const item of assignments) {
        const ref = refs.find((r) => r.id === item.targetId);
        if (!ref || !writable(ref.el) || labelOf(ref.el) !== ref.label || contextOf(ref.el) !== ref.context) {
          results.push({ label: ref?.label || item.label, reason: "입력칸이 변경되었거나 이미 값이 있습니다." }); continue;
        }
        const el = ref.el;
        let value = item.value;
        if (el.tagName === "SELECT") {
          const options = [...el.options].filter((o) => o.text.trim() === value && o.value && !o.disabled);
          if (options.length !== 1) { results.push({ label: ref.label, reason: "정확히 일치하는 선택지가 없습니다." }); continue; }
          value = options[0].value;
        }
        if (el.maxLength > 0 && value.length > el.maxLength) { results.push({ label: ref.label, reason: "입력 길이 제한을 초과합니다." }); continue; }
        const prototype = el.tagName === "SELECT" ? HTMLSelectElement.prototype : el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value").set.call(el, value);
        if (el.validity.typeMismatch || el.validity.patternMismatch || el.validity.badInput || el.value !== value) {
          Object.getOwnPropertyDescriptor(prototype, "value").set.call(el, "");
          results.push({ label: ref.label, reason: "사이트 입력 형식과 맞지 않습니다." }); continue;
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        const outcome = { label: ref.label, filled: true };
        results.push(outcome);
        written.push({ el, value, outcome });
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      for (const { el, value, outcome } of written) {
        if (!el.isConnected || el.value !== value) {
          outcome.filled = false;
          outcome.reason = "사이트가 입력칸을 다시 그리거나 값을 변경했습니다. 화면에서 확인해주세요.";
        }
      }
      return results;
    },
  };
})();
