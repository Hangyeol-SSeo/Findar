// 자소서 문항과 달리 이건 공고와 무관하게 한 번만 물어보면 되는 질문들이다. 서버(초안
// 생성 프롬프트가 참고하는 요약)와 클라이언트(설정 페이지 질문 카드) 양쪽이 같은 목록을
// 써야 해서 lib/essay-questions.ts와 동일한 패턴으로 분리해둔다.
export interface NarrativeSeedQuestion {
  id: string; // 안정적 key. NarrativeEpisode.promptId가 이걸 참조 — 질문 문구를 나중에
  // 다듬어도 과거에 저장된 답변의 연결이 깨지지 않는다.
  prompt: string;
  helperText: string; // 스킬/스펙 얘기로 새지 않고 진짜 동기를 쓰게 유도하는 짧은 문구. 없으면 ""
  suggestedTags: string[]; // SUGGESTED_NARRATIVE_TAGS 중 기본값 — 사용자가 폼에서 수정 가능
}

export const NARRATIVE_SEED_QUESTIONS: NarrativeSeedQuestion[] = [
  {
    id: "pivotal-choice",
    prompt:
      "지금까지의 선택 중, 남들 눈엔 최선이 아니었을 수도 있지만 본인에게는 확실한 이유가 있었던 선택(전공·진로·이직 등)이 있다면?",
    helperText:
      "그때 상황과 실제로 그렇게 판단한 진짜 이유를 적어주세요. 이력서/자소서용으로 다듬은 이유 말고, 그 순간 스스로 따졌던 기준으로요.",
    suggestedTags: ["의사결정 기준", "직업관/일에 대한 태도"],
  },
  {
    id: "non-negotiable-principle",
    prompt: "일할 때 절대 타협하지 않는 원칙이나 기준이 있다면 무엇이고, 왜 본인에게 중요한가요?",
    helperText: "",
    suggestedTags: ["윤리/원칙", "의사결정 기준"],
  },
  {
    id: "failure-and-recovery",
    prompt: "가장 크게 흔들렸거나 실패했던 경험은 무엇이었고, 그 뒤로 자신에 대해 새롭게 알게 된 건 무엇인가요?",
    helperText: "",
    suggestedTags: ["실패와 회복", "학습/성장 방식"],
  },
  {
    id: "domain-interest-origin",
    prompt: "지금 관심 있는 산업/직무에 실제로 흥미나 의미를 느낀 계기는 무엇인가요?",
    helperText: "스펙이나 취업 목적 말고, 실제로 관심이 생긴 사건이나 생각을 적어주세요.",
    suggestedTags: ["산업/도메인에 대한 관심", "직업관/일에 대한 태도"],
  },
  {
    id: "collaboration-conflict",
    prompt: "함께 일한 사람들 중 가장 기억에 남는 협업 또는 갈등 경험은? 그때 본인은 어떤 역할을 했고 무엇을 배웠나요?",
    helperText: "",
    suggestedTags: ["사람과의 협업/리더십"],
  },
  {
    id: "risk-attitude",
    prompt: "불확실성이나 실패 가능성을 마주했을 때 본인은 보통 어떻게 반응하나요? 그 성향은 어디서 왔다고 생각하나요?",
    helperText: "",
    suggestedTags: ["리스크에 대한 태도"],
  },
  {
    id: "numbers-and-facts",
    prompt: "숫자, 데이터, 사실관계를 다룰 때 본인만의 습관이나 태도가 있다면 무엇인가요?",
    helperText: "",
    suggestedTags: ["숫자/데이터를 대하는 태도", "의사결정 기준"],
  },
  {
    id: "future-direction-why",
    prompt: "5~10년 후 어떤 사람/전문가가 되어 있고 싶은가요? 그 방향을 원하는 진짜 이유는요?",
    helperText: "직무 타이틀이 아니라, 그 방향을 원하는 이유를 적어주세요.",
    suggestedTags: ["직업관/일에 대한 태도", "학습/성장 방식"],
  },
];

// CATEGORY_RULES처럼 고정 화이트리스트가 아니라 추천 목록 — 사용자가 폼에서 자유 태그를
// 추가 입력해도 된다.
export const SUGGESTED_NARRATIVE_TAGS = [
  "문제해결",
  "리스크에 대한 태도",
  "사람과의 협업/리더십",
  "실패와 회복",
  "학습/성장 방식",
  "의사결정 기준",
  "직업관/일에 대한 태도",
  "산업/도메인에 대한 관심",
  "숫자/데이터를 대하는 태도",
  "윤리/원칙",
] as const;
