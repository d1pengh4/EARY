// 한국어 매칭용 정규화. 띄어쓰기를 지운 문자열에서 매칭하고, 위치는 원문 인덱스로 되돌린다. (§8.10 정확도 3)

export interface Compact {
  s: string;
  /** compact 인덱스 → 원문 인덱스 */
  map: number[];
}

export function compact(text: string): Compact {
  let s = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) continue;
    s += ch;
    map.push(i);
  }
  return { s, map };
}

/** compact 구간 [start, end) → 원문 구간 */
export function toOriginal(c: Compact, start: number, end: number): { start: number; end: number } {
  const s = c.map[start] ?? 0;
  const last = c.map[end - 1] ?? s;
  return { start: s, end: last + 1 };
}

export function squash(text: string): string {
  return text.replace(/\s+/g, '');
}

/** "12만 원 정도" → 120000, "118,000원" → 118000 */
export function parseWon(num: string, man?: string): number {
  const n = Number(num.replace(/,/g, ''));
  return man ? n * 10_000 : n;
}

/** "23만4천" → 234000, "12만" → 120000, "118,000" → 118000, "1만2,500" → 12500 */
export function parseKoreanWon(s: string): number {
  let total = 0;
  let matched = false;
  for (const [, num, unit] of s.matchAll(/(\d+(?:,\d{3})*)(만|천)?/g)) {
    matched = true;
    const n = Number(num!.replace(/,/g, ''));
    total += unit === '만' ? n * 10_000 : unit === '천' ? n * 1_000 : n;
  }
  return matched ? total : NaN;
}

export function entityKey(type: string, value: string): string {
  return `${type}:${squash(value)}`;
}

/** 결정론적 해시 (손글씨 메모 회전각 등, §8.5-7) */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 받침 유무로 조사 선택: 국민건강보험공단을 / 홍길동 검사를 / KT를 */
export function withParticle(word: string, withBatchim: string, without: string): string {
  const ch = word.charCodeAt(word.length - 1);
  if (ch < 0xac00 || ch > 0xd7a3) return `${word}${without}`;
  return `${word}${(ch - 0xac00) % 28 ? withBatchim : without}`;
}
