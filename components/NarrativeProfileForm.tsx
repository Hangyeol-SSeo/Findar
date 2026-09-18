"use client";

import { useState, useEffect, useCallback, type ReactNode } from "react";
import type { NarrativeProfile, NarrativeEpisode, CoreNarrative } from "@/lib/narrative-profile";
import {
  NARRATIVE_SEED_QUESTIONS,
  SUGGESTED_NARRATIVE_TAGS,
  type NarrativeSeedQuestion,
} from "@/lib/narrative-questions";

// SUGGESTED_NARRATIVE_TAGS is a `readonly [...] as const` tuple of string
// literals — widen it once so `.includes(someString)` type-checks against a
// plain `string`, not the narrow literal union.
const ALL_TAGS: readonly string[] = SUGGESTED_NARRATIVE_TAGS;

const EMPTY_PROFILE: NarrativeProfile = {
  core: { coreValues: "", workCriteria: "", futureDirection: "", opennessToNewFields: "", updatedAt: 0 },
  episodes: [],
};

// ApplicantProfileForm.tsx의 save() 패턴(res.ok 체크 → showToast, catch에서도 실패 토스트)을
// 그대로 공유 helper로 뽑아, core 저장/episode 추가/수정/삭제 다섯 호출부가 전부 동일하게
// 거동하게 한다. 성공 시 응답의 profile로 로컬 상태를 갱신한다.
async function submitNarrative(
  url: string,
  init: RequestInit,
  showToast: (message: string) => void,
  onProfileChange: (profile: NarrativeProfile) => void
): Promise<boolean> {
  try {
    const res = await fetch(url, init);
    if (res.ok) {
      const data: { profile: NarrativeProfile } = await res.json();
      onProfileChange(data.profile);
    }
    showToast(res.ok ? "저장되었습니다" : "저장에 실패했습니다");
    return res.ok;
  } catch {
    showToast("저장에 실패했습니다");
    return false;
  }
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-5">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">{title}</h3>
      {children}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="text-xs text-gray-400 block mb-1">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-200"
      />
    </div>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  return (
    <div>
      <label className="text-xs text-gray-400 block mb-1">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className="w-full text-sm border border-gray-200 rounded-lg p-2.5 focus:outline-none focus:ring-2 focus:ring-blue-200"
      />
    </div>
  );
}

function TagPicker({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [customTag, setCustomTag] = useState("");

  const toggle = (tag: string) => {
    onChange(tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag]);
  };

  const addCustom = () => {
    const t = customTag.trim();
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setCustomTag("");
  };

  const customSelected = tags.filter((t) => !ALL_TAGS.includes(t));

  return (
    <div>
      <label className="text-xs text-gray-400 block mb-1">태그</label>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {ALL_TAGS.map((tag) => {
          const active = tags.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              onClick={() => toggle(tag)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                active
                  ? "bg-blue-600 border-blue-600 text-white"
                  : "border-gray-200 text-gray-500 hover:border-gray-300"
              }`}
            >
              {tag}
            </button>
          );
        })}
        {customSelected.map((tag) => (
          <button
            key={tag}
            type="button"
            onClick={() => toggle(tag)}
            className="text-xs px-2.5 py-1 rounded-full border bg-blue-600 border-blue-600 text-white"
          >
            {tag} ×
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={customTag}
          onChange={(e) => setCustomTag(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addCustom();
            }
          }}
          placeholder="직접 태그 입력"
          className="flex-1 text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-200"
        />
        <button
          type="button"
          onClick={addCustom}
          className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-500 hover:border-gray-400 hover:text-gray-700 whitespace-nowrap"
        >
          추가
        </button>
      </div>
    </div>
  );
}

function CoreValuesSection({
  core,
  showToast,
  onProfileChange,
}: {
  core: CoreNarrative;
  showToast: (message: string) => void;
  onProfileChange: (profile: NarrativeProfile) => void;
}) {
  const [coreValues, setCoreValues] = useState(core.coreValues);
  const [workCriteria, setWorkCriteria] = useState(core.workCriteria);
  const [futureDirection, setFutureDirection] = useState(core.futureDirection);
  const [opennessToNewFields, setOpennessToNewFields] = useState(core.opennessToNewFields);
  const [saving, setSaving] = useState(false);

  const save = useCallback(async () => {
    setSaving(true);
    await submitNarrative(
      "/api/profile/narrative",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coreValues, workCriteria, futureDirection, opennessToNewFields }),
      },
      showToast,
      onProfileChange
    );
    setSaving(false);
  }, [coreValues, workCriteria, futureDirection, opennessToNewFields, showToast, onProfileChange]);

  return (
    <Section title="핵심 가치관">
      <div className="space-y-3">
        <TextAreaField
          label="일/커리어에서 가장 중요하게 여기는 가치관"
          value={coreValues}
          onChange={setCoreValues}
        />
        <TextAreaField
          label="일/회사를 고를 때 실제 기준, 절대 타협 안 하는 것"
          value={workCriteria}
          onChange={setWorkCriteria}
        />
        <TextAreaField
          label="5~10년 뒤 되고 싶은 모습과 그 계기"
          value={futureDirection}
          onChange={setFutureDirection}
        />
        <TextAreaField
          label="이력서 궤적과 다른 분야에도 관심 갖는 이유"
          value={opennessToNewFields}
          onChange={setOpennessToNewFields}
        />
      </div>
      <button
        onClick={save}
        disabled={saving}
        className="mt-3 text-xs px-4 py-2 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
      >
        {saving ? "저장 중..." : "저장"}
      </button>
    </Section>
  );
}

// 이미 답변이 있는 episode(시드 질문 답변이든 "경험 추가"로 쌓인 것이든) 한 건을 접힌 행으로
// 보여주고, 펼치면 바로 수정 가능한 상태가 되는 컴포넌트.
//
// ApplicantProfileForm.tsx의 ListEditorRow와 동일한 패턴: `open`은 마운트 시 한 번만
// 계산(항상 false로 시작 — 이미 채워진 항목이므로 기본 접힘)하고, 이후로는 오직 <details>의
// onToggle을 통해서만 바뀐다. summarize(item)처럼 데이터에서 매 렌더 다시 계산하지 않는다 —
// 그렇게 하면 타이핑 중 패널이 강제로 닫히는, 이 파일 트리에서 이미 한 번 고쳐진 버그가
// 재발한다.
function EpisodeRow({
  episode,
  showToast,
  onProfileChange,
}: {
  episode: NarrativeEpisode;
  showToast: (message: string) => void;
  onProfileChange: (profile: NarrativeProfile) => void;
}) {
  const [open, setOpen] = useState(() => false);
  const [situation, setSituation] = useState(episode.situation);
  const [reasoning, setReasoning] = useState(episode.reasoning);
  const [lesson, setLesson] = useState(episode.lesson);
  const [tags, setTags] = useState<string[]>(episode.tags);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const save = useCallback(async () => {
    setSaving(true);
    await submitNarrative(
      `/api/profile/narrative/${episode.id}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ situation, reasoning, lesson, tags }),
      },
      showToast,
      onProfileChange
    );
    setSaving(false);
  }, [episode.id, situation, reasoning, lesson, tags, showToast, onProfileChange]);

  const remove = useCallback(async () => {
    setDeleting(true);
    await submitNarrative(
      `/api/profile/narrative/${episode.id}`,
      { method: "DELETE" },
      showToast,
      onProfileChange
    );
    setDeleting(false);
  }, [episode.id, showToast, onProfileChange]);

  return (
    <details
      className="border border-gray-200 rounded-lg"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="flex items-center justify-between px-3 py-2 cursor-pointer text-sm text-gray-700 list-none">
        <span className="truncate">{episode.title}</span>
        <button
          onClick={(e) => {
            e.preventDefault();
            remove();
          }}
          disabled={deleting}
          className="text-xs text-red-400 hover:text-red-600 shrink-0 ml-2 disabled:opacity-50"
        >
          삭제
        </button>
      </summary>
      <div className="p-3 pt-1 space-y-3">
        {episode.prompt && <p className="text-xs text-gray-400">{episode.prompt}</p>}
        <TextAreaField label="무슨 일이 있었나" value={situation} onChange={setSituation} />
        <TextAreaField label="그때 실제로 따졌던 이유" value={reasoning} onChange={setReasoning} />
        <TextAreaField label="지금과의 연결" value={lesson} onChange={setLesson} rows={2} />
        <TagPicker tags={tags} onChange={setTags} />
        <button
          onClick={save}
          disabled={saving}
          className="text-xs px-4 py-2 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {saving ? "저장 중..." : "저장"}
        </button>
      </div>
    </details>
  );
}

// 아직 답변이 없는 시드 질문 — 항상 펼쳐진 카드로 보여준다(접을 대상이 없으므로 details 패턴
// 대상이 아니다).
function SeedQuestionCard({
  question,
  showToast,
  onProfileChange,
}: {
  question: NarrativeSeedQuestion;
  showToast: (message: string) => void;
  onProfileChange: (profile: NarrativeProfile) => void;
}) {
  const [situation, setSituation] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [lesson, setLesson] = useState("");
  const [tags, setTags] = useState<string[]>(question.suggestedTags);
  const [saving, setSaving] = useState(false);

  const save = useCallback(async () => {
    setSaving(true);
    await submitNarrative(
      "/api/profile/narrative",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          promptId: question.id,
          prompt: question.prompt,
          title: "",
          situation,
          reasoning,
          lesson,
          tags,
          source: "seed",
        }),
      },
      showToast,
      onProfileChange
    );
    setSaving(false);
  }, [question.id, question.prompt, situation, reasoning, lesson, tags, showToast, onProfileChange]);

  return (
    <div className="border border-gray-200 rounded-lg p-3 space-y-3">
      <div>
        <p className="text-sm font-medium text-gray-700">{question.prompt}</p>
        {question.helperText && <p className="text-xs text-gray-400 mt-1">{question.helperText}</p>}
      </div>
      <TextAreaField label="무슨 일이 있었나" value={situation} onChange={setSituation} />
      <TextAreaField label="그때 실제로 따졌던 이유" value={reasoning} onChange={setReasoning} />
      <TextAreaField label="지금과의 연결" value={lesson} onChange={setLesson} rows={2} />
      <TagPicker tags={tags} onChange={setTags} />
      <button
        onClick={save}
        disabled={saving}
        className="text-xs px-4 py-2 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
      >
        {saving ? "저장 중..." : "저장"}
      </button>
    </div>
  );
}

// "경험 추가"로 열리는 빈 카드 — 시드 질문이 없으므로 질문/제목을 직접 입력받는 한 줄이
// 추가된다. 저장 성공 시 onDone()으로 부모가 카드를 접고, 새 episode는 이후
// customEpisodes 목록에 접힌 EpisodeRow로 자연스럽게 나타난다.
function NewCustomEpisodeCard({
  showToast,
  onProfileChange,
  onDone,
}: {
  showToast: (message: string) => void;
  onProfileChange: (profile: NarrativeProfile) => void;
  onDone: () => void;
}) {
  const [title, setTitle] = useState("");
  const [situation, setSituation] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [lesson, setLesson] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const save = useCallback(async () => {
    setSaving(true);
    const ok = await submitNarrative(
      "/api/profile/narrative",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          promptId: "custom",
          prompt: "",
          title,
          situation,
          reasoning,
          lesson,
          tags,
          source: "added",
        }),
      },
      showToast,
      onProfileChange
    );
    setSaving(false);
    if (ok) onDone();
  }, [title, situation, reasoning, lesson, tags, showToast, onProfileChange, onDone]);

  return (
    <div className="border border-gray-200 rounded-lg p-3 space-y-3">
      <Field label="질문/제목" value={title} onChange={setTitle} placeholder="예: 왜 이 분야로 방향을 틀었는가" />
      <TextAreaField label="무슨 일이 있었나" value={situation} onChange={setSituation} />
      <TextAreaField label="그때 실제로 따졌던 이유" value={reasoning} onChange={setReasoning} />
      <TextAreaField label="지금과의 연결" value={lesson} onChange={setLesson} rows={2} />
      <TagPicker tags={tags} onChange={setTags} />
      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={saving}
          className="text-xs px-4 py-2 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {saving ? "저장 중..." : "저장"}
        </button>
        <button
          onClick={onDone}
          className="text-xs px-4 py-2 rounded-lg border border-gray-300 text-gray-500 hover:border-gray-400 hover:text-gray-700"
        >
          취소
        </button>
      </div>
    </div>
  );
}

function EpisodesSection({
  profile,
  showToast,
  onProfileChange,
}: {
  profile: NarrativeProfile;
  showToast: (message: string) => void;
  onProfileChange: (profile: NarrativeProfile) => void;
}) {
  const [addingCustom, setAddingCustom] = useState(false);
  const customEpisodes = profile.episodes.filter((e) => e.source === "added");

  return (
    <Section title="선택과 전환점">
      <div className="space-y-3">
        {NARRATIVE_SEED_QUESTIONS.map((q) => {
          const episode = profile.episodes.find((e) => e.promptId === q.id);
          return episode ? (
            <EpisodeRow key={episode.id} episode={episode} showToast={showToast} onProfileChange={onProfileChange} />
          ) : (
            <SeedQuestionCard key={q.id} question={q} showToast={showToast} onProfileChange={onProfileChange} />
          );
        })}

        {customEpisodes.map((episode) => (
          <EpisodeRow key={episode.id} episode={episode} showToast={showToast} onProfileChange={onProfileChange} />
        ))}

        {addingCustom ? (
          <NewCustomEpisodeCard
            showToast={showToast}
            onProfileChange={onProfileChange}
            onDone={() => setAddingCustom(false)}
          />
        ) : (
          <button
            onClick={() => setAddingCustom(true)}
            className="text-xs px-3 py-2 rounded-lg border border-dashed border-gray-300 text-gray-500 hover:border-gray-400 hover:text-gray-700 w-full"
          >
            + 경험 추가
          </button>
        )}
      </div>
    </Section>
  );
}

export default function NarrativeProfileForm({
  showToast,
}: {
  showToast: (message: string) => void;
}) {
  const [profile, setProfile] = useState<NarrativeProfile>(EMPTY_PROFILE);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/profile/narrative")
      .then((r) => r.json())
      .then(({ profile }: { profile: NarrativeProfile }) => {
        if (profile) setProfile(profile);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="text-sm text-gray-400 py-8 text-center">불러오는 중...</div>;
  }

  return (
    <div className="space-y-4">
      <CoreValuesSection core={profile.core} showToast={showToast} onProfileChange={setProfile} />
      <EpisodesSection profile={profile} showToast={showToast} onProfileChange={setProfile} />
    </div>
  );
}
