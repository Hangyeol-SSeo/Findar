"use client";

import { useState, useEffect, useCallback } from "react";

interface PersonalField {
  label: string;
  value: string;
}

interface EssayAnswer {
  question: string;
  answer: string;
}

interface ApplicationDraft {
  seq: string;
  personalFields: PersonalField[];
  essayAnswers: EssayAnswer[];
  notesForUser: string[];
  generatedAt: number;
}

interface Attachment {
  name: string;
  url: string;
}

interface SubmissionMethodInfo {
  method: "email_attachment" | "web_form" | "unknown";
  submissionEmail: string | null;
  templateAttachments: Attachment[];
  consentAttachments: Attachment[];
}

function SaveToBankButton({ company, question, answer }: { company: string; question: string; answer: string }) {
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  return (
    <button
      onClick={() => {
        setState("saving");
        fetch("/api/essay-bank", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ company, question, answer }),
        })
          .then(() => setState("saved"))
          .catch(() => setState("idle"));
      }}
      disabled={state !== "idle" || !answer.trim()}
      className="text-xs text-gray-400 hover:text-gray-600 shrink-0 disabled:opacity-40"
      title="확정한 답변을 다음 자소서 작성 시 참고자료로 저장"
    >
      {state === "saved" ? "저장됨" : state === "saving" ? "저장 중..." : "자료로 저장"}
    </button>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {});
      }}
      className="text-xs text-gray-400 hover:text-gray-600 shrink-0"
    >
      {copied ? "복사됨" : "복사"}
    </button>
  );
}

export default function ApplicationDraftPanel({
  seq,
  companyName,
}: {
  seq: string;
  companyName: string;
}) {
  const [draft, setDraft] = useState<ApplicationDraft | null>(null);
  const [submissionMethod, setSubmissionMethod] = useState<SubmissionMethodInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [customQuestion, setCustomQuestion] = useState("");
  const [askingCustom, setAskingCustom] = useState(false);

  useEffect(() => {
    setLoading(true);
    setDraft(null);
    setSubmissionMethod(null);
    setError("");
    fetch(`/api/applications/${seq}/draft`)
      .then((r) => r.json())
      .then(
        ({
          draft,
          submissionMethod,
        }: {
          draft: ApplicationDraft | null;
          submissionMethod: SubmissionMethodInfo | null;
        }) => {
          setDraft(draft);
          setSubmissionMethod(submissionMethod);
        }
      )
      .catch(() => setError("불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }, [seq]);

  const generate = useCallback(async () => {
    setGenerating(true);
    setError("");
    try {
      const res = await fetch(`/api/applications/${seq}/draft`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "초안 생성에 실패했습니다.");
        return;
      }
      setDraft(data.draft);
    } catch {
      setError("초안 생성 중 오류가 발생했습니다.");
    } finally {
      setGenerating(false);
    }
  }, [seq]);

  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await fetch(`/api/applications/${seq}/draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
    } finally {
      setSaving(false);
    }
  }, [seq, draft]);

  const updatePersonalField = (i: number, value: string) => {
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            personalFields: prev.personalFields.map((f, idx) =>
              idx === i ? { ...f, value } : f
            ),
          }
        : prev
    );
  };

  const updateEssayAnswer = (i: number, answer: string) => {
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            essayAnswers: prev.essayAnswers.map((a, idx) =>
              idx === i ? { ...a, answer } : a
            ),
          }
        : prev
    );
  };

  const askCustomQuestion = useCallback(async () => {
    const question = customQuestion.trim();
    if (!question) return;
    setAskingCustom(true);
    setError("");
    try {
      const res = await fetch(`/api/applications/${seq}/draft/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "답변 생성에 실패했습니다.");
        return;
      }
      setDraft((prev) =>
        prev
          ? {
              ...prev,
              essayAnswers: [
                ...prev.essayAnswers.filter((a) => a.question !== question),
                data.answer,
              ],
            }
          : {
              seq,
              personalFields: [],
              essayAnswers: [data.answer],
              notesForUser: [],
              generatedAt: Date.now(),
            }
      );
      setCustomQuestion("");
    } catch {
      setError("답변 생성 중 오류가 발생했습니다.");
    } finally {
      setAskingCustom(false);
    }
  }, [seq, customQuestion]);

  if (loading) {
    return <div className="text-sm text-gray-400 py-8 text-center">불러오는 중...</div>;
  }

  return (
    <div>
      {submissionMethod && submissionMethod.method !== "unknown" && (
        <div className="mb-4 p-3 rounded-lg bg-blue-50 border border-blue-100 text-xs text-blue-800">
          {submissionMethod.method === "email_attachment" ? (
            <div>
              <p className="font-semibold mb-1">📎 첨부 양식 작성 후 이메일 제출로 보입니다</p>
              {submissionMethod.submissionEmail && (
                <p>
                  제출 이메일: <span className="font-mono">{submissionMethod.submissionEmail}</span>
                </p>
              )}
              {submissionMethod.templateAttachments.length > 0 && (
                <div className="mt-1">
                  <p>지원서 양식:</p>
                  <ul className="list-disc list-inside">
                    {submissionMethod.templateAttachments.map((a, i) => (
                      <li key={i}>
                        <a href={a.url} target="_blank" rel="noopener noreferrer" className="underline">
                          {a.name}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {submissionMethod.consentAttachments.length > 0 && (
                <div className="mt-1">
                  <p>개인정보 동의서(서명 필요):</p>
                  <ul className="list-disc list-inside">
                    {submissionMethod.consentAttachments.map((a, i) => (
                      <li key={i}>
                        <a href={a.url} target="_blank" rel="noopener noreferrer" className="underline">
                          {a.name}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="mt-1 text-blue-600">
                양식을 다운로드해 아래 초안 내용을 직접 복사·붙여넣기 해주세요.
              </p>
            </div>
          ) : (
            <div>
              <p className="font-semibold mb-1">🌐 웹 지원폼으로 보입니다</p>
              <p className="mb-2">
                사이트마다 폼 구조가 달라 자동으로 채우는 규칙을 만들기 어려웠습니다. 대신
                Claude Code 세션에서 아래처럼 요청하면, 실제 사이트를 열어 이 초안을 참고해
                채워드립니다 (제출은 항상 직접 해야 합니다).
              </p>
              <div className="flex items-center gap-2 bg-white rounded-lg px-2.5 py-1.5 border border-blue-200">
                <code className="text-xs text-gray-700 flex-1">
                  이 공고 지원 도와줘 (seq={seq})
                </code>
                <CopyButton text={`이 공고 지원 도와줘 (seq=${seq})`} />
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex items-start justify-between mb-4 gap-3">
        <p className="text-xs text-gray-400">
          이력서 프로필 + 공고 + 회사 리서치를 바탕으로 AI가 작성한 초안입니다. 반드시 직접
          검토·수정한 뒤 사용하세요. 제출은 항상 직접 해야 합니다. (프로젝트 루트의
          cover-letters/ 폴더에 과거 자소서 PDF를 넣어두면 문체·소재를 참고합니다.)
        </p>
        <button
          onClick={generate}
          disabled={generating}
          className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
        >
          {generating ? "생성 중..." : draft ? "다시 생성" : "초안 생성"}
        </button>
      </div>

      {error && <p className="text-xs text-red-500 mb-3">{error}</p>}

      {!draft && !generating && (
        <p className="text-sm text-gray-400 py-8 text-center">
          아직 초안이 없습니다. &quot;초안 생성&quot;을 눌러주세요.
        </p>
      )}

      {draft && (
        <div className="space-y-5">
          {draft.notesForUser.length > 0 && (
            <div className="bg-amber-50 border border-amber-100 rounded-lg p-3">
              <ul className="text-xs text-amber-700 space-y-1">
                {draft.notesForUser.map((n, i) => (
                  <li key={i}>· {n}</li>
                ))}
              </ul>
            </div>
          )}

          {draft.personalFields.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-gray-700 mb-2">개인정보 필드</h4>
              <div className="space-y-2">
                {draft.personalFields.map((f, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <label className="text-xs text-gray-400 w-24 shrink-0">{f.label}</label>
                    <input
                      value={f.value}
                      onChange={(e) => updatePersonalField(i, e.target.value)}
                      className="flex-1 text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-200"
                    />
                    <CopyButton text={f.value} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {draft.essayAnswers.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-gray-700 mb-2">
                자기소개 답변 초안 ({draft.essayAnswers.length}개)
              </h4>
              <div className="space-y-2">
                {draft.essayAnswers.map((a, i) => (
                  <details
                    key={i}
                    className="bg-gray-50 rounded-lg border border-gray-100"
                    open={i === 0}
                  >
                    <summary className="flex items-center justify-between px-3 py-2 cursor-pointer list-none">
                      <span className="text-xs font-semibold text-gray-600 truncate">
                        {a.question}
                      </span>
                      <span className="text-xs text-gray-400 shrink-0 ml-2">
                        {a.answer.length}자
                      </span>
                    </summary>
                    <div className="px-3 pb-3">
                      <textarea
                        value={a.answer}
                        onChange={(e) => updateEssayAnswer(i, e.target.value)}
                        rows={8}
                        className="w-full text-sm border border-gray-200 rounded-lg p-2 focus:outline-none focus:ring-2 focus:ring-blue-200"
                      />
                      <div className="flex items-center gap-3 mt-1.5">
                        <CopyButton text={a.answer} />
                        <SaveToBankButton
                          company={companyName}
                          question={a.question}
                          answer={a.answer}
                        />
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            </div>
          )}

          <div className="bg-white border border-gray-200 rounded-lg p-3">
            <h4 className="text-xs font-semibold text-gray-600 mb-1.5">
              실제 폼의 정확한 문항으로 맞춤 초안 받기
            </h4>
            <p className="text-xs text-gray-400 mb-2">
              공고마다 문항 문구가 다르니, 실제 지원폼이나 첨부 양식에 적힌 문항을 그대로
              붙여넣으면 그 문항에 맞춘 답변을 새로 만들어줍니다.
            </p>
            <div className="flex gap-2">
              <input
                value={customQuestion}
                onChange={(e) => setCustomQuestion(e.target.value)}
                placeholder="예: 지원동기, 성격(장단점), 특기사항, 희망업무, 입사 후 계획 등을 자유롭게 기술"
                className="flex-1 text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-200"
              />
              <button
                onClick={askCustomQuestion}
                disabled={askingCustom || !customQuestion.trim()}
                className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                {askingCustom ? "작성 중..." : "초안 받기"}
              </button>
            </div>
          </div>

          <button
            onClick={save}
            disabled={saving}
            className="text-xs px-3 py-1.5 rounded-lg bg-gray-100 text-gray-700 font-medium hover:bg-gray-200 disabled:opacity-50 transition-colors"
          >
            {saving ? "저장 중..." : "수정 내용 저장"}
          </button>
        </div>
      )}
    </div>
  );
}
