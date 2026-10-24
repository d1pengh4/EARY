// 자유 입력 확인: 대본 밖 문장을 type.inject로 넣고 보드·위험 결과를 본다.
import { applyOps, initialState } from '@eary/core';
import type { CallState, S2C } from '@eary/schema';
const lines: ['other' | 'me', string][] = [
  ['other', '안녕하세요 국민건강보험공단 환급 담당 김민수 주임입니다 미환급금 23만 4천원이 있어서 연락드렸어요'],
  ['me', '아 그래요? 어떻게 받으면 되나요'],
  ['other', '환급 받으시려면 지금 바로 저희가 보내드리는 링크를 눌러서 앱을 설치하셔야 해요'],
  ['other', '설치하시고 나서 계좌 비밀번호도 알려주셔야 처리됩니다'],
];
const ws = new WebSocket('ws://localhost:8787/ws');
ws.onopen = () => ws.send(JSON.stringify({ t: 'hello' }));
let st: CallState = initialState('x');
ws.onmessage = (e) => { const m = JSON.parse(e.data as string) as S2C; if (m.t === 'welcome') st = m.snapshot; if (m.t === 'ops') st = applyOps(st, m.ops); };
await Bun.sleep(300);
ws.send(JSON.stringify({ t: 'call.start', mode: 'type', consentNotified: true }));
for (const [speaker, text] of lines) {
  await Bun.sleep(300);
  ws.send(JSON.stringify({ t: 'type.inject', speaker, text }));
  await Bun.sleep(Number(process.env.GAP ?? 2500));
  console.log(`[${speaker}] risk=${st.risk.level} domain=${st.domain} | ${st.situation.text} | 다음: ${st.suggestions[0]?.text ?? '-'}`);
}
console.log('entities:', Object.values(st.entities).map((e) => `${e.key}(${e.certainty},${e.origin.join('+')})`).join(', '));
await Bun.sleep(Number(process.env.TAIL ?? 0));
for (const b of Object.values(st.boards)) {
  console.log(`\n=== board ${b.title} (${b.size.w}x${b.size.h})`);
  for (const id of b.order) {
    const el = b.els[id]!; const p = b.placed[id];
    const at = p ? `@${p.x},${p.y}` : '';
    if (el.kind === 'section') console.log(`[${el.layout}] ${el.title} ${at}`);
    else if (el.kind === 'item') console.log(`   · ${el.label}: ${el.value} <${el.tone}> ${el.pills.map((x) => '#' + x.text).join(' ')} ${at}`);
    else if (el.kind === 'row') console.log(`   | ${el.cells.join(' | ')} ${at}`);
    else if (el.kind === 'chip') console.log(`   ⌕ ${el.text} (${el.state})`);
    else if (el.kind === 'card') console.log(`   ▢ ${el.label}=${el.value}`);
  }
  for (const e of Object.values(b.edges)) console.log(`   ${e.kind}: ${e.from} → ${e.to} ${e.label ?? ''}`);
}
console.log('signals:', st.risk.activeCategories.join(', '));
process.exit(0);
