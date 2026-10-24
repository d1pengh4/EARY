// AI에게 요청 확인: 사칭 대화 두 줄 + 질문 → 답(시간 측정)
import { applyOps, initialState } from '@eary/core';
import type { CallState, S2C } from '@eary/schema';
const ws = new WebSocket('ws://localhost:8787/ws');
ws.onopen = () => ws.send(JSON.stringify({ t: 'hello' }));
let st: CallState = initialState('x');
let asked = 0;
ws.onmessage = (e) => { const m = JSON.parse(e.data as string) as S2C; if (m.t === 'welcome' && m.snapshot) st = m.snapshot; if (m.t === 'ops') { st = applyOps(st, m.ops); for (const op of m.ops) if (op.op === 'chat.turn' && op.turn.role === 'ai') console.log(`  +${Math.round(performance.now() - asked)}ms [${op.turn.done ? '완료' : '진행'}] ${op.turn.text}`); } };
await Bun.sleep(300);
ws.send(JSON.stringify({ t: 'call.start', mode: 'type', consentNotified: true }));
for (const text of ['서울중앙지검 홍길동 검사입니다 본인 명의 계좌가 범죄에 연루됐습니다', '수사 중이라 외부에 말씀하시면 안 되고 오늘 안에 확인해야 합니다']) { ws.send(JSON.stringify({ t: 'type.inject', speaker: 'other', text })); await Bun.sleep(1500); }
for (const [text, preset] of [['통화를 끊어도 되나요?', undefined], ['더 쉽게 설명', 'simplify']] as const) {
  console.log(`Q: ${text}`); asked = performance.now();
  ws.send(JSON.stringify({ t: 'chat.ask', text, ...(preset ? { preset } : {}) }));
  await Bun.sleep(9000);
}
process.exit(0);
