// WS 종단 확인: 실제 서버(:8787)에 붙어 대본을 재생하고, 클라이언트 리듀서로 상태를 재구성한다.
import { applyOps, initialState } from '@eary/core';
import type { CallState, S2C } from '@eary/schema';

const speed = Number(process.argv[3] ?? 4);
const mode = process.argv[4] ?? 'replay-fixture';
const ws = new WebSocket('ws://localhost:8787/ws');
ws.onopen = () => ws.send(JSON.stringify({ t: 'hello' }));
let st: CallState = initialState('x');
let seq = 0;
const t0 = Date.now();
let lastLevel = 'none';
const spans: Record<string, number[]> = {};
ws.onmessage = (e) => {
  const m = JSON.parse(e.data as string) as S2C;
  if (m.t === 'welcome') { st = m.snapshot; seq = m.seq; ws.send(JSON.stringify({ t: 'call.start', mode, scenarioId: process.argv[2] ?? 'impersonation-01', consentNotified: true, speed })); }
  if (m.t === 'ops') {
    if (m.from !== seq + 1) console.log('!! seq gap', m.from, seq);
    seq += m.ops.length;
    st = applyOps(st, m.ops);
    for (const op of m.ops) if (op.op === 'utt.upsert' && op.u.status === 'final' && mode !== 'replay-fixture') console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  [${op.u.speaker}] ${op.u.text}`);
    if (st.risk.level !== lastLevel) { console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  risk → ${st.risk.level}  | ${st.situation.text}`); lastLevel = st.risk.level; }
  }
  if (m.t === 'metrics') for (const s of m.spans) (spans[s.name] ??= []).push(s.ms);
};
await new Promise((r) => setTimeout(r, (mode === 'replay-audio' ? 60_000 : 62_000) / speed + 4000));
const b = st.boards[st.activeBoardId!]!;
console.log('board:', b.title, 'els', b.order.length, 'edges', Object.keys(b.edges).length, '| utterances', st.utteranceOrder.length, '| provisional left', Object.values(st.entities).filter((e) => e.certainty === 'provisional').length);
for (const id of b.order) { const el = b.els[id]!; console.log('  ', el.kind, id, el.kind === 'card' ? `${el.style} ${el.value} [${el.pills.map((p) => p.text)}]` : ''); }
const p = (xs: number[], q: number) => [...xs].sort((a, c) => a - c)[Math.min(xs.length - 1, Math.floor(q * xs.length))]!.toFixed(1);
for (const [k, xs] of Object.entries(spans)) console.log(`${k}: n=${xs.length} p50=${p(xs, 0.5)}ms p95=${p(xs, 0.95)}ms`);
process.exit(0);
