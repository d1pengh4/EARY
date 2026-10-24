// 음성 캡처: 마이크(나) = 채널 0, 탭/시스템 오디오(상대) = 채널 1. 16kHz mono PCM16, 100ms 단위 바이너리 프레임. (§6.1, §7.3)
import { sendBinary } from './store';

const RATE = 16000;
const FRAME = RATE / 10; // 100ms

const WORKLET = `
class Pcm16 extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(${FRAME}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.buffer.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('pcm16', Pcm16);
`;

export interface Capture {
  stop(): void;
  channels: ('me' | 'other')[];
}

export async function startCapture(opts: { mic: boolean; tab: boolean; micChannel?: number; raw?: boolean }): Promise<Capture> {
  // 브라우저가 16kHz로 리샘플링한다 (Chrome·Edge 지원)
  const ctx = new AudioContext({ sampleRate: RATE });
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
  const streams: MediaStream[] = [];
  const channels: Capture['channels'] = [];

  const wire = (stream: MediaStream, ch: number) => {
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'pcm16');
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      const pcm = new Uint8Array(e.data);
      const frame = new Uint8Array(pcm.length + 1);
      frame[0] = ch;
      frame.set(pcm, 1);
      sendBinary(frame);
    };
    src.connect(node);
  };

  if (opts.mic) {
    // 스피커폰(raw): 잡음 제거·자동 음량을 끈다. 화자 구분 단서(고음·저음 비율)를 바꾸고, 스피커 소리를 잡음으로 깎을 수 있다
    const mic = await navigator.mediaDevices.getUserMedia({ audio: opts.raw ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } : { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    streams.push(mic);
    wire(mic, opts.micChannel ?? 0);
    channels.push('me');
  }
  if (opts.tab) {
    // 탭 오디오: 웹 통화 탭을 고르고 "탭 오디오 공유"를 켜야 한다. Chrome은 video를 같이 요청해야 한다
    const tab = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    tab.getVideoTracks().forEach((t) => t.stop());
    if (tab.getAudioTracks().length === 0) throw new Error('탭 오디오가 공유되지 않았어요. 공유 창에서 "탭 오디오도 공유"를 켜 주세요.');
    streams.push(tab);
    wire(new MediaStream(tab.getAudioTracks()), 1);
    channels.push('other');
  }

  return {
    channels,
    stop() {
      streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
      void ctx.close();
    },
  };
}

let player: HTMLAudioElement | null = null;
/** replay-audio 시연: 서버가 RTZR에 흘리는 것과 같은 오디오를 들려준다 */
export function playScenarioAudio(id: string) {
  stopScenarioAudio();
  player = new Audio(`/audio/${id}.wav`);
  void player.play().catch(() => { /* 자동 재생이 막히면 소리 없이 진행 */ });
}
export function stopScenarioAudio() {
  player?.pause();
  player = null;
}
