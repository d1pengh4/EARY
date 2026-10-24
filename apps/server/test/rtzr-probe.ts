// RTZR 실측: WAV를 실시간 속도(100ms 청크)로 흘려 보내고 interim 간격·final 지연을 잰다.
import { RtzrAuth, RtzrStream } from '../src/rtzr';

const file = process.argv[2]!;
const buf = new Uint8Array(await Bun.file(file).arrayBuffer());
const pcm = buf.subarray(44); // WAV 헤더 44B (afconvert LEI16)
const CHUNK = 3200; // 100ms @16kHz*2B
const auth = new RtzrAuth(process.env.RTZR_CLIENT_ID, process.env.RTZR_CLIENT_SECRET);
const ta = performance.now();
await auth.get();
console.log(`auth ${(performance.now() - ta).toFixed(0)}ms`);
let t0 = 0;
let audioEnd = 0;
let lastInterim = 0;
const gaps: number[] = [];
const done = Promise.withResolvers<void>();
const s = new RtzrStream(auth, {
  onResult(r) {
    const now = performance.now() - t0;
    const text = r.alternatives[0]?.text ?? '';
    if (r.final) console.log(`${now.toFixed(0).padStart(5)}ms FINAL (오디오 끝 +${(now - audioEnd).toFixed(0)}ms) start_at=${r.start_at} dur=${r.duration}: ${text}`);
    else { if (lastInterim) gaps.push(now - lastInterim); lastInterim = now; console.log(`${now.toFixed(0).padStart(5)}ms interim: ${text}`); }
  },
  onClose(code, reason) { console.log('close', code, reason); done.resolve(); },
  onError(e) { console.log('error', e); },
});
await s.start();
t0 = performance.now();
for (let i = 0; i < pcm.length; i += CHUNK) {
  s.push(pcm.subarray(i, i + CHUNK));
  await Bun.sleep(100);
}
audioEnd = performance.now() - t0;
// 실제 통화처럼 말 끝에 무음 1초
for (let i = 0; i < 10; i++) { s.push(new Uint8Array(CHUNK)); await Bun.sleep(100); }
s.end();
await Promise.race([done.promise, Bun.sleep(8000)]);
gaps.sort((a, b) => a - b);
console.log(`audio ${(pcm.length / 32000).toFixed(1)}s, interim n=${gaps.length + 1} gap p50=${gaps[Math.floor(gaps.length / 2)]?.toFixed(0)}ms`);
s.close();
process.exit(0);
