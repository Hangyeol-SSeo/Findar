// 자기소개서 두 버전을 문장 단위로 비교한다. 첨삭 비교 화면(클라이언트)과
// 사용자 수정 성향 기록(서버)이 같이 쓰므로 의존성 없는 순수 함수로 둔다.

export interface DiffPart { type: "same" | "removed" | "added"; text: string }

// 문장 끝(. ! ? 등) 뒤의 공백이나 줄바꿈에서 나눈다. 구분 공백은 앞 문장에 붙여 원문을 그대로 복원할 수 있게 한다.
export function splitSentences(text: string): string[] {
  return text.match(/[^.!?。！？\n]*(?:[.!?。！？]+|\n|$)\s*/g)?.filter(Boolean) ?? [];
}

export function diffSentences(before: string, after: string): DiffPart[] {
  const a = splitSentences(before);
  const b = splitSentences(after);
  // 자기소개서 한 편은 문장이 수십 개라 O(n·m) LCS로 충분하다.
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i][j] = a[i].trim() === b[j].trim() ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const parts: DiffPart[] = [];
  const push = (type: DiffPart["type"], text: string) => {
    const last = parts.at(-1);
    if (last?.type === type) last.text += text;
    else parts.push({ type, text });
  };
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i].trim() === b[j].trim()) { push("same", b[j]); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) push("removed", a[i++]);
    else push("added", b[j++]);
  }
  while (i < a.length) push("removed", a[i++]);
  while (j < b.length) push("added", b[j++]);
  return parts;
}

// 지워진 문장 바로 뒤에 추가된 문장이 오면 "이 표현을 이렇게 고쳤다"는 한 쌍으로 본다.
export function changedPairs(before: string, after: string): { before: string; after: string }[] {
  const parts = diffSentences(before, after);
  const pairs: { before: string; after: string }[] = [];
  for (let k = 0; k < parts.length - 1; k++)
    if (parts[k].type === "removed" && parts[k + 1].type === "added")
      pairs.push({ before: parts[k].text.trim(), after: parts[k + 1].text.trim() });
  return pairs;
}
