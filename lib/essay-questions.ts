// 자소서 문항은 공고마다 문구가 다르지만, 실제로는 몇 가지 공통 유형으로 수렴한다.
// 서버(초안 생성 프롬프트)와 클라이언트(지원 도우미 UI) 양쪽이 같은 목록을 써야 하므로
// 여기 하나로 둔다 (lib/application-status.ts와 동일한 패턴).
export const COMMON_ESSAY_QUESTIONS = [
  "지원동기",
  "성장과정",
  "성격의 장단점",
  "입사 후 포부",
  "문제해결 경험",
  "갈등상황 대처 경험",
  "본인 소개",
  "직무 관련 역량/특기사항",
] as const;

export type CommonEssayQuestion = (typeof COMMON_ESSAY_QUESTIONS)[number];

// "지원동기, 성격(장단점), 특기사항, 희망업무, 입사 후 계획 등을 중심으로 자유롭게
// 기술해주시기 바랍니다" 처럼 한 항목에 여러 주제를 섞어 긴 줄글로 쓰게 하는 폼도 흔해서,
// 개별 문항과 별도로 이것도 항상 하나 만들어둔다.
export const COMBINED_ESSAY_LABEL = "통합 자유기술형 (지원동기+장단점+포부 등 한 편의 글)";
