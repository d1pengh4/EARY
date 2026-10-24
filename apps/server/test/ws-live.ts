// live 경로 확인: 브라우저처럼 [채널 1B][PCM16] 100ms 프레임을 보낸다. 채널 1(상대) = 인자 WAV
import type { S2C } from '@eary/schema';
const pcm = new Uint8Array(await Bun.file(process.argv[2]!).arrayBuffer()).subarray(44);
const ws = new WebSocket('ws://localhost:8787/ws');
ws.onopen = () => ws.send(JSON.stringify({ t: 'hello' }));
ws.binaryType = 'arraybuffer';
const t0 = performance.now();
let sentEnd = 0;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data as string) as S2C;
  if (m.t === 'welcome') ws.send(JSON.stringify({ t: 'call.start', mode: 'live', consentNotified: true }));
  if (m.t === 'ops') for (const op of m.ops) {
    if (op.op === 'utt.upsert') console.log(`${(performance.now() - t0).toFixed(0)}ms ${op.u.status} [${op.u.speaker}] ${op.u.text}${op.u.status === 'final' && sentEnd ? `  (음성 끝 +${(performance.now() - sentEnd).toFixed(0)}ms)` : ''}`);
    if (op.op === 'risk.set') console.log(`   risk → ${op.risk.level}`);
    if (op.op === 'board.patch' && 'add' in op.patch) console.log(`   board + ${op.patch.add.els.map((x) => x.id).join(', ')}`);
  }
  if (m.t === 'error') console.log('error', m);
};
await Bun.sleep(300);
for (let i = 0; i < pcm.length + 32000; i += 3200) {
  const chunk = i < pcm.length ? pcm.subarray(i, i + 3200) : new Uint8Array(3200);
  const f = new Uint8Array(chunk.length + 1); f[0] = 1; f.set(chunk, 1);
  ws.send(f);
  if (i >= pcm.length && !sentEnd) sentEnd = performance.now();
  await Bun.sleep(100);
}
await Bun.sleep(2500);
process.exit(0);
