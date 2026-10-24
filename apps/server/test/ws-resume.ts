// 재연결 확인: 대본 재생 중 연결을 끊었다가 같은 세션 id + lastSeq로 다시 붙어 빠진 op만 받는지
import { applyOps, initialState } from '@eary/core';
import type { CallState, S2C } from '@eary/schema';
let st: CallState = initialState('x');
let seq = 0;
let sessionId = '';
const connect = (hello: object) => new Promise<WebSocket>((res) => {
  const ws = new WebSocket('ws://localhost:8787/ws');
  ws.onopen = () => { ws.send(JSON.stringify(hello)); res(ws); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data as string) as S2C;
    if (m.t === 'welcome') { sessionId = m.sessionId; if (m.snapshot) { st = m.snapshot; } seq = m.seq; console.log(`  welcome seq=${m.seq} snapshot=${Boolean(m.snapshot)}`); }
    if (m.t === 'ops') { if (m.from !== seq + 1) console.log(`  !! gap from=${m.from} seq=${seq}`); st = applyOps(st, m.ops); seq += m.ops.length; }
  };
});
const a = await connect({ t: 'hello' });
a.send(JSON.stringify({ t: 'call.start', mode: 'replay-fixture', scenarioId: 'impersonation-01', consentNotified: true, speed: 4 }));
await Bun.sleep(5000);
const before = { seq, utts: st.utteranceOrder.length };
a.close();
console.log(`끊음: seq=${before.seq}, 발언 ${before.utts}개`);
await Bun.sleep(4000); // 끊긴 동안에도 서버에서 대본은 계속 진행
const b = await connect({ t: 'hello', sessionId, lastSeq: seq });
await Bun.sleep(8000);
console.log(`다시 붙음: seq=${seq}, 발언 ${st.utteranceOrder.length}개, 위험=${st.risk.level}, 보드 요소=${Object.values(st.boards).reduce((n, x) => n + x.order.length, 0)}`);
// 새로고침 흉내: 상태 없이 세션 id만 → 스냅샷
st = initialState('x'); seq = 0;
const c = await connect({ t: 'hello', sessionId });
await Bun.sleep(500);
console.log(`새로고침: 발언 ${st.utteranceOrder.length}개, 위험=${st.risk.level}`);
b.close(); c.close();
process.exit(0);
