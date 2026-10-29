"use client";

import { useEffect, useRef, useState } from "react";
import { MANUAL_JOB_LIMITS, POSTING_IMAGE_LIMITS } from "@/lib/manual-jobs";

export interface ManualJobSaved<Job> {
  job: Job;
  summarized: boolean;
  matched: boolean;
}

interface Fields {
  company: string;
  title: string;
  url: string;
  deadline: string;
  content: string;
}

interface PostingImage {
  id: string;
  name: string;
  blob: Blob;
  preview: string;
}

const EMPTY: Fields = { company: "", title: "", url: "", deadline: "", content: "" };
const inputClass = "w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-200";
const IMAGE_TYPES = /^image\/(?:png|jpe?g|gif|webp)$/;
// 판독 한 번에 보내는 조각 수(서버 상한과 같다). 더 길면 나눠 보내고, 너무 길면 막는다.
const MAX_TOTAL_SLICES = POSTING_IMAGE_LIMITS.slices * 3;

// 금융투자협회 게시판에 없는 공고(자체 채용 사이트 공채 등)를 직접 넣는 창. seq를 주면 직접 추가한 그 공고를 고친다.
// 저장하면 서버가 요약·매칭을 한 건 돌려 다른 공고와 같은 모양으로 목록에 넣는다(POST /api/jobs/manual).
// 본문이 이미지인 공고는 이미지를 올리거나 붙여 넣으면 글자를 옮겨 본문 칸에 채운다(저장 전에 사용자가 확인한다).
export default function ManualJobForm<Job>({
  seq,
  onClose,
  onSaved,
}: {
  seq: string | null;
  onClose: () => void;
  onSaved: (result: ManualJobSaved<Job>) => void;
}) {
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [loadingExisting, setLoadingExisting] = useState(!!seq);
  const [reading, setReading] = useState(false);
  const [readNote, setReadNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [images, setImages] = useState<PostingImage[]>([]);
  const [transcribing, setTranscribing] = useState(false);
  const [imageNote, setImageNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const firstInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const imagesRef = useRef<PostingImage[]>([]);
  imagesRef.current = images;

  useEffect(() => () => imagesRef.current.forEach((image) => URL.revokeObjectURL(image.preview)), []);

  useEffect(() => {
    if (!seq) {
      firstInput.current?.focus();
      return;
    }
    const abort = new AbortController();
    fetch(`/api/jobs/manual?seq=${encodeURIComponent(seq)}`, { cache: "no-store", signal: abort.signal })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "공고를 불러오지 못했습니다.");
        setFields({ company: data.company, title: data.title, url: data.url, deadline: data.deadline, content: data.content });
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoadingExisting(false);
      });
    return () => abort.abort();
  }, [seq]);

  const busy = saving || transcribing;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const set = (key: keyof Fields) => (e: { target: { value: string } }) =>
    setFields((prev) => ({ ...prev, [key]: e.target.value }));

  function addImages(blobs: { blob: Blob; name: string }[]) {
    const accepted = blobs.filter(({ blob }) => IMAGE_TYPES.test(blob.type));
    if (accepted.length < blobs.length) setImageNote({ ok: false, text: "PNG·JPG·GIF·WebP 이미지만 넣을 수 있습니다." });
    if (!accepted.length) return;
    setImages((prev) => [
      ...prev,
      ...accepted.map(({ blob, name }) => ({ id: crypto.randomUUID(), name, blob, preview: URL.createObjectURL(blob) })),
    ]);
  }

  function removeImage(id: string) {
    setImages((prev) => {
      const target = prev.find((image) => image.id === id);
      if (target) URL.revokeObjectURL(target.preview);
      return prev.filter((image) => image.id !== id);
    });
  }

  // 이미지를 순서대로 잘라 판독하고, 읽은 글자를 본문 칸 끝에 붙인다. 성공한 이미지는 목록에서 뺀다.
  async function transcribe(targets: PostingImage[]) {
    if (!targets.length) return;
    setTranscribing(true);
    setImageNote(null);
    try {
      const slices: string[] = [];
      for (const image of targets) slices.push(...(await sliceImage(image.blob)));
      if (slices.length > MAX_TOTAL_SLICES) throw new Error("이미지가 너무 깁니다. 몇 장씩 나눠서 읽어주세요.");
      const texts: string[] = [];
      for (let i = 0; i < slices.length; i += POSTING_IMAGE_LIMITS.slices) {
        const res = await fetch("/api/jobs/manual/images", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ images: slices.slice(i, i + POSTING_IMAGE_LIMITS.slices).map((data) => ({ data })) }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "이미지에서 글자를 읽지 못했습니다.");
        texts.push(data.text);
      }
      const text = texts.join("\n\n");
      setFields((prev) => ({ ...prev, content: (prev.content.trim() ? `${prev.content.trimEnd()}\n\n${text}` : text).slice(0, MANUAL_JOB_LIMITS.content) }));
      setImages((prev) => {
        const done = new Set(targets.map((image) => image.id));
        prev.filter((image) => done.has(image.id)).forEach((image) => URL.revokeObjectURL(image.preview));
        return prev.filter((image) => !done.has(image.id));
      });
      setImageNote({ ok: true, text: "이미지의 글자를 본문에 채웠습니다. AI가 옮긴 글이라 틀린 글자가 있을 수 있으니 확인하고 저장해주세요." });
    } catch (e) {
      setImageNote({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTranscribing(false);
    }
  }

  async function readLink() {
    if (!fields.url.trim()) return;
    if (fields.content.trim() && !window.confirm("지금 입력한 본문을 링크에서 읽은 내용으로 바꿀까요?")) return;
    setReading(true);
    setReadNote(null);
    try {
      const res = await fetch("/api/jobs/manual/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: fields.url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "링크를 읽지 못했습니다.");
      if (!data.ok) {
        // 본문은 못 읽어도 페이지 제목은 왔으면 비어 있는 제목 칸에 채운다.
        if (data.title) setFields((prev) => ({ ...prev, title: prev.title || data.title }));
        setReadNote({ ok: false, text: data.reason });
        return;
      }
      setFields((prev) => ({ ...prev, content: data.text, title: prev.title || data.title || "" }));
      const pageImages: PostingImage[] = (data.images as { url: string; mediaType: string; data: string }[]).map((image) => {
        const blob = base64ToBlob(image.data, image.mediaType);
        return { id: crypto.randomUUID(), name: image.url.split(/[?#]/)[0].split("/").pop() || "이미지", blob, preview: URL.createObjectURL(blob) };
      });
      setImages((prev) => [...prev, ...pageImages]);
      if (data.text && pageImages.length) {
        setReadNote({ ok: true, text: `본문을 채웠습니다. 페이지의 이미지 ${pageImages.length}장도 아래에 넣었습니다 — 공고 내용이 담긴 이미지만 남기고 글자 읽기를 누르세요.` });
      } else if (data.text) {
        setReadNote({ ok: true, text: "본문을 채웠습니다. 메뉴·안내 문구가 섞였으면 지우고 저장해주세요." });
      } else {
        // 본문이 전부 이미지인 페이지 — 바로 글자를 읽는다.
        setReadNote({ ok: true, text: `본문이 이미지로 된 페이지라 이미지 ${pageImages.length}장의 글자를 읽습니다.` });
        await transcribe(pageImages);
      }
    } catch (e) {
      setReadNote({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setReading(false);
    }
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/jobs/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fields, ...(seq ? { seq } : {}) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "저장하지 못했습니다.");
      onSaved(data as ManualJobSaved<Job>);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  const disabled = busy || loadingExisting;
  const canSave = !disabled && !reading && fields.company.trim() && fields.title.trim() && fields.content.trim();

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 px-4 py-10"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-job-title"
        className="w-full max-w-2xl rounded-2xl bg-white shadow-xl"
        onPaste={(e) => {
          // 캡처한 공고 화면을 붙여 넣으면 이미지로 받는다. 글자 붙여넣기는 그대로 둔다.
          const files = Array.from(e.clipboardData.files).filter((file) => file.type.startsWith("image/"));
          if (!files.length || disabled) return;
          e.preventDefault();
          addImages(files.map((file) => ({ blob: file, name: file.name || "붙여 넣은 이미지" })));
        }}
      >
        <div className="border-b border-gray-100 px-6 py-4">
          <h2 id="manual-job-title" className="text-lg font-bold">
            {seq ? "직접 추가한 공고 수정" : "공고 직접 추가"}
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            금융투자협회 게시판에 없는 공고(자체 채용 사이트 공채 등)를 넣으면 다른 공고처럼 요약·매칭해 목록에 함께 보여줍니다.
          </p>
        </div>

        <div className="space-y-4 px-6 py-5">
          <div>
            <label htmlFor="manual-job-url" className="mb-1 block text-xs text-gray-500">공고 링크 <span className="text-gray-400">(선택)</span></label>
            <div className="flex gap-2">
              <input
                id="manual-job-url"
                ref={firstInput}
                type="url"
                inputMode="url"
                placeholder="https://"
                value={fields.url}
                onChange={set("url")}
                disabled={disabled}
                maxLength={MANUAL_JOB_LIMITS.url}
                className={inputClass}
              />
              <button
                type="button"
                onClick={readLink}
                disabled={disabled || reading || !fields.url.trim()}
                className="shrink-0 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                {reading ? "읽는 중..." : "링크에서 본문 읽기"}
              </button>
            </div>
            {readNote && (
              <p className={`mt-1.5 text-xs ${readNote.ok ? "text-gray-500" : "text-amber-700"}`}>{readNote.text}</p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <div>
              <label htmlFor="manual-job-company" className="mb-1 block text-xs text-gray-500">회사명</label>
              <input id="manual-job-company" value={fields.company} onChange={set("company")} disabled={disabled}
                maxLength={MANUAL_JOB_LIMITS.company} placeholder="예: 메리츠증권" className={inputClass} />
            </div>
            <div>
              <label htmlFor="manual-job-title-input" className="mb-1 block text-xs text-gray-500">공고 제목</label>
              <input id="manual-job-title-input" value={fields.title} onChange={set("title")} disabled={disabled}
                maxLength={MANUAL_JOB_LIMITS.title} placeholder="예: 2026년 대졸 신입사원 공개채용" className={inputClass} />
            </div>
            <div>
              <label htmlFor="manual-job-deadline" className="mb-1 block text-xs text-gray-500">마감일 <span className="text-gray-400">(선택)</span></label>
              <input id="manual-job-deadline" type="date" value={fields.deadline} onChange={set("deadline")} disabled={disabled}
                className={inputClass} />
            </div>
          </div>
          <p className="-mt-2 text-xs text-gray-400">마감일을 비워 두면 본문에서 찾습니다. 같은 회사의 다른 공고와는 회사명이 같아야 회사 메모·리서치가 함께 묶입니다.</p>

          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-xs text-gray-500">공고 이미지 <span className="text-gray-400">(본문이 이미지인 공고)</span></span>
              {images.length > 0 && (
                <button
                  type="button"
                  onClick={() => transcribe(images)}
                  disabled={disabled}
                  className="text-xs font-medium text-blue-600 hover:underline disabled:opacity-50"
                >
                  {transcribing ? "글자 읽는 중..." : `이미지 ${images.length}장에서 글자 읽기`}
                </button>
              )}
            </div>
            <div
              onDragOver={(e) => {
                if (disabled) return;
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                if (disabled) return;
                addImages(Array.from(e.dataTransfer.files).map((file) => ({ blob: file, name: file.name })));
              }}
              className={`rounded-lg border border-dashed px-3 py-3 text-xs transition-colors ${
                dragging ? "border-blue-400 bg-blue-50" : "border-gray-300"
              }`}
            >
              {images.length > 0 && (
                <ul className="mb-2 flex flex-wrap gap-2">
                  {images.map((image) => (
                    <li key={image.id} className="relative">
                      {/* eslint-disable-next-line @next/next/no-img-element -- 로컬 미리보기(blob URL) */}
                      <img src={image.preview} alt={image.name} title={image.name} className="h-20 w-16 rounded border border-gray-200 object-cover object-top" />
                      <button
                        type="button"
                        onClick={() => removeImage(image.id)}
                        disabled={disabled}
                        aria-label={`${image.name} 빼기`}
                        className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-gray-700 text-[11px] leading-none text-white hover:bg-gray-900 disabled:opacity-50"
                      >
                        &times;
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-gray-500">
                공고 이미지를 끌어다 놓거나, 캡처한 화면을 이 창에서 붙여 넣거나(⌘V),{" "}
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  disabled={disabled}
                  className="font-medium text-blue-600 hover:underline disabled:opacity-50"
                >
                  파일을 고르세요
                </button>
                . AI가 글자를 옮겨 아래 본문 칸에 채웁니다.
              </p>
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                className="hidden"
                onChange={(e) => {
                  addImages(Array.from(e.target.files ?? []).map((file) => ({ blob: file, name: file.name })));
                  e.target.value = "";
                }}
              />
            </div>
            {imageNote && (
              <p className={`mt-1.5 text-xs ${imageNote.ok ? "text-gray-500" : "text-amber-700"}`}>{imageNote.text}</p>
            )}
          </div>

          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <label htmlFor="manual-job-content" className="text-xs text-gray-500">공고 본문</label>
              <span className="text-[11px] text-gray-400">
                {fields.content.length.toLocaleString()} / {MANUAL_JOB_LIMITS.content.toLocaleString()}자
              </span>
            </div>
            <textarea
              id="manual-job-content"
              value={fields.content}
              onChange={set("content")}
              disabled={disabled}
              maxLength={MANUAL_JOB_LIMITS.content}
              rows={12}
              placeholder="채용 사이트의 공고 본문(모집 부문, 자격 요건, 전형 절차, 접수 기간 등)을 복사해 붙여 넣으세요."
              className={`${inputClass} resize-y leading-relaxed`}
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-6 py-4">
          {saving && <span className="mr-auto text-xs text-gray-500">공고를 요약하고 이력서와 매칭하는 중입니다...</span>}
          {transcribing && <span className="mr-auto text-xs text-gray-500">이미지의 글자를 옮기는 중입니다. 이미지가 길면 1분 넘게 걸릴 수 있습니다...</span>}
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            취소
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!canSave}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? "저장 중..." : seq ? "수정 저장" : "추가"}
          </button>
        </div>
      </div>
    </div>
  );
}

// 긴 공고 이미지를 모델이 받는 크기의 조각으로 자른다. 폭은 줄이고, 세로는 조금씩 겹쳐 잘라 경계의 줄이 끊기지 않게 한다.
async function sliceImage(blob: Blob): Promise<string[]> {
  const { sliceHeight, maxWidth, overlap } = POSTING_IMAGE_LIMITS;
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, maxWidth / bitmap.width);
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const slices: string[] = [];
    for (let top = 0; ; top += sliceHeight - overlap) {
      const h = Math.min(sliceHeight, height - top);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = h;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("이미지를 처리하지 못했습니다.");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, h);
      context.drawImage(bitmap, 0, top / scale, bitmap.width, h / scale, 0, 0, width, h);
      const jpeg = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("이미지를 처리하지 못했습니다."))), "image/jpeg", 0.88));
      slices.push(await blobToBase64(jpeg));
      if (top + h >= height) break;
    }
    return slices;
  } finally {
    bitmap.close();
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("이미지를 읽지 못했습니다."));
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(data: string, type: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}
