// 사용자가 직접 쓰는 메모(AI 없음). 공고 메모는 seq, 회사 메모는 normalizeCompanyName() 결과가 키다 —
// 회사 메모는 같은 회사의 모든 공고에 함께 보인다. 서버(lib/db.ts)와 클라이언트가 함께 쓴다.
export type MemoScope = "job" | "company";

export const MEMO_SCOPES: readonly MemoScope[] = ["job", "company"];

export const MEMO_MAX_CHARS = 20_000;

export interface Memo {
  text: string;
  updatedAt: number;
}

export interface CompanyMemo extends Memo {
  displayName: string;
}

export interface MemoIndex {
  job: Record<string, Memo>;
  company: Record<string, CompanyMemo>;
}

export function isMemoScope(value: unknown): value is MemoScope {
  return value === "job" || value === "company";
}
