"use client";

import { useState, useEffect, useCallback, type ReactNode } from "react";
import type {
  ApplicantProfile,
  ApplicantEducationEntry,
  ApplicantResearchEntry,
  ApplicantLanguageTest,
  ApplicantForeignLanguageSkill,
  ApplicantCertification,
  ApplicantAward,
  ApplicantActivity,
  ApplicantWorkExperience,
  ApplicantProjectEntry,
} from "@/lib/applicant-profile";

const EMPTY: ApplicantProfile = {
  name: "",
  nameEn: "",
  nameHanja: "",
  religion: "",
  hobbies: "",
  specialties: "",
  gender: "",
  birthDate: "",
  photoDataUrl: "",
  nationality: "대한민국",
  postalCode: "",
  address: "",
  addressDetail: "",
  email: "",
  phone: "",
  disabilityStatus: "비대상",
  disabilityDetail: "",
  veteranStatus: "비대상",
  veteranDetail: "",
  militaryStatus: "",
  militaryBranch: "",
  militarySpecialty: "",
  militaryRank: "",
  militaryServiceStart: "",
  militaryServiceEnd: "",
  militaryDischargeType: "",
  education: [],
  research: [],
  languageTests: [],
  foreignLanguageSkills: [],
  certifications: [],
  awards: [],
  activities: [],
  workExperiences: [],
  projects: [],
  skillsNote: "",
  portfolioLinks: "",
  updatedAt: 0,
};

function Field({
  label,
  value,
  onChange,
  placeholder,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="text-xs text-gray-400 block mb-1">{label}</label>
      <input
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-200"
      />
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="text-xs text-gray-400 block mb-1">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-200 bg-white"
      >
        <option value=""></option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-5">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">{title}</h3>
      {children}
    </div>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">{children}</div>;
}

function ListEditorRow<T>({
  item,
  index,
  addLabel,
  summarize,
  renderItem,
  onUpdate,
  onDelete,
}: {
  item: T;
  index: number;
  addLabel: string;
  summarize: (item: T) => string;
  renderItem: (item: T, update: (patch: Partial<T>) => void) => ReactNode;
  onUpdate: (patch: Partial<T>) => void;
  onDelete: () => void;
}) {
  // Initialized once from the item's initial state, then only ever changed by
  // the user toggling <summary> (via onToggle) — never re-derived from
  // summarize(item) on re-render, or typing into the row would force it
  // closed/open out from under the user.
  const [open, setOpen] = useState(() => !summarize(item));

  return (
    <details
      className="border border-gray-200 rounded-lg group"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="flex items-center justify-between px-3 py-2 cursor-pointer text-sm text-gray-700 list-none">
        <span className="truncate">{summarize(item) || `${addLabel} ${index + 1}`}</span>
        <button
          onClick={(e) => {
            e.preventDefault();
            onDelete();
          }}
          className="text-xs text-red-400 hover:text-red-600 shrink-0 ml-2"
        >
          삭제
        </button>
      </summary>
      <div className="p-3 pt-1 grid grid-cols-2 sm:grid-cols-3 gap-3">{renderItem(item, onUpdate)}</div>
    </details>
  );
}

function ListEditor<T>({
  items,
  onChange,
  newItem,
  renderItem,
  addLabel,
  summarize,
}: {
  items: T[];
  onChange: (items: T[]) => void;
  newItem: () => T;
  renderItem: (item: T, update: (patch: Partial<T>) => void) => ReactNode;
  addLabel: string;
  summarize: (item: T) => string;
}) {
  return (
    <div className="space-y-3">
      {items.map((item, i) => (
        <ListEditorRow
          key={i}
          item={item}
          index={i}
          addLabel={addLabel}
          summarize={summarize}
          renderItem={renderItem}
          onUpdate={(patch) => {
            const next = [...items];
            next[i] = { ...next[i], ...patch };
            onChange(next);
          }}
          onDelete={() => onChange(items.filter((_, idx) => idx !== i))}
        />
      ))}
      <button
        onClick={() => onChange([...items, newItem()])}
        className="text-xs px-3 py-2 rounded-lg border border-dashed border-gray-300 text-gray-500 hover:border-gray-400 hover:text-gray-700 w-full"
      >
        + {addLabel} 추가
      </button>
    </div>
  );
}

const emptyEducation = (): ApplicantEducationEntry => ({
  schoolLevel: "대학교",
  status: "",
  schoolName: "",
  schoolLocation: "",
  degreeType: "",
  admissionType: "",
  campus: "",
  dayNight: "",
  majorCategory: "",
  major: "",
  majorTrack: "",
  startDate: "",
  endDate: "",
  gpa: "",
  gpaMax: "4.5",
  majorCredits: "",
  majorGpa: "",
});

const emptyResearch = (): ApplicantResearchEntry => ({
  category: "",
  title: "",
  organizer: "",
  date: "",
  authorRank: "",
  role: "",
});

const emptyLanguageTest = (): ApplicantLanguageTest => ({
  testName: "",
  testId: "",
  date: "",
  score: "",
  scoreMax: "",
});

const emptyForeignLanguageSkill = (): ApplicantForeignLanguageSkill => ({
  language: "",
  reading: "",
  writing: "",
  speaking: "",
});

const emptyCertification = (): ApplicantCertification => ({
  name: "",
  issuer: "",
  registrationNumber: "",
  issuedDate: "",
});

const emptyAward = (): ApplicantAward => ({
  name: "",
  organizer: "",
  date: "",
  detail: "",
});

const emptyActivity = (): ApplicantActivity => ({
  category: "",
  organization: "",
  startDate: "",
  endDate: "",
  role: "",
  detail: "",
});

const emptyWorkExperience = (): ApplicantWorkExperience => ({
  employmentType: "",
  companyName: "",
  isCurrent: false,
  startDate: "",
  endDate: "",
  department: "",
  position: "",
  duties: "",
  resignReason: "",
});

const emptyProject = (): ApplicantProjectEntry => ({
  name: "",
  client: "",
  workplace: "",
  startDate: "",
  endDate: "",
  contributionPercent: "",
  role: "",
});

export default function ApplicantProfileForm({
  showToast,
}: {
  showToast: (message: string) => void;
}) {
  const [profile, setProfile] = useState<ApplicantProfile>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/profile/applicant")
      .then((r) => r.json())
      .then(({ profile }: { profile: ApplicantProfile }) => {
        if (profile) setProfile({ ...EMPTY, ...profile });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const patch = useCallback((p: Partial<ApplicantProfile>) => {
    setProfile((prev) => ({ ...prev, ...p }));
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/profile/applicant", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });
      showToast(res.ok ? "저장되었습니다" : "저장에 실패했습니다");
    } catch {
      showToast("저장에 실패했습니다");
    } finally {
      setSaving(false);
    }
  }, [profile, showToast]);

  const onPhotoSelected = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => patch({ photoDataUrl: String(reader.result || "") });
      reader.readAsDataURL(file);
    },
    [patch]
  );

  if (loading) {
    return <div className="text-sm text-gray-400 py-8 text-center">불러오는 중...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-400">
          실제 지원폼에 반복적으로 나오는 인적사항을 미리 채워두면, Claude in Chrome 등으로
          지원서를 자동 입력할 때 이 값을 그대로 참고합니다. AI가 추론하지 않고 여기 적은
          그대로 사용되니 정확하게 입력해주세요.
        </p>
        <button
          onClick={save}
          disabled={saving}
          className="text-xs px-4 py-2 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 ml-3"
        >
          {saving ? "저장 중..." : "저장"}
        </button>
      </div>

      <Section title="기본정보">
        <Grid>
          <Field label="이름" value={profile.name} onChange={(v) => patch({ name: v })} />
          <Field label="한자 이름" value={profile.nameHanja} onChange={(v) => patch({ nameHanja: v })} placeholder="한자 성명" />
          <Field
            label="영문이름"
            value={profile.nameEn}
            onChange={(v) => patch({ nameEn: v })}
            placeholder="Hong, Gil-Dong"
          />
          <Select
            label="성별"
            value={profile.gender}
            onChange={(v) => patch({ gender: v })}
            options={["남", "여"]}
          />
          <Field
            label="생년월일"
            value={profile.birthDate}
            onChange={(v) => patch({ birthDate: v })}
            placeholder="YYYY-MM-DD"
          />
          <Field label="국적" value={profile.nationality} onChange={(v) => patch({ nationality: v })} />
          <Field label="종교" value={profile.religion} onChange={(v) => patch({ religion: v })} placeholder="직접 입력 (선택)" />
        </Grid>

        <div className="mt-3">
          <label className="text-xs text-gray-400 block mb-1">사진</label>
          <div className="flex items-center gap-3">
            {profile.photoDataUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={profile.photoDataUrl}
                alt="증명사진"
                className="w-16 h-20 object-cover rounded border border-gray-200"
              />
            )}
            <input
              type="file"
              accept="image/*"
              onChange={(e) => onPhotoSelected(e.target.files?.[0])}
              className="text-xs"
            />
            {profile.photoDataUrl && (
              <button
                onClick={() => patch({ photoDataUrl: "" })}
                className="text-xs text-red-400 hover:text-red-600"
              >
                삭제
              </button>
            )}
          </div>
        </div>

      </Section>

      <Section title="주소 / 연락처">
        <div>
          <Grid>
            <Field
              label="우편번호"
              value={profile.postalCode}
              onChange={(v) => patch({ postalCode: v })}
            />
            <Field
              label="주소"
              value={profile.address}
              onChange={(v) => patch({ address: v })}
              className="col-span-2"
            />
            <Field
              label="상세주소"
              value={profile.addressDetail}
              onChange={(v) => patch({ addressDetail: v })}
              className="col-span-2"
            />
          </Grid>
        </div>

        <div className="mt-3">
          <Grid>
            <Field label="이메일" value={profile.email} onChange={(v) => patch({ email: v })} />
            <Field label="연락처" value={profile.phone} onChange={(v) => patch({ phone: v })} />
          </Grid>
        </div>
      </Section>

      <Section title="장애 / 보훈 / 병역">
        <Grid>
          <Select
            label="장애여부"
            value={profile.disabilityStatus}
            onChange={(v) => patch({ disabilityStatus: v })}
            options={["비대상", "대상"]}
          />
          {profile.disabilityStatus === "대상" && (
            <Field
              label="장애 내용"
              value={profile.disabilityDetail}
              onChange={(v) => patch({ disabilityDetail: v })}
              className="col-span-2"
            />
          )}
          <Select
            label="보훈여부"
            value={profile.veteranStatus}
            onChange={(v) => patch({ veteranStatus: v })}
            options={["비대상", "대상"]}
          />
          {profile.veteranStatus === "대상" && (
            <Field
              label="보훈 내용"
              value={profile.veteranDetail}
              onChange={(v) => patch({ veteranDetail: v })}
              className="col-span-2"
            />
          )}
        </Grid>
        <div className="mt-3">
          <Grid>
            <Select
              label="병역구분"
              value={profile.militaryStatus}
              onChange={(v) => patch({ militaryStatus: v })}
              options={["비대상", "군필", "미필", "면제", "복무중"]}
            />
            {profile.militaryStatus === "군필" || profile.militaryStatus === "복무중" ? (
              <>
                <Field
                  label="군별"
                  value={profile.militaryBranch}
                  onChange={(v) => patch({ militaryBranch: v })}
                />
                <Field
                  label="병과"
                  value={profile.militarySpecialty}
                  onChange={(v) => patch({ militarySpecialty: v })}
                />
                <Field
                  label="계급"
                  value={profile.militaryRank}
                  onChange={(v) => patch({ militaryRank: v })}
                />
                <Field
                  label="복무시작"
                  value={profile.militaryServiceStart}
                  onChange={(v) => patch({ militaryServiceStart: v })}
                  placeholder="YYYY-MM"
                />
                <Field
                  label="복무종료"
                  value={profile.militaryServiceEnd}
                  onChange={(v) => patch({ militaryServiceEnd: v })}
                  placeholder="YYYY-MM"
                />
                <Field
                  label="제대구분"
                  value={profile.militaryDischargeType}
                  onChange={(v) => patch({ militaryDischargeType: v })}
                  placeholder="만기제대"
                />
              </>
            ) : null}
          </Grid>
        </div>
      </Section>

      <Section title="학력">
        <ListEditor
          items={profile.education}
          onChange={(v) => patch({ education: v })}
          newItem={emptyEducation}
          addLabel="학력"
          summarize={(e) => (e.schoolName ? `${e.schoolLevel} · ${e.schoolName}` : "")}
          renderItem={(e, update) => (
            <>
              <Select
                label="구분"
                value={e.schoolLevel}
                onChange={(v) => update({ schoolLevel: v as ApplicantEducationEntry["schoolLevel"] })}
                options={["고등학교", "대학교", "대학원"]}
              />
              <Select
                label="졸업구분"
                value={e.status}
                onChange={(v) => update({ status: v })}
                options={["졸업", "졸업예정", "수료", "중퇴", "휴학", "재학", "검정고시"]}
              />
              <Field label="학교명" value={e.schoolName} onChange={(v) => update({ schoolName: v })} />
              <Field
                label="학교소재지"
                value={e.schoolLocation}
                onChange={(v) => update({ schoolLocation: v })}
              />
              {e.schoolLevel !== "고등학교" && (
                <>
                  <Select
                    label="학위구분"
                    value={e.degreeType}
                    onChange={(v) => update({ degreeType: v })}
                    options={["전문학사", "학사", "석사", "박사"]}
                  />
                  <Select
                    label="입학구분"
                    value={e.admissionType}
                    onChange={(v) => update({ admissionType: v })}
                    options={["입학", "편입"]}
                  />
                  <Select
                    label="본교/분교"
                    value={e.campus}
                    onChange={(v) => update({ campus: v })}
                    options={["본교", "분교"]}
                  />
                  <Field
                    label="학과계열"
                    value={e.majorCategory}
                    onChange={(v) => update({ majorCategory: v })}
                  />
                  <Field label="전공" value={e.major} onChange={(v) => update({ major: v })} />
                  <Select
                    label="전공구분"
                    value={e.majorTrack}
                    onChange={(v) => update({ majorTrack: v })}
                    options={["주전공", "복수전공", "부전공"]}
                  />
                  <Field label="학점" value={e.gpa} onChange={(v) => update({ gpa: v })} placeholder="3.98" />
                  <Field
                    label="만점 기준"
                    value={e.gpaMax}
                    onChange={(v) => update({ gpaMax: v })}
                    placeholder="4.5"
                  />
                  <Field
                    label="전공학점(이수)"
                    value={e.majorCredits}
                    onChange={(v) => update({ majorCredits: v })}
                  />
                  <Field
                    label="전공 평점"
                    value={e.majorGpa}
                    onChange={(v) => update({ majorGpa: v })}
                  />
                </>
              )}
              <Select
                label="주간/야간"
                value={e.dayNight}
                onChange={(v) => update({ dayNight: v })}
                options={["주간", "야간"]}
              />
              <Field
                label="재학 시작"
                value={e.startDate}
                onChange={(v) => update({ startDate: v })}
                placeholder="YYYY-MM"
              />
              <Field
                label="재학 종료"
                value={e.endDate}
                onChange={(v) => update({ endDate: v })}
                placeholder="YYYY-MM"
              />
            </>
          )}
        />
      </Section>

      <Section title="연구실적">
        <ListEditor
          items={profile.research}
          onChange={(v) => patch({ research: v })}
          newItem={emptyResearch}
          addLabel="연구실적"
          summarize={(r) => r.title}
          renderItem={(r, update) => (
            <>
              <Select
                label="구분"
                value={r.category}
                onChange={(v) => update({ category: v })}
                options={["국제학술회의", "국내학술회의", "국제학술대회", "국내학술대회", "연구과제", "학술논문게재"]}
              />
              <Field
                label="제목"
                value={r.title}
                onChange={(v) => update({ title: v })}
                className="col-span-2"
              />
              <Field label="주최기관" value={r.organizer} onChange={(v) => update({ organizer: v })} />
              <Field label="일자" value={r.date} onChange={(v) => update({ date: v })} placeholder="YYYY-MM-DD" />
              <Field
                label="저자순위"
                value={r.authorRank}
                onChange={(v) => update({ authorRank: v })}
                placeholder="1/6"
              />
              <Field label="역할" value={r.role} onChange={(v) => update({ role: v })} placeholder="주저자" />
            </>
          )}
        />
      </Section>

      <Section title="어학 / 자격증">
        <div className="space-y-4">
          <div>
            <p className="text-xs font-semibold text-gray-500 mb-2">공인 어학시험</p>
            <ListEditor
              items={profile.languageTests}
              onChange={(v) => patch({ languageTests: v })}
              newItem={emptyLanguageTest}
              addLabel="어학시험"
              summarize={(t) => (t.testName ? `${t.testName} ${t.score}/${t.scoreMax}` : "")}
              renderItem={(t, update) => (
                <>
                  <Field label="시험명" value={t.testName} onChange={(v) => update({ testName: v })} placeholder="TOEIC" />
                  <Field label="시험번호" value={t.testId} onChange={(v) => update({ testId: v })} />
                  <Field label="취득일" value={t.date} onChange={(v) => update({ date: v })} placeholder="YYYY-MM-DD" />
                  <Field label="점수" value={t.score} onChange={(v) => update({ score: v })} />
                  <Field label="만점" value={t.scoreMax} onChange={(v) => update({ scoreMax: v })} />
                </>
              )}
            />
          </div>

          <div>
            <p className="text-xs font-semibold text-gray-500 mb-2">외국어 활용능력</p>
            <ListEditor
              items={profile.foreignLanguageSkills}
              onChange={(v) => patch({ foreignLanguageSkills: v })}
              newItem={emptyForeignLanguageSkill}
              addLabel="외국어"
              summarize={(s) => s.language}
              renderItem={(s, update) => (
                <>
                  <Field label="외국어" value={s.language} onChange={(v) => update({ language: v })} placeholder="영어" />
                  <Field label="읽기" value={s.reading} onChange={(v) => update({ reading: v })} placeholder="Advanced" />
                  <Field label="쓰기" value={s.writing} onChange={(v) => update({ writing: v })} placeholder="Intermediate" />
                  <Field label="말하기" value={s.speaking} onChange={(v) => update({ speaking: v })} placeholder="Intermediate" />
                </>
              )}
            />
          </div>

          <div>
            <p className="text-xs font-semibold text-gray-500 mb-2">자격증 / 면허증</p>
            <ListEditor
              items={profile.certifications}
              onChange={(v) => patch({ certifications: v })}
              newItem={emptyCertification}
              addLabel="자격증"
              summarize={(c) => c.name}
              renderItem={(c, update) => (
                <>
                  <Field label="자격증명" value={c.name} onChange={(v) => update({ name: v })} />
                  <Field label="발급기관" value={c.issuer} onChange={(v) => update({ issuer: v })} />
                  <Field
                    label="등록번호"
                    value={c.registrationNumber}
                    onChange={(v) => update({ registrationNumber: v })}
                  />
                  <Field
                    label="취득일"
                    value={c.issuedDate}
                    onChange={(v) => update({ issuedDate: v })}
                    placeholder="YYYY-MM-DD"
                  />
                </>
              )}
            />
          </div>
        </div>
      </Section>

      <Section title="수상경력 / 대외활동">
        <div className="space-y-4">
          <div>
            <p className="text-xs font-semibold text-gray-500 mb-2">수상경력</p>
            <ListEditor
              items={profile.awards}
              onChange={(v) => patch({ awards: v })}
              newItem={emptyAward}
              addLabel="수상경력"
              summarize={(a) => a.name}
              renderItem={(a, update) => (
                <>
                  <Field label="상훈명" value={a.name} onChange={(v) => update({ name: v })} className="col-span-2" />
                  <Field label="수여기관" value={a.organizer} onChange={(v) => update({ organizer: v })} />
                  <Field label="수상일자" value={a.date} onChange={(v) => update({ date: v })} placeholder="YYYY-MM-DD" />
                  <Field label="수상내역" value={a.detail} onChange={(v) => update({ detail: v })} />
                </>
              )}
            />
          </div>

          <div>
            <p className="text-xs font-semibold text-gray-500 mb-2">학내외 활동</p>
            <ListEditor
              items={profile.activities}
              onChange={(v) => patch({ activities: v })}
              newItem={emptyActivity}
              addLabel="활동"
              summarize={(a) => (a.category ? `${a.category}${a.organization ? " · " + a.organization : ""}` : "")}
              renderItem={(a, update) => (
                <>
                  <Field label="활동구분" value={a.category} onChange={(v) => update({ category: v })} placeholder="팀 프로젝트" />
                  <Field label="기관/조직명" value={a.organization} onChange={(v) => update({ organization: v })} />
                  <Field label="역할" value={a.role} onChange={(v) => update({ role: v })} />
                  <Field label="시작" value={a.startDate} onChange={(v) => update({ startDate: v })} placeholder="YYYY-MM" />
                  <Field label="종료" value={a.endDate} onChange={(v) => update({ endDate: v })} placeholder="YYYY-MM" />
                  <Field
                    label="활동내역"
                    value={a.detail}
                    onChange={(v) => update({ detail: v })}
                    className="col-span-3"
                  />
                </>
              )}
            />
          </div>
        </div>
      </Section>

      <Section title="경력사항">
        <ListEditor
          items={profile.workExperiences}
          onChange={(v) => patch({ workExperiences: v })}
          newItem={emptyWorkExperience}
          addLabel="경력"
          summarize={(w) => w.companyName}
          renderItem={(w, update) => (
            <>
              <Field
                label="고용형태"
                value={w.employmentType}
                onChange={(v) => update({ employmentType: v })}
                placeholder="정규직/계약직/프리랜서"
              />
              <Field label="회사명" value={w.companyName} onChange={(v) => update({ companyName: v })} />
              <Select
                label="재직중 여부"
                value={w.isCurrent ? "재직중" : "퇴사"}
                onChange={(v) => update({ isCurrent: v === "재직중" })}
                options={["재직중", "퇴사"]}
              />
              <Field label="입사일" value={w.startDate} onChange={(v) => update({ startDate: v })} placeholder="YYYY-MM" />
              <Field label="퇴사일" value={w.endDate} onChange={(v) => update({ endDate: v })} placeholder="YYYY-MM" />
              <Field label="부서" value={w.department} onChange={(v) => update({ department: v })} />
              <Field label="직급" value={w.position} onChange={(v) => update({ position: v })} />
              <Field
                label="담당업무"
                value={w.duties}
                onChange={(v) => update({ duties: v })}
                className="col-span-2"
              />
              <Field label="퇴직사유" value={w.resignReason} onChange={(v) => update({ resignReason: v })} />
            </>
          )}
        />
      </Section>

      <Section title="프로젝트">
        <ListEditor
          items={profile.projects}
          onChange={(v) => patch({ projects: v })}
          newItem={emptyProject}
          addLabel="프로젝트"
          summarize={(p) => p.name}
          renderItem={(p, update) => (
            <>
              <Field
                label="프로젝트명"
                value={p.name}
                onChange={(v) => update({ name: v })}
                className="col-span-2"
              />
              <Field label="발주처" value={p.client} onChange={(v) => update({ client: v })} />
              <Field label="근무처" value={p.workplace} onChange={(v) => update({ workplace: v })} />
              <Field label="시작" value={p.startDate} onChange={(v) => update({ startDate: v })} placeholder="YYYY-MM" />
              <Field label="종료" value={p.endDate} onChange={(v) => update({ endDate: v })} placeholder="YYYY-MM" />
              <Field
                label="기여도(%)"
                value={p.contributionPercent}
                onChange={(v) => update({ contributionPercent: v })}
              />
              <Field label="참여역할" value={p.role} onChange={(v) => update({ role: v })} className="col-span-2" />
            </>
          )}
        />
      </Section>

      <Section title="취미 / 특기">
        <Grid>
          <Field label="취미" value={profile.hobbies} onChange={(v) => patch({ hobbies: v })} placeholder="평소 즐기는 활동" />
          <Field label="특기" value={profile.specialties} onChange={(v) => patch({ specialties: v })} placeholder="자신 있는 활동이나 능력" />
        </Grid>
      </Section>

      <Section title="기타">
        <div>
          <label className="text-xs text-gray-400 block mb-1">
            활용 가능한 프로그램/언어/도구 (자유 서술)
          </label>
          <textarea
            value={profile.skillsNote}
            onChange={(e) => patch({ skillsNote: e.target.value })}
            rows={4}
            className="w-full text-sm border border-gray-200 rounded-lg p-2.5 focus:outline-none focus:ring-2 focus:ring-blue-200"
          />
        </div>
        <div className="mt-3">
          <label className="text-xs text-gray-400 block mb-1">
            온라인 자료 링크 (GitHub, 블로그, 포트폴리오 등 — 줄바꿈으로 구분)
          </label>
          <textarea
            value={profile.portfolioLinks}
            onChange={(e) => patch({ portfolioLinks: e.target.value })}
            rows={3}
            className="w-full text-sm border border-gray-200 rounded-lg p-2.5 focus:outline-none focus:ring-2 focus:ring-blue-200"
          />
        </div>
      </Section>

      <button
        onClick={save}
        disabled={saving}
        className="w-full text-sm px-4 py-2.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
      >
        {saving ? "저장 중..." : "저장"}
      </button>
    </div>
  );
}
