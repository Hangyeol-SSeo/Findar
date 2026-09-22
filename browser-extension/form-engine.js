// Runs only after the user invokes the extension on the active application page.
// Store actual element references, then recheck them before writing after the async mapping step.
(() => {
  const blocked = /주민(?:등록)?번호|계좌|카드번호|비밀번호|여권|서명|동의|인증번호|password|captcha|verification|consent|signature|ssn|passport/i;
  const textOf = (el) => (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
  // "경력 1", "학력(2)", "수상내역①" 같은 반복 구획 제목에서 순번을 떼면, 같은 구획의 여러
  // 인스턴스를 하나의 이름으로 묶어 형제 인스턴스 개수를 셀 수 있다.
  const stripCounter = (s) => s.replace(/[\s]*[([（]?\s*[0-9①-⑳]+\s*[)）.]?\s*$/, "").trim();
  const HEADING = "h1,h2,h3,h4,h5,h6";

  // 이 입력칸이 속한 "구획"(fieldset/legend, table/caption 또는 표 바로 위 제목)을 찾는다.
  // 반복되는 경력/학력/수상 같은 표·fieldset 구조를 식별해야 서버의 deterministic 매칭과
  // AI 매칭 둘 다 몇 번째 행인지 맞춰서 처리할 수 있다 — 라벨(예: "회사명")만으로는 폼에
  // 경력이 여러 개일 때 그중 몇 번째 칸인지 구분할 방법이 없다.
  function findSection(el) {
    const fieldset = el.closest("fieldset");
    if (fieldset) {
      const legend = fieldset.querySelector(":scope > legend");
      if (legend && textOf(legend)) return { text: stripCounter(textOf(legend)), group: fieldset, kind: "fieldset" };
    }
    const table = el.closest("table");
    if (table) {
      const caption = table.querySelector(":scope > caption");
      if (caption && textOf(caption)) return { text: stripCounter(textOf(caption)), group: table, kind: "table" };
      for (let sib = table.previousElementSibling, i = 0; sib && i < 3; sib = sib.previousElementSibling, i++) {
        if (sib.matches?.(HEADING) && textOf(sib)) return { text: stripCounter(textOf(sib)), group: table, kind: "table" };
      }
      return { text: "", group: table, kind: "table" };
    }
    // 표/fieldset이 아니면 조상을 타고 올라가며 그 앞에 있는 제목류 요소를 찾는다.
    for (let node = el, depth = 0; node && depth < 6; node = node.parentElement, depth++) {
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.matches?.(HEADING) && textOf(sib)) return { text: stripCounter(textOf(sib)), group: null, kind: null };
      }
    }
    return { text: "", group: null, kind: null };
  }

  // 반복되는 표 행/fieldset 안에서 이 칸이 몇 번째 인스턴스인지 센다. 입력칸이 하나도 없는
  // 행(헤더 등)은 세지 않는다. 인스턴스가 하나뿐이어도(경력이 1개뿐인 지원자 등) 그대로
  // 0을 매겨 deterministic 매칭이 쓸 수 있게 한다.
  function findRowIndex(el, section) {
    if (section.kind === "table") {
      const row = el.closest("tr");
      if (!row) return undefined;
      const rows = [...section.group.querySelectorAll("tr")].filter((r) => r.querySelector("input,textarea,select"));
      const index = rows.indexOf(row);
      return index >= 0 ? index : undefined;
    }
    if (section.kind === "fieldset") {
      const parent = section.group.parentElement;
      if (!parent) return undefined;
      const siblings = [...parent.children].filter((c) =>
        c.tagName === "FIELDSET" && stripCounter(textOf(c.querySelector(":scope > legend"))) === section.text);
      const index = siblings.indexOf(section.group);
      return index >= 0 ? index : undefined;
    }
    return undefined;
  }

  const labelOf = (el) => [Array.from(el.labels || []).map((l) => l.innerText).join(" "), el.getAttribute("aria-label"),
    (el.getAttribute("aria-labelledby") || "").split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" "),
    el.getAttribute("placeholder"), el.name, el.id].filter(Boolean).join(" / ").slice(0, 1500);

  // tr/fieldset 구조가 없는 폼(div나 dt/dd로 라벨과 입력칸을 나열하는 흔한 레이아웃)도 많아서,
  // 그런 경우엔 감싸는 요소의 텍스트를 좁은 범위부터 시도해 "이 칸 주변에 뭐라고 적혀
  // 있는가"를 최대한 건진다. 이미 너무 커진(다른 칸까지 섞였을) 블록은 위로 올라가도 더
  // 커지기만 하므로 그 지점에서 포기한다 — 틀린 문맥보다 문맥 없음이 낫다.
  const contextOf = (el) => {
    const structural = [el.closest("tr"), el.closest("fieldset")?.querySelector("legend")].map(textOf).filter(Boolean).join(" ");
    if (structural) return structural.slice(0, 4000);
    for (let node = el.parentElement, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
      const text = textOf(node);
      if (text && text.length <= 300) return text;
      if (text.length > 300) break;
    }
    return "";
  };
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
  const refs = elements.map((el, index) => {
    const section = findSection(el);
    return { el, id: `field-${index}`, label: labelOf(el), context: contextOf(el),
      section: section.text || undefined, rowIndex: findRowIndex(el, section) };
  });
  const pageUrl = location.href;
  globalThis.__findarForm = {
    scanId: Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, "0")).join(""),
    targets: refs.map(({ el, id, label, context, section, rowIndex }) => ({ id, label, context, section, rowIndex,
      type: el.tagName === "SELECT" ? "select" : el.type,
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
