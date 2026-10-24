// FixtureSttAdapter: 대본을 실제 STT처럼 interim → final로 흘려 보낸다. (§7.3, §14 replay-fixture)
import type { Scenario, Speaker } from '@eary/schema';

export interface SttEvents {
  interim(id: string, speaker: Speaker, text: string, startMs: number): void;
  final(id: string, speaker: Speaker, text: string, startMs: number, endMs: number): void;
  done(): void;
}

/** 한국어 발화 속도 ≈ 7음절/초 → 글자당 140ms, interim은 300ms마다 */
const MS_PER_CHAR = 140;
const INTERIM_EVERY = 300;
const FINAL_LAG = 150;

export function playScenario(sc: Scenario, ev: SttEvents, speed = 1): () => void {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const at = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms / speed));
  const all = sc.steps.flatMap((s) => s.utterances);
  let lastEnd = 0;
  all.forEach((u, i) => {
    const id = `u${i + 1}`;
    const dur = u.durMs ?? u.text.length * MS_PER_CHAR;
    for (let t = INTERIM_EVERY; t < dur; t += INTERIM_EVERY) {
      const n = Math.max(1, Math.floor((t / dur) * u.text.length));
      const partial = u.text.slice(0, n);
      at(u.atMs + t, () => ev.interim(id, u.speaker, partial, u.atMs / speed));
    }
    // 발언 시각도 재생 속도에 맞춘다 (배속 재생에서 통화 시간과 발언 시각이 어긋나지 않게)
    at(u.atMs + dur + FINAL_LAG, () => ev.final(id, u.speaker, u.text, u.atMs / speed, (u.atMs + dur) / speed));
    lastEnd = Math.max(lastEnd, u.atMs + dur + FINAL_LAG);
  });
  at(lastEnd + 1500, () => ev.done());
  return () => timers.forEach(clearTimeout);
}
