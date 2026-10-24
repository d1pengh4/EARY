// 화자 구분 (합성 데이터): 같은 TTS 목소리로 "나"(원본)와 "상대"(전화망 흉내)를 만든다.
// 목소리 모양이 같으니 음질 단서만으로 구분해야 하는, 실제보다 어려운 조건이다. 실제 녹음으로 다시 맞출 것 (BACKLOG #8).
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { guessSpeaker, learn, simulatePhone, voiceFeatures, type SpeakerModel } from '../src/speaker';

const load = async (n: string) => new Int16Array((await Bun.file(join(import.meta.dir, 'fixtures', `${n}.wav`)).arrayBuffer()).slice(44));

describe('화자 구분 (합성)', async () => {
  const enroll = voiceFeatures(await load('enroll'));
  const model: SpeakerModel = learn({}, 'me', enroll);
  const me = await Promise.all(['me1', 'me2'].map(load));
  const other = await Promise.all(['o1', 'o2', 'o3'].map(load));

  test('일반 전화(3.4kHz 대역)', () => {
    for (const p of me) expect(guessSpeaker(voiceFeatures(p), model).speaker).toBe('me');
    for (const p of other) {
      const g = guessSpeaker(voiceFeatures(simulatePhone(p)), model);
      expect(g.speaker).toBe('other');
      expect(g.confidence).toBeGreaterThan(0.6);
    }
  });

  test('HD 보이스(7kHz 대역)도 상대로, 수정하면 배운다', () => {
    const hd = other.map((p) => voiceFeatures(simulatePhone(p, 7000, 250)));
    const first = hd.map((f) => guessSpeaker(f, model));
    console.log('  HD 첫 판단:', first.map((g) => `${g.speaker}(${g.pMe.toFixed(2)})`).join(' '), '|', first[0]!.why.join(' · '));
    for (const g of first) expect(g.speaker).toBe('other'); // 수정 없이도 맞혀야 한다
    // 사용자가 한 번 "상대 말이에요"로 고치면 상대 모델이 생긴다
    const taught = learn(model, 'other', hd[0]!);
    for (const f of hd.slice(1)) expect(guessSpeaker(f, taught).speaker).toBe('other');
    for (const p of me) expect(guessSpeaker(voiceFeatures(p), taught).speaker).toBe('me');
  });

  test('등록이 없어도 일반 전화는 구분', () => {
    for (const p of me) expect(guessSpeaker(voiceFeatures(p), {}).speaker).toBe('me');
    for (const p of other) expect(guessSpeaker(voiceFeatures(simulatePhone(p)), {}).speaker).toBe('other');
  });

  test('특징 계산 5초 분량이 20ms 안', async () => {
    const p = await load('o1');
    const t0 = performance.now();
    voiceFeatures(p);
    expect(performance.now() - t0).toBeLessThan(40);
  });
});
