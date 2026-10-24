// 대본 재생 → 통화 종료 → 리뷰 확인: bun apps/server/test/ws-review.ts impersonation-01 4
import { applyOps, initialState, reportMarkdown } from '@eary/core';
import type { CallState, S2C } from '@eary/schema';
const id = process.argv[2] ?? 'impersonation-01';
const speed = Number(process.argv[3] ?? 4);
const ws = new WebSocket('ws://localhost:8787/ws');
ws.onopen = () => ws.send(JSON.stringify({ t: 'hello' }));
let st: CallState = initialState('x');
const summaries: string[] = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data as string) as S2C;
  if (m.t === 'welcome') { st = m.snapshot; ws.send(JSON.stringify({ t: 'call.start', mode: 'replay-fixture', scenarioId: id, consentNotified: true, speed })); }
  if (m.t === 'ops') { st = applyOps(st, m.ops); for (const op of m.ops) if (op.op === 'review.set') summaries.push(`[${op.review.summary.by}] ${op.review.summary.text}`); }
};
await Bun.sleep(62_000 / speed + 2500);
ws.send(JSON.stringify({ t: 'call.end' }));
await Bun.sleep(9000);
const r = st.review!;
console.log('제목:', r.title, '| 길이', Math.round(r.durationMs / 1000), 's');
console.log('요약 변화:\n  ' + summaries.join('\n  '));
console.log('핵심 순간:'); for (const x of r.moments) console.log(`  ${x.atMs}ms ${x.title} — ${x.detail} ${x.level ?? ''}`);
console.log('미확인:', r.open.map((o) => o.title).join(' / '));
console.log('일정:', r.calendar?.title, r.calendar?.startIso);
if (r.report) console.log('\n' + reportMarkdown(r.report, '미선택'));
process.exit(0);
