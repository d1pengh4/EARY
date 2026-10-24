// 시연 오디오 생성: 대본 발화를 macOS TTS로 읽어 채널별(나/상대) 16kHz PCM 타임라인을 만든다.
// bun packages/scenario/make-audio.ts impersonation-01
// 출력: audio/<id>.me.pcm, audio/<id>.other.pcm (서버가 RTZR로 흘림), audio/<id>.wav (브라우저 재생용 스테레오 L=나 R=상대), audio/<id>.timeline.json
import { $ } from 'bun';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCENARIOS } from './index';

const RATE = 16000;
// 이 기기에서 실제로 소리가 나는 한국어 음성은 Yuna뿐 (다른 음성은 다운로드 필요) → 말 속도로 구분
const VOICE = { other: 'Yuna', me: 'Yuna' } as const;
const RATE_WPM = { other: 190, me: 165 } as const;
const GAP_MS = 450; // 앞 발화가 끝난 뒤 최소 쉬는 시간

const id = process.argv[2] ?? 'impersonation-01';
const sc = SCENARIOS[id];
if (!sc) throw new Error(`no scenario ${id}`);
const tmp = mkdtempSync(join(tmpdir(), 'eary-tts-'));

const clips: { speaker: 'me' | 'other'; atMs: number; pcm: Int16Array; text: string }[] = [];
let cursor = 0;
let n = 0;
for (const u of sc.steps.flatMap((s) => s.utterances)) {
  const aiff = join(tmp, `${n}.aiff`);
  const wav = join(tmp, `${n++}.wav`);
  await $`say -v ${VOICE[u.speaker]} -r ${RATE_WPM[u.speaker]} -o ${aiff} ${u.text}`.quiet();
  await $`afconvert -f WAVE -d LEI16@${RATE} -c 1 ${aiff} ${wav}`.quiet();
  const bytes = new Uint8Array(await Bun.file(wav).arrayBuffer());
  const pcm = new Int16Array(bytes.buffer.slice(44));
  const atMs = Math.max(u.atMs, cursor + GAP_MS);
  clips.push({ speaker: u.speaker, atMs, pcm, text: u.text });
  cursor = atMs + (pcm.length / RATE) * 1000;
}
const total = Math.ceil(((cursor + 1500) / 1000) * RATE);
const track = { me: new Int16Array(total), other: new Int16Array(total) };
for (const c of clips) track[c.speaker].set(c.pcm, Math.floor((c.atMs / 1000) * RATE));

const out = join(import.meta.dir, 'audio');
await Bun.write(join(out, `${id}.me.pcm`), track.me);
await Bun.write(join(out, `${id}.other.pcm`), track.other);
// 스테레오 WAV (L=나, R=상대)
const stereo = new Int16Array(total * 2);
for (let i = 0; i < total; i++) { stereo[i * 2] = track.me[i]!; stereo[i * 2 + 1] = track.other[i]!; }
const header = new DataView(new ArrayBuffer(44));
const w = (o: number, s: string) => [...s].forEach((ch, k) => header.setUint8(o + k, ch.charCodeAt(0)));
w(0, 'RIFF'); header.setUint32(4, 36 + stereo.byteLength, true); w(8, 'WAVE'); w(12, 'fmt ');
header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, 2, true); header.setUint32(24, RATE, true);
header.setUint32(28, RATE * 4, true); header.setUint16(32, 4, true); header.setUint16(34, 16, true); w(36, 'data'); header.setUint32(40, stereo.byteLength, true);
await Bun.write(join(out, `${id}.wav`), new Blob([header.buffer, stereo.buffer]));
await Bun.write(join(out, `${id}.timeline.json`), JSON.stringify(clips.map((c) => ({ speaker: c.speaker, atMs: Math.round(c.atMs), durMs: Math.round((c.pcm.length / RATE) * 1000), text: c.text })), null, 1));
console.log(`${id}: ${clips.length} clips, ${(total / RATE).toFixed(1)}s`);
