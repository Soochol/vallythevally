// 검색 결과의 맞은 글자 표시. 서버와 같은 정규화를 강조 표시에만 쓴다(frontend.md §3.1, D5).
// 순위와 걸러 내기는 서버가 한다. 여기서는 다시 정렬하지 않는다.

export interface Segment {
  text: string;
  match: boolean;
}

/** 앞뒤 공백을 자르고, 안쪽 공백을 지우고, 영문은 대문자로. */
export function normalizeQuery(q: string): string {
  return q.trim().replace(/\s+/g, "").toUpperCase();
}

const CHOSEONG = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const isSyllable = (c: string) => c >= "가" && c <= "힣";
const choseongOf = (c: string) => CHOSEONG[Math.floor((c.charCodeAt(0) - 0xac00) / 588)] ?? c;

/** 입력이 모두 한글 자음이면 초성 검색이다. */
export function isChoseongQuery(q: string): boolean {
  return q !== "" && [...q].every((c) => CHOSEONG.includes(c));
}

/**
 * text 안에서 정규화한 query가 처음 맞는 자리를 표시한다. 초성 입력이면 음절의 초성끼리 비교해
 * 그 음절들을 표시한다. 공백은 건너뛰고 비교하되, 맞은 구간 안의 공백은 함께 표시한다.
 */
export function highlight(text: string, query: string): Segment[] {
  const chars = [...text];
  if (query === "") return [{ text, match: false }];
  const cho = isChoseongQuery(query);
  const keys: { at: number; key: string }[] = [];
  chars.forEach((c, at) => {
    if (/\s/.test(c)) return;
    keys.push({ at, key: cho && isSyllable(c) ? choseongOf(c) : c.toUpperCase() });
  });
  const hit = keys.map((k) => k.key).join("").indexOf(query);
  if (hit < 0) return [{ text, match: false }];
  const from = keys[hit]!.at;
  const to = keys[hit + [...query].length - 1]!.at + 1;
  return [
    { text: chars.slice(0, from).join(""), match: false },
    { text: chars.slice(from, to).join(""), match: true },
    { text: chars.slice(to).join(""), match: false },
  ].filter((s) => s.text !== "");
}
