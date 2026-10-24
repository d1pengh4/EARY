// 발표 시연 점검: 시나리오를 실제 STT(replay-audio)로 재생하며 자막·단계·도식이 대본대로 나오는지 본다.
// 사용: 서버를 켠 뒤 bun apps/server/test/ws-demo.ts [prosecutor-02]
import { applyOps, initialState } from '@eary/core';
import type { CallState, S2C } from '@eary/schema';
const id = process.argv[2] ?? 'prosecutor-02';
const ws = new WebSocket('ws://localhost:8787/ws');
let st: CallState = initialState('x');
const t0 = performance.now();
let lastLevel = 'none';
const seenFinal = new Set<string>();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data as string) as S2C;
  if (m.t === 'welcome') st = m.snapshot;
  if (m.t !== 'ops') return;
  st = applyOps(st, m.ops);
  for (const uid of st.utteranceOrder) {
    const u = st.utterances[uid]!;
    if (u.status === 'final' && !seenFinal.has(uid)) { seenFinal.add(uid); console.log(`${((performance.now() - t0) / 1000).toFixed(1)}s [${u.speaker === 'me' ? '나' : '상대'}] ${u.text}`); }
  }
  if (st.risk.level !== lastLevel) { lastLevel = st.risk.level; console.log(`   ▶ 단계 ${st.risk.level} [${st.risk.activeCategories.join(',')}]`); }
};
await new Promise((r) => (ws.onopen = r));
ws.send(JSON.stringify({ t: 'hello' }));
await Bun.sleep(300);
ws.send(JSON.stringify({ t: 'call.start', mode: (process.env.MODE ?? 'replay-audio'), scenarioId: id, consentNotified: true }));
await Bun.sleep(Number(process.env.WAIT ?? 115000));
console.log('\n정보:', Object.values(st.entities).filter((e) => e.certainty !== 'provisional').map((e) => `${e.type}:${e.value}`).join(', '));
console.log('도식:', st.figureOrder.map((f) => st.figures[f]!.kind + (f.startsWith('ag:') ? '*' : '')).join(', '));
console.log('지도:', Object.keys(st.boards['board:impersonation.entityMap']?.els ?? {}).join(', '));
console.log('상황:', st.situation.text, '| 다음:', st.suggestions[0]?.text);
process.exit(0);
