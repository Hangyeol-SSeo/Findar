import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// 실제 채용 지원폼(예: NCS 기반 공공기관 폼)에서 반복적으로 요구하는 인적사항을 사용자가
// 직접 입력해두는 저장소. lib/profile.ts의 Profile은 이력서 PDF에서 AI가 "추론"한 값이라
// 이메일/생년월일/학교명처럼 이력서에 안 적혀 있거나 애매한 필드는 다루지 못한다 — 이
// 모듈은 그 반대로 100% 사용자가 직접 적어 넣는, AI 추론이 전혀 없는 정확한 데이터다.
// Claude in Chrome 등으로 실제 지원폼을 채울 때 이 데이터를 그대로 참고하면 된다.
const DATA_DIR = join(process.cwd(), "data");
const APPLICANT_PROFILE_PATH = join(DATA_DIR, "applicant-profile.json");

mkdirSync(DATA_DIR, { recursive: true });

export interface ApplicantEducationEntry {
  schoolLevel: "고등학교" | "대학교" | "대학원";
  status: string; // 졸업/졸업예정/수료/중퇴/휴학/재학/검정고시/작성안함
  schoolName: string;
  schoolLocation: string; // 학교소재지 (예: 서울)
  degreeType: string; // 대학교 이상: 전문학사/학사/석사/박사
  admissionType: string; // 입학/편입
  campus: string; // 본교/분교
  dayNight: string; // 주간/야간
  majorCategory: string; // 학과계열
  major: string;
  majorTrack: string; // 주전공/복수전공/부전공
  startDate: string; // YYYY-MM
  endDate: string;
  gpa: string; // "3.98"
  gpaMax: string; // "4.5"
  majorCredits: string;
  majorGpa: string;
}

export interface ApplicantResearchEntry {
  category: string; // 국제학술회의/국내학술회의/국제학술대회/국내학술대회/연구과제 등
  title: string;
  organizer: string;
  date: string;
  authorRank: string; // "1/6"
  role: string; // 주저자 등
}

export interface ApplicantLanguageTest {
  testName: string; // TOEIC 등
  testId: string;
  date: string;
  score: string;
  scoreMax: string;
}

export interface ApplicantForeignLanguageSkill {
  language: string;
  reading: string;
  writing: string;
  speaking: string;
}

export interface ApplicantCertification {
  name: string;
  issuer: string;
  registrationNumber: string;
  issuedDate: string;
}

export interface ApplicantAward {
  name: string;
  organizer: string;
  date: string;
  detail: string;
}

export interface ApplicantActivity {
  category: string; // 팀 프로젝트/연구회/동아리 등
  organization: string;
  startDate: string;
  endDate: string;
  role: string;
  detail: string;
}

export interface ApplicantWorkExperience {
  employmentType: string; // 정규직/계약직/프리랜서 등
  companyName: string;
  isCurrent: boolean;
  startDate: string;
  endDate: string;
  department: string;
  position: string;
  duties: string;
  resignReason: string;
}

export interface ApplicantProjectEntry {
  name: string;
  client: string; // 발주처
  workplace: string; // 근무처
  startDate: string;
  endDate: string;
  contributionPercent: string;
  role: string;
}

export interface ApplicantProfile {
  name: string;
  nameEn: string;
  nameHanja: string;
  religion: string;
  hobbies: string;
  specialties: string;
  gender: string; // 남/여
  birthDate: string; // YYYY-MM-DD
  photoDataUrl: string; // data:image/...;base64,... — 빈 문자열이면 미등록
  nationality: string;
  postalCode: string;
  address: string;
  addressDetail: string;
  email: string;
  phone: string;
  disabilityStatus: string; // 비대상/대상
  disabilityDetail: string;
  veteranStatus: string; // 비대상/대상
  veteranDetail: string;
  militaryStatus: string; // 비대상/군필/미필/면제/복무중
  militaryBranch: string; // 군별
  militarySpecialty: string; // 병과
  militaryRank: string; // 계급
  militaryServiceStart: string;
  militaryServiceEnd: string;
  militaryDischargeType: string; // 제대구분
  education: ApplicantEducationEntry[];
  research: ApplicantResearchEntry[];
  languageTests: ApplicantLanguageTest[];
  foreignLanguageSkills: ApplicantForeignLanguageSkill[];
  certifications: ApplicantCertification[];
  awards: ApplicantAward[];
  activities: ApplicantActivity[];
  workExperiences: ApplicantWorkExperience[];
  projects: ApplicantProjectEntry[];
  skillsNote: string; // 활용 가능한 프로그램/언어 등 자유 서술
  portfolioLinks: string; // GitHub 등 링크, 줄바꿈 구분
  updatedAt: number;
}

export function emptyApplicantProfile(): ApplicantProfile {
  return {
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
}

export function readApplicantProfile(): ApplicantProfile {
  if (!existsSync(APPLICANT_PROFILE_PATH)) return emptyApplicantProfile();
  try {
    const parsed = JSON.parse(readFileSync(APPLICANT_PROFILE_PATH, "utf-8"));
    // 필드가 추가될 때 예전 저장 파일에 없던 키가 undefined가 되지 않도록 빈 값 위에 덮어쓴다.
    return { ...emptyApplicantProfile(), ...parsed };
  } catch {
    return emptyApplicantProfile();
  }
}

export function writeApplicantProfile(profile: Omit<ApplicantProfile, "updatedAt">): void {
  const full: ApplicantProfile = { ...profile, updatedAt: Date.now() };
  writeFileSync(APPLICANT_PROFILE_PATH, JSON.stringify(full, null, 2));
}

// 지원 정보가 하나라도 채워졌는지 — 비어있으면 초안 생성 프롬프트에 통째로 끼워넣지 않기 위함.
export function isApplicantProfileFilled(profile: ApplicantProfile): boolean {
  return profile.updatedAt > 0;
}
