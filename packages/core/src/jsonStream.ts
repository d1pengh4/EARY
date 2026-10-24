// L1 스트리밍 응답에서 배열 원소가 닫히는 순간 꺼내는 부분 JSON 파서. (§7.5 흘려 받기, §8.10-4)
// 지원 범위: 최상위 객체의 배열 필드(예: "entities": [ {...}, {...} ]) 안의 객체 원소.

export class JsonArrayStreamer {
  private buf = '';
  private pos = 0;
  private emitted: Record<string, number> = {};

  constructor(private readonly onItem: (field: string, item: unknown) => void) {}

  push(chunk: string) {
    this.buf += chunk;
    this.scan();
  }

  private scan() {
    // 각 배열 필드의 시작 위치를 찾고, 그 안에서 완결된 {…}를 순서대로 꺼낸다.
    const re = /"([a-zA-Z_]+)"\s*:\s*\[/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.buf))) {
      const field = m[1]!;
      let i = m.index + m[0].length;
      let count = 0;
      while (i < this.buf.length) {
        while (i < this.buf.length && /[\s,]/.test(this.buf[i]!)) i++;
        if (this.buf[i] !== '{') break;
        const end = matchBrace(this.buf, i);
        if (end < 0) break;
        count++;
        if (count > (this.emitted[field] ?? 0)) {
          this.emitted[field] = count;
          try { this.onItem(field, JSON.parse(this.buf.slice(i, end + 1))); } catch { /* 잘못된 원소는 버린다 */ }
        }
        i = end + 1;
      }
    }
    this.pos = this.buf.length;
  }
}

function matchBrace(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
