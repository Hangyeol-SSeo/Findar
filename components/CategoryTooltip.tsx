"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { POSITION_CATEGORY_INFO } from "@/lib/position-category-info";

const TOOLTIP_WIDTH = 288;
const VIEWPORT_MARGIN = 12;
const SHOW_DELAY_MS = 250;

// 직군 필터 버튼을 감싸 호버/포커스 시 직군 설명을 띄운다.
// 필터 줄이 화면 오른쪽 끝까지 이어지므로 body에 포털로 띄우고 뷰포트 안으로 위치를 보정한다.
export default function CategoryTooltip({ category, children }: { category: string; children: ReactNode }) {
  const info = POSITION_CATEGORY_INFO[category];
  const tooltipId = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);

  const hide = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setPos(null);
  }, []);

  const show = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const left = Math.min(
        Math.max(rect.left, VIEWPORT_MARGIN),
        window.innerWidth - TOOLTIP_WIDTH - VIEWPORT_MARGIN,
      );
      // 아래 공간이 부족하면 버튼 위로 띄운다.
      const above = window.innerHeight - rect.bottom < 220 && rect.top > 220;
      setPos({ left, top: above ? rect.top - 8 : rect.bottom + 8, above });
    }, SHOW_DELAY_MS);
  };

  useEffect(() => {
    if (!pos) return;
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [pos, hide]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  if (!info) return <>{children}</>;

  return (
    <span
      ref={anchorRef}
      className="inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      aria-describedby={pos ? tooltipId : undefined}
    >
      {children}
      {pos &&
        createPortal(
          <div
            id={tooltipId}
            role="tooltip"
            style={{
              left: pos.left,
              top: pos.top,
              width: TOOLTIP_WIDTH,
              transform: pos.above ? "translateY(-100%)" : undefined,
            }}
            className="pointer-events-none fixed z-50 rounded-lg border border-gray-200 bg-white p-3 text-left shadow-lg"
          >
            <p className="text-xs font-semibold text-gray-900">{category}</p>
            <p className="mt-1 text-xs leading-relaxed text-gray-600">{info.summary}</p>
            <ul className="mt-2 space-y-0.5">
              {info.duties.map((duty) => (
                <li key={duty} className="flex gap-1.5 text-[11px] leading-relaxed text-gray-600">
                  <span className="text-indigo-400">•</span>
                  <span>{duty}</span>
                </li>
              ))}
            </ul>
            {info.note && (
              <p className="mt-2 border-t border-gray-100 pt-2 text-[11px] leading-relaxed text-gray-400">
                {info.note}
              </p>
            )}
          </div>,
          document.body,
        )}
    </span>
  );
}
