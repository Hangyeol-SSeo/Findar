// Runs only after the user invokes the extension on the active application page.
// Store actual element references, then recheck them before writing after the async mapping step.
(() => {
  const blocked = /주민(?:등록)?번호|계좌|카드번호|비밀번호|여권|서명|동의|인증번호|password|captcha|verification|consent|signature|ssn|passport/i;
  const textOf = (el) => (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
  // "경력 1", "학력(2)", "수상내역①" 같은 반복 구획 제목에서 순번을 떼면, 같은 구획의 여러
  // 인스턴스를 하나의 이름으로 묶어 형제 인스턴스 개수를 셀 수 있다.
  const stripCounter = (s) => s.replace(/[\s]*[([（]?\s*[0-9①-⑳]+\s*[)）.]?\s*$/, "").trim();
  const HEADING = "h1,h2,h3,h4,h5,h6,[role=heading],summary";
  const CONTROL = "input,textarea,select";
  const counterIndex = (text) => {
    const match = text.match(/[([（]?\s*([0-9]+|[①-⑳])\s*[)）.]?\s*$/);
    if (!match) return undefined;
    const value = match[1];
    const index = /^\d+$/.test(value) ? Number(value) - 1 : value.codePointAt(0) - "①".codePointAt(0);
    return index >= 0 && index <= 250 ? index : undefined;
  };
  const sectionInfo = (heading, group, kind) => ({
    text: stripCounter(textOf(heading)), group, kind, rowIndex: counterIndex(textOf(heading)),
  });
  // Ninehire-style forms keep the real field title in a sibling of a deeply nested input.
  // A bounded ancestor walk cannot reach that title from career and personal inputs.
  const formBlock = (el) => el.closest('[class*="ApplicationFormInput__Layout"]');
  const formBlockTitle = (el) => formBlock(el)?.querySelector('[class*="EditableLabel__Input"]');
  const formBlockDescription = (el) => formBlock(el)?.querySelector('[class*="EditableDescription__Input"]');
  const isSectionHeading = (el) => {
    if (!el.getClientRects().length) return false;
    if (el.matches?.(HEADING)) return true;
    const className = typeof el.className === "string" ? el.className : "";
    return /section|heading|title|(?:^|[_\-\s])tit(?:$|[_\-\s])/i.test(className) &&
      !el.querySelector(CONTROL) && textOf(el).length <= 100;
  };

  // 이 입력칸이 속한 "구획"(fieldset/legend, table/caption 또는 표 바로 위 제목)을 찾는다.
  // 반복되는 경력/학력/수상 같은 표·fieldset 구조를 식별해야 서버의 deterministic 매칭과
  // AI 매칭 둘 다 몇 번째 행인지 맞춰서 처리할 수 있다 — 라벨(예: "회사명")만으로는 폼에
  // 경력이 여러 개일 때 그중 몇 번째 칸인지 구분할 방법이 없다.
  function findSection(el) {
    const block = formBlock(el);
    const title = formBlockTitle(el);
    if (block && title && textOf(title)) return sectionInfo(title, block, "form-block");
    const fieldset = el.closest("fieldset");
    if (fieldset) {
      const legend = fieldset.querySelector(":scope > legend");
      if (legend && textOf(legend)) return sectionInfo(legend, fieldset, "fieldset");
    }
    const table = el.closest("table");
    if (table) {
      const caption = table.querySelector(":scope > caption");
      if (caption && textOf(caption)) return sectionInfo(caption, table, "table");
      for (let sib = table.previousElementSibling, i = 0; sib && i < 3; sib = sib.previousElementSibling, i++) {
        if (isSectionHeading(sib) && textOf(sib)) return sectionInfo(sib, table, "table");
      }
      return { text: "", group: table, kind: "table" };
    }
    // 표/fieldset이 아니면 조상을 타고 올라가며 그 앞에 있는 제목류 요소를 찾는다.
    for (let node = el, depth = 0; node && depth < 6; node = node.parentElement, depth++) {
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (isSectionHeading(sib) && textOf(sib)) return sectionInfo(sib, null, null);
      }
    }
    return { text: "", group: null, kind: null };
  }

  // 반복되는 표 행/fieldset 안에서 이 칸이 몇 번째 인스턴스인지 센다. 입력칸이 하나도 없는
  // 행(헤더 등)은 세지 않는다. 인스턴스가 하나뿐이어도(경력이 1개뿐인 지원자 등) 그대로
  // 0을 매겨 deterministic 매칭이 쓸 수 있게 한다.
  function findRowIndex(el, section) {
    if (section.rowIndex !== undefined) return section.rowIndex;
    if (section.kind === "table") {
      const row = el.closest("tr");
      if (!row) return undefined;
      const rows = [...section.group.querySelectorAll("tr")].filter((r) => r.querySelector(CONTROL));
      // Key/value tables use one row per field (for example 회사명 | [input]); those rows are
      // not repeated experience records. Leave rowIndex unset so the server can use a unique
      // saved record safely instead of treating 직급 as the second employer.
      const fieldLabels = /^(회사명|직장명|근무처|직급|직책|직위|직급직책|근무부서|부서|담당업무|해당업무|고용형태|퇴사사유|이직사유|연봉|주최기관|수여기관|시험명|점수|점수급|내용|수상내역|프로그램명)$/;
      const keyValueRows = rows.some((candidate) => {
        const headers = [...candidate.querySelectorAll(":scope > th")].map((cell) => textOf(cell).replace(/[\s:*：]/g, ""));
        if (headers.some((label) => fieldLabels.test(label))) return true;
        const labelCell = [...candidate.children].find((cell) => !cell.querySelector(CONTROL));
        const label = textOf(labelCell).replace(/[\s:*：]/g, "");
        return fieldLabels.test(label);
      });
      if (keyValueRows) return undefined;
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

  function nearbyLabelOf(el) {
    const block = formBlock(el);
    const title = formBlockTitle(el);
    if (block && title && block.querySelectorAll(CONTROL).length === 1) return textOf(title);
    for (let branch = el, depth = 0; branch?.parentElement && depth < 4; depth++, branch = branch.parentElement) {
      const parent = branch.parentElement;
      const candidates = [...parent.querySelectorAll("label,dt,th,legend,[role=heading],[class*=label],[class*=Label],[class*=title],[class*=Title]")]
        .filter((candidate) => candidate.getClientRects().length && !candidate.contains(el) && !candidate.querySelector(CONTROL) &&
          (candidate.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))
        .map((candidate) => textOf(candidate))
        .filter((text) => text && text.length <= 120 && !/^(추가|삭제|검색|선택)$/i.test(text));
      if (candidates.length) return candidates[candidates.length - 1];

      // Some portals render a label as a plain sibling instead of using <label> or aria-labelledby.
      for (let sibling = branch.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (!sibling.getClientRects().length || sibling.querySelector(CONTROL) || sibling.matches("button,a")) continue;
        const text = textOf(sibling);
        if (text && text.length <= 120) return text;
      }
    }
    return "";
  }

  const labelOf = (el) => [Array.from(el.labels || []).map((l) => l.innerText).join(" "), el.getAttribute("aria-label"),
    (el.getAttribute("aria-labelledby") || "").split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" "),
    nearbyLabelOf(el), el.getAttribute("placeholder"), el.name, el.id].filter(Boolean).join(" / ").slice(0, 1500);

  // tr/fieldset 구조가 없는 폼(div나 dt/dd로 라벨과 입력칸을 나열하는 흔한 레이아웃)도 많아서,
  // 그런 경우엔 감싸는 요소의 텍스트를 좁은 범위부터 시도해 "이 칸 주변에 뭐라고 적혀
  // 있는가"를 최대한 건진다. 이미 너무 커진(다른 칸까지 섞였을) 블록은 위로 올라가도 더
  // 커지기만 하므로 그 지점에서 포기한다 — 틀린 문맥보다 문맥 없음이 낫다.
  const contextOf = (el) => {
    const related = [formBlockTitle(el), formBlockDescription(el), nearbyLabelOf(el),
      el.closest("fieldset")?.querySelector(":scope > legend")].map(textOf).filter(Boolean);
    const structural = [el.closest("tr")].map(textOf).filter(Boolean);
    if (structural.length) return [...new Set([...related, ...structural])].join(" ").slice(0, 4000);
    for (let node = el.parentElement, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
      const text = textOf(node);
      if (text && text.length <= 300) return [...new Set([...related, text])].join(" ").slice(0, 4000);
      if (text.length > 300) break;
    }
    return [...new Set(related)].join(" ").slice(0, 4000);
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
