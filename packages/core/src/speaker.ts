// 스피커폰 한 대(마이크 하나)에서 나/상대 구분. 학습된 모델 없이: 목소리 등록 + 전화 음질 단서 + 사용자 수정으로 보정.
// - 내 목소리: 마이크로 바로 들어와 고음(4kHz+)까지 살아 있다.
// - 상대 목소리: 전화망(대개 3.4kHz 또는 7kHz 대역 제한) + 휴대폰 작은 스피커를 거쳐 고음이 약하고 저음(<250Hz)이 빠진다.
// 실제 환경 녹음으로 임계값을 다시 맞춰야 한다 (docs/BACKLOG.md #8).

const RATE = 16000;
const N = 512; // 32ms 창
const HOP = 160; // 10ms
const BANDS = 18;

export interface VoiceFeat {
  /** 대역별 로그 에너지에서 평균을 뺀 "스펙트럼 모양" (음량과 무관) */
  shape: number[];
  /** 4~7.6kHz 에너지 / 0.3~3.4kHz 에너지 (dB) — 전화 음성일수록 낮다 */
  highDb: number;
  /** 250Hz 미만 에너지 / 0.3~3.4kHz (dB) — 휴대폰 스피커일수록 낮다 */
  lowDb: number;
  /** 말소리 프레임 수 (너무 짧으면 신뢰도를 낮춘다) */
  voiced: number;
}

const edges = (() => {
  // 100Hz ~ 7600Hz 로그 간격 대역 경계 (FFT bin)
  const lo = Math.log(100), hi = Math.log(7600);
  return Array.from({ length: BANDS + 1 }, (_, i) => Math.round((Math.exp(lo + ((hi - lo) * i) / BANDS) / RATE) * N));
})();
const hann = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
const bin = (hz: number) => Math.round((hz / RATE) * N);

/** PCM16LE mono 16kHz → 특징. 조용한 프레임(말 없음)은 뺀다 */
export function voiceFeatures(pcm: Int16Array): VoiceFeat {
  const re = new Float64Array(N), im = new Float64Array(N);
  const bandSum = new Float64Array(BANDS);
  let high = 0, mid = 0, low = 0, voiced = 0;
  const frames: { e: number; p: Float64Array }[] = [];
  for (let off = 0; off + N <= pcm.length; off += HOP) {
    let e = 0;
    for (let i = 0; i < N; i++) { const v = (pcm[off + i]! / 32768) * hann[i]!; re[i] = v; im[i] = 0; e += v * v; }
    fft(re, im);
    const p = new Float64Array(N / 2);
    for (let k = 0; k < N / 2; k++) p[k] = re[k]! * re[k]! + im[k]! * im[k]!;
    frames.push({ e, p });
  }
  if (!frames.length) return { shape: new Array(BANDS).fill(0), highDb: 0, lowDb: 0, voiced: 0 };
  // 에너지 상위 60% 프레임만 말소리로 본다 (무음·잡음 제외)
  const sorted = frames.map((f) => f.e).sort((a, b) => a - b);
  const gate = Math.max(sorted[Math.floor(sorted.length * 0.4)]!, 1e-7);
  for (const f of frames) {
    if (f.e < gate) continue;
    voiced++;
    for (let b = 0; b < BANDS; b++) { let s = 0; for (let k = edges[b]!; k < Math.max(edges[b + 1]!, edges[b]! + 1); k++) s += f.p[k] ?? 0; bandSum[b]! += s; }
    for (let k = bin(4000); k < bin(7600); k++) high += f.p[k]!;
    for (let k = bin(300); k < bin(3400); k++) mid += f.p[k]!;
    for (let k = bin(60); k < bin(250); k++) low += f.p[k]!;
  }
  const logs = Array.from(bandSum, (s) => 10 * Math.log10(s / Math.max(voiced, 1) + 1e-12));
  const mean = logs.reduce((a, b) => a + b, 0) / BANDS;
  const db = (a: number, b: number) => 10 * Math.log10((a + 1e-12) / (b + 1e-12));
  return { shape: logs.map((x) => x - mean), highDb: db(high, mid), lowDb: db(low, mid), voiced };
}

export interface SpeakerModel {
  me?: { shape: number[]; highDb: number; lowDb: number; n: number };
  other?: { shape: number[]; highDb: number; lowDb: number; n: number };
}

export interface SpeakerGuess { speaker: 'me' | 'other'; pMe: number; confidence: number; why: string[] }

const dist = (a: number[], b: number[]) => Math.sqrt(a.reduce((s, x, i) => s + (x - b[i]!) ** 2, 0) / a.length);
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/**
 * 판단: 각 단서를 로그 오즈로 더한다.
 * ① 등록(또는 수정으로 배운) 목소리 모양과의 거리, ② 고음 비율(전화 음성 단서), ③ 말소리가 너무 짧으면 신뢰도 감소.
 */
export function guessSpeaker(f: VoiceFeat, m: SpeakerModel): SpeakerGuess {
  // 합성 실측 (TTS 원본 vs 전화망 흉내): 같은 조건끼리 모양 거리 0.85~2.3, 전화를 거치면 5.9~8.3.
  // 저음 비율은 원본 -2.6~-8dB, 전화(휴대폰 스피커)를 거치면 -10.9~-18.6dB. HD 보이스는 고음이 살아 있어 고음 단서가 약하다.
  const why: string[] = [];
  let logit = 0;
  const me = m.me;
  // ① 고음(전화망 대역 제한)
  const refHi = me?.highDb ?? -22;
  logit += clamp((f.highDb - refHi) / 3, -3, 3);
  why.push(`고음 ${f.highDb.toFixed(1)}dB (기준 ${refHi.toFixed(1)})`);
  // ② 저음(휴대폰 작은 스피커)
  const refLo = me?.lowDb ?? -5;
  logit += clamp((f.lowDb - refLo + 3) / 2.5, -3, 3);
  why.push(`저음 ${f.lowDb.toFixed(1)}dB (기준 ${refLo.toFixed(1)})`);
  // ③ 목소리 모양: 등록한 내 목소리와 가까우면 나
  if (me) {
    const dMe = dist(f.shape, me.shape);
    if (m.other) logit += clamp((dist(f.shape, m.other.shape) - dMe) / 1.2, -3, 3);
    else logit += clamp((3.5 - dMe) / 1.0, -3, 3);
    why.push(`모양 거리 ${dMe.toFixed(2)}`);
  }
  const pMe = sigmoid(logit);
  const short = Math.min(1, f.voiced / 60); // 0.6초 미만이면 덜 믿는다
  const confidence = Math.abs(pMe - 0.5) * 2 * short;
  return { speaker: pMe >= 0.5 ? 'me' : 'other', pMe, confidence, why };
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** 등록·사용자 수정으로 모델 보정 (이동 평균) */
export function learn(m: SpeakerModel, who: 'me' | 'other', f: VoiceFeat): SpeakerModel {
  if (f.voiced < 20) return m;
  const cur = m[who];
  if (!cur) return { ...m, [who]: { shape: [...f.shape], highDb: f.highDb, lowDb: f.lowDb, n: 1 } };
  const w = 1 / (cur.n + 1);
  return { ...m, [who]: { shape: cur.shape.map((x, i) => x * (1 - w) + f.shape[i]! * w), highDb: cur.highDb * (1 - w) + f.highDb * w, lowDb: cur.lowDb * (1 - w) + f.lowDb * w, n: cur.n + 1 } };
}

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j]!, re[i]!]; [im[i], im[j]] = [im[j]!, im[i]!]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k]!, ai = im[i + k]!;
        const br = re[i + k + len / 2]! * cr - im[i + k + len / 2]! * ci;
        const bi = re[i + k + len / 2]! * ci + im[i + k + len / 2]! * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

/** 테스트·시뮬레이션용: 전화망 + 휴대폰 스피커 흉내 (300~3400Hz 대역 통과 + 약한 잡음) */
export function simulatePhone(pcm: Int16Array, hiCut = 3400, loCut = 300): Int16Array {
  const biquad = (x: Float64Array, type: 'lp' | 'hp', fc: number) => {
    const w0 = (2 * Math.PI * fc) / RATE, q = Math.SQRT1_2, a = Math.sin(w0) / (2 * q), c = Math.cos(w0);
    const [b0, b1, b2] = type === 'lp' ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
    const a0 = 1 + a, a1 = -2 * c, a2 = 1 - a;
    const y = new Float64Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) { const v = (b0 * x[i]! + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x[i]!; y2 = y1; y1 = v; y[i] = v; }
    return y;
  };
  let x = Float64Array.from(pcm, (v) => v);
  for (let i = 0; i < 2; i++) { x = biquad(x, 'lp', hiCut); x = biquad(x, 'hp', loCut); }
  let seed = 7;
  return Int16Array.from(x, (v) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return Math.max(-32768, Math.min(32767, Math.round(v * 0.8 + ((seed / 0x7fffffff) - 0.5) * 60))); });
}
