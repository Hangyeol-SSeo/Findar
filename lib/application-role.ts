import { getApplicationRole } from "./db";
export function requireApplicationRole(seq: string) {
  const selection = getApplicationRole(seq);
  if (!selection.role) throw new Error("공고 상단 회사명 옆의 ‘지원 직무’를 눌러 직무를 선택하거나 입력한 뒤 저장해주세요.");
  return selection;
}
export function assertApplicationRole(seq: string, revision: string) {
  if (getApplicationRole(seq).revision !== revision)
    throw new Error("지원 직무가 변경되어 작업을 중단했습니다. 새 직무로 다시 실행해주세요.");
}
export const APPLICATION_ROLE_RULES = "사용자가 저장한 지원 직무를 평가·작성의 기준으로 삼으세요. 여러 모집 직무 중 다른 직무의 업무·자격요건을 섞지 마세요. 공고에 선택 직무의 상세 정보가 없으면 한계를 밝히고 요구 역량을 사실처럼 지어내지 마세요. 문항의 요구를 우선하며 직무 연결이 불필요한 곳에 억지로 삽입하지 마세요. 산업 전체를 묻는 문항의 분석 범위를 지원 직무 하나로 좁히지 마세요.";
