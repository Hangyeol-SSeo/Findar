"use client";

import { useCallback, useState } from "react";
import type { SubmissionMethodInfo } from "@/lib/application-method";
import type { DocumentFillResult } from "@/lib/application-task-types";
import { DEFAULT_FREEFORM_OPTIONS, type FreeformOptions } from "@/lib/freeform-application";
import type { FreeformComposition } from "@/lib/freeform-composition";
import FreeformCompositionEditor from "./FreeformCompositionEditor";

export default function FreeformApplicationForm({ seq, method, busy, generating, result, onGenerate }: {
  seq: string;
  method: SubmissionMethodInfo | null;
  busy: boolean;
  generating: boolean;
  result: DocumentFillResult | null;
  onGenerate: (options: FreeformOptions) => Promise<void>;
}) {
  const [options, setOptions] = useState(DEFAULT_FREEFORM_OPTIONS);
  const [ready, setReady] = useState(false);
  const setComposition = useCallback((composition: FreeformComposition | null) => setOptions(prev => ({ ...prev, composition })), []);
  const status = method?.freeform?.status;
  return <div className="space-y-3 rounded-lg border border-gray-200 p-3">
    <div className="flex flex-wrap items-center gap-2">
      <h4 className="text-sm font-semibold">자유양식 지원서 만들기</h4>
      {status === "freeform" && <span className="rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-700">자유양식 안내가 있는 공고</span>}
    </div>
    <p className="text-xs leading-5 text-gray-600">별도 양식 없이 제출하는 공고에 사용할 Word 지원서를 만듭니다. 이 공고에 넣을 이력을 먼저 고르고, 저장한 자기소개서와 함께 채웁니다.</p>
    {method?.freeform?.evidence && <p className="text-xs leading-5 text-gray-600">공고 안내: {method.freeform.evidence}</p>}
    {(status === "mixed" || status === "provided") && <p className="text-xs leading-5 text-amber-800">회사 지정 양식도 확인됩니다. 자유양식으로 제출할 수 있는 서류인지 공고를 확인해주세요. 지정 양식은 아래 Word 양식 작성 기능으로 채울 수 있습니다.</p>}
    {status === "unknown" && <p className="text-xs text-gray-500">공고에서 자유양식 안내를 확인하지 못했습니다. 자유양식 제출이 가능한 경우 사용해주세요.</p>}
    {status === "essay_only" && <p className="text-xs leading-5 text-gray-600">자기소개서에 자유양식 안내가 있습니다. 이력서까지 자유양식인지 확인하고 필요한 서류만 선택해주세요. 인터넷 접수 공고라면 자기소개서 본문을 지원 사이트에 입력해주세요.</p>}
    <fieldset disabled={busy} className="space-y-2">
      <legend className="mb-2 text-xs font-medium">포함할 내용</legend>
      <label className="flex items-center gap-2 text-sm">지원 구분
        <select value={options.applicationType} onChange={(event) => setOptions((prev) => ({ ...prev, applicationType: event.target.value as FreeformOptions["applicationType"] }))} className="rounded border border-gray-300 bg-white px-2 py-1">
          <option value="">선택 안 함</option><option value="신입">신입</option><option value="경력">경력</option><option value="인턴">인턴</option>
        </select>
      </label>
      <div className="grid gap-2 text-sm sm:grid-cols-2">
        {([
          ["includeDetails", "상세 경험을 별도 페이지에 배치"], ["includeEssays", "이 공고의 자기소개서"],
          ["includeMilitary", "병역"], ["includePersonalDetails", "생년월일·성별·국적·주소"],
        ] as const).map(([key, label]) => <label key={key} className="flex items-center gap-2">
          <input type="checkbox" checked={options[key]} onChange={(event) => setOptions((prev) => ({ ...prev, [key]: event.target.checked }))} />{label}
        </label>)}
      </div>
    </fieldset>
    <FreeformCompositionEditor seq={seq} disabled={busy} value={options.composition} onChange={setComposition} onReady={setReady} />
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={busy || !ready} onClick={() => onGenerate({ ...options, mode: "filled" })} className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40">{generating ? "지원서 생성 중..." : "선택한 이력으로 지원서 만들기"}</button>
      <button type="button" disabled={busy} onClick={() => onGenerate({ ...options, mode: "blank" })} className="rounded-lg border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-40">빈 양식 만들기</button>
    </div>
    <p className="text-xs leading-5 text-gray-500">자기소개서가 없으면 기본 소제목을 넣습니다. 답변을 저장한 뒤 다시 생성할 수 있습니다. 문서에서 항목과 분량을 수정하고 공고의 제출 형식에 맞춰 제출해주세요.</p>
    {result && <div className="space-y-2 text-xs" role="status">
      <a className="inline-flex rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700" href={result.downloadUrl} download={result.filename}>생성한 지원서 다운로드</a>
      <p className="break-all">{result.filename} · 30분 동안 다운로드 가능</p>
      <p className="text-gray-500">{result.note}</p>
      {result.skipped.length > 0 && <details open><summary>확인할 항목 {result.skipped.length}개</summary><ul className="mt-2 list-disc space-y-1 pl-5">{result.skipped.map((item, i) => <li key={i}>{item.label}: {item.reason}</li>)}</ul></details>}
    </div>}
  </div>;
}
