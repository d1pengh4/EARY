// 마이크 하나(스피커폰) 모드 종단 확인: 목소리 등록 → 나(원본)·상대(전화 흉내)를 번갈아 한 채널로 → 화자 판단
import { join } from 'node:path';
import { simulatePhone } from '@eary/core';
import type { S2C } from '@eary/schema';
const dir = join(import.meta.dir, '../../../packages/core/test/fixtures');
const load = async (n: string) => new Int16Array((await Bun.file(join(dir, `${n}.wav`)).arrayBuffer()).slice(44));
const hd = process.argv[2] === 'hd';
const seq: [string, 'me' | 'other'][] = [['o1', 'other'], ['me1', 'me'], ['o2', 'other'], ['me2', 'me'], ['o3', 'other']];
const gap = new Int16Array(16000 * 1.2);
const parts: Int16Array[] = [];
for (const [n, who] of seq) { const p = await load(n); parts.push(who === 'other' ? simulatePhone(p, hd ? 7000 : 3400, hd ? 250 : 300) : p, gap); }
const mono = new Int16Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { mono.set(p, o); o += p.length; }
const enroll = await load('enroll');
const ws = new WebSocket('ws://localhost:8787/ws');
ws.binaryType = 'arraybuffer';
const got: string[] = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data as string) as S2C;
  if (m.t === 'voice') console.log('voice:', m.enrolled, m.note);
  if (m.t === 'ops') for (const op of m.ops) if (op.op === 'utt.upsert' && op.u.status !== 'interim' && !got.includes(op.u.id + op.u.rev)) { got.push(op.u.id + op.u.rev); console.log(`  ${op.u.id} rev${op.u.rev} [${op.u.speaker === 'me' ? '나' : '상대'}·${op.u.speakerSource}] ${op.u.text}`); }
};
const frames = (pcm: Int16Array, ch: number) => { const b = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength); const out: Uint8Array[] = []; for (let i = 0; i < b.length; i += 3200) { const f = new Uint8Array(Math.min(3200, b.length - i) + 1); f[0] = ch; f.set(b.subarray(i, i + 3200), 1); out.push(f); } return out; };
ws.onopen = async () => {
  ws.send(JSON.stringify({ t: 'hello' }));
  await Bun.sleep(200);
  ws.send(JSON.stringify({ t: 'voice.enroll', action: 'start' }));
  for (const f of frames(enroll, 2)) ws.send(f);
  ws.send(JSON.stringify({ t: 'voice.enroll', action: 'done' }));
  await Bun.sleep(300);
  ws.send(JSON.stringify({ t: 'call.start', mode: 'live', audio: 'mono', consentNotified: true }));
  await Bun.sleep(300);
  for (const f of frames(mono, 0)) { ws.send(f); await Bun.sleep(100); }
  await Bun.sleep(3000);
  console.log('기대:', seq.map(([, w]) => (w === 'me' ? '나' : '상대')).join(' '));
  process.exit(0);
};
