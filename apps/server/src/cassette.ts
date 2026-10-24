// 카세트: 외부 호출(Jev·검색·에이전트·L1) 응답을 녹화했다가 네트워크 없이 같은 시간으로 재생한다. (§14 replay-fixture, BACKLOG #10)
// EARY_CASSETTE=record:<이름> | replay:<이름>  →  packages/scenario/cassettes/<이름>.json
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

interface Entry { kind: string; key: string; ms: number; res: unknown; used?: boolean }

export class Cassette {
  private entries: Entry[] = [];
  constructor(readonly mode: 'record' | 'replay', private readonly path: string) {
    if (mode === 'replay') {
      if (!existsSync(path)) throw new Error(`카세트 없음: ${path}`);
      this.entries = JSON.parse(readFileSync(path, 'utf8')) as Entry[];
    }
  }

  static fromEnv(v: string | undefined, dir: string): Cassette | null {
    const m = v?.match(/^(record|replay):([\w-]+)$/);
    return m ? new Cassette(m[1] as 'record' | 'replay', `${dir}/${m[2]}.json`) : null;
  }

  get size() {
    return this.entries.length;
  }

  /** 녹화: 실제로 부르고 저장 / 재생: 같은 종류·키의 다음 응답 (없으면 같은 종류의 다음 것) */
  wrap<A extends unknown[], R>(kind: string, keyOf: (...a: A) => string, fn: (...a: A) => Promise<R>): (...a: A) => Promise<R> {
    return async (...a: A) => {
      const key = keyOf(...a);
      if (this.mode === 'record') {
        const t0 = performance.now();
        const res = await fn(...a);
        this.entries.push({ kind, key, ms: Math.round(performance.now() - t0), res });
        this.save();
        return res;
      }
      const e = this.entries.find((x) => !x.used && x.kind === kind && x.key === key) ?? this.entries.find((x) => !x.used && x.kind === kind);
      if (!e) return null as R;
      e.used = true;
      // 검색은 실제 서비스처럼 1.2초 안에 먼저 보여 준다 (녹화는 늦은 공급사까지 끝까지 기다려 담았다)
      await Bun.sleep(kind === 'search' ? Math.min(e.ms, 1200) : e.ms);
      return e.res as R;
    };
  }

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private save() {
    this.saveTimer ??= setTimeout(() => { this.saveTimer = null; writeFileSync(this.path, JSON.stringify(this.entries.map(({ used: _u, ...x }) => x), null, 0)); }, 300);
  }
}
