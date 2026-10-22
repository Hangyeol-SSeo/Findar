"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MEMO_MAX_CHARS, type Memo, type MemoScope } from "@/lib/memo-types";

export type MemoSaved = (scope: MemoScope, key: string, memo: Memo | null) => void;

// 공고 상세 탭의 메모 두 칸. 공고 메모는 이 공고에만, 회사 메모는 같은 회사의 모든 공고에 보인다.
// 입력이 멈추면 자동 저장하고, 공고를 바꾸거나 창을 닫을 때 남은 입력을 보낸다.
export default function MemoPanel({
  seq,
  company,
  jobMemo,
  companyMemo,
  onSaved,
}: {
  seq: string;
  company: string;
  jobMemo: Memo | null;
  companyMemo: Memo | null;
  onSaved: MemoSaved;
}) {
  return (
    <div className="mb-5 space-y-3">
      <MemoField
        id={`job-memo-${seq}`}
        label="공고 메모"
        hint="이 공고에만 보입니다"
        placeholder="이 공고에 대해 기록할 내용 (예: 마감 전 확인할 서류, 문의한 내용)"
        initial={jobMemo}
        body={{ scope: "job", seq }}
        onSaved={onSaved}
      />
      <MemoField
        id={`company-memo-${seq}`}
        label="회사 메모"
        hint={`${company}의 모든 공고에 함께 보입니다`}
        placeholder="이 회사에 대해 기록할 내용 (예: 설명회에서 들은 것, 지인에게 들은 분위기)"
        initial={companyMemo}
        body={{ scope: "company", company }}
        onSaved={onSaved}
      />
    </div>
  );
}

const SAVE_DELAY_MS = 800;

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

function todayLabel(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function savedAtLabel(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("ko-KR");
}

function MemoField({
  id,
  label,
  hint,
  placeholder,
  initial,
  body,
  onSaved,
}: {
  id: string;
  label: string;
  hint: string;
  placeholder: string;
  initial: Memo | null;
  body: { scope: "job"; seq: string } | { scope: "company"; company: string };
  onSaved: MemoSaved;
}) {
  const [text, setText] = useState(initial?.text ?? "");
  const [state, setState] = useState<SaveState>("idle");
  const [savedAt, setSavedAt] = useState<number | null>(initial?.updatedAt ?? null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 아직 보내지 않은 입력. null이면 서버와 같다.
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 저장 요청을 한 줄로 세워 늦게 도착한 응답이 새 입력을 덮지 않게 한다.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);
  const bodyRef = useRef(body);
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    bodyRef.current = body;
    onSavedRef.current = onSaved;
  });

  const send = useCallback(async (value: string, keepalive: boolean) => {
    const response = await fetch("/api/memos", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...bodyRef.current, text: value }),
      keepalive,
    });
    if (!response.ok) throw new Error("save failed");
    const result: { scope: MemoScope; key: string; memo: Memo | null } = await response.json();
    onSavedRef.current(result.scope, result.key, result.memo);
    return result.memo;
  }, []);

  // keepalive: 공고를 바꿨거나 창을 닫는 중이라 응답을 기다릴 화면이 없다.
  const flush = useCallback((keepalive = false) => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const value = pending.current;
    if (value === null || value.length > MEMO_MAX_CHARS) return;
    pending.current = null;
    if (keepalive) {
      void send(value, true).catch(() => {});
      return;
    }
    setState("saving");
    queue.current = queue.current.then(async () => {
      try {
        const memo = await send(value, false);
        if (!mounted.current) return;
        if (pending.current === null) {
          setState("saved");
          setSavedAt(memo?.updatedAt ?? null);
        }
      } catch {
        if (pending.current === null) pending.current = value;
        if (mounted.current) setState("error");
      }
    });
  }, [send]);

  useEffect(() => {
    mounted.current = true;
    const onPageHide = () => flush(true);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      mounted.current = false;
      flush(true);
    };
  }, [flush]);

  function change(value: string) {
    setText(value);
    pending.current = value;
    setState("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => flush(), SAVE_DELAY_MS);
  }

  function addDate() {
    const stamp = `[${todayLabel()}] `;
    const next = text.trim() ? `${text.replace(/\s+$/, "")}\n${stamp}` : stamp;
    change(next);
    // 바로 이어 치는 글자가 이 칸으로 오도록 포커스는 지금 옮기고, 커서는 새 값이 그려진 뒤 끝에 둔다.
    const el = textareaRef.current;
    el?.focus();
    requestAnimationFrame(() => el?.setSelectionRange(next.length, next.length));
  }

  const over = text.length > MEMO_MAX_CHARS;
  const status =
    over ? `${MEMO_MAX_CHARS.toLocaleString()}자를 넘어 저장되지 않습니다`
    : state === "dirty" || state === "saving" ? "저장 중…"
    : state === "error" ? "저장 실패"
    : savedAt ? `저장됨 · ${savedAtLabel(savedAt)}`
    : "";

  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50/60 p-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <label htmlFor={id} className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-xs font-semibold text-gray-700">{label}</span>
          <span className="truncate text-[11px] text-gray-400">{hint}</span>
        </label>
        <div className="flex shrink-0 items-center gap-2">
          {status && (
            <span
              role={state === "error" || over ? "alert" : undefined}
              className={`text-[11px] ${state === "error" || over ? "text-red-500" : "text-gray-400"}`}
            >
              {status}
            </span>
          )}
          {state === "error" && !over && (
            <button type="button" onClick={() => flush()} className="text-[11px] font-medium text-blue-600 hover:underline">
              다시 저장
            </button>
          )}
          <button
            type="button"
            onClick={addDate}
            title="오늘 날짜로 새 줄을 시작합니다"
            className="rounded px-1.5 py-0.5 text-[11px] text-gray-500 hover:bg-gray-200/70 hover:text-gray-700"
          >
            날짜 추가
          </button>
        </div>
      </div>
      <textarea
        ref={textareaRef}
        id={id}
        value={text}
        onChange={(e) => change(e.target.value)}
        onBlur={() => flush()}
        placeholder={placeholder}
        rows={2}
        className="field-sizing-content block max-h-80 min-h-14 w-full resize-y rounded-md border border-gray-200 bg-white px-2.5 py-2 text-sm leading-relaxed text-gray-700 placeholder:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-200"
      />
    </div>
  );
}
