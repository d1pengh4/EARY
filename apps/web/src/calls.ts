// 통화 시작/종료: 모드에 맞춰 서버 요청 + 오디오(재생 또는 캡처)를 같이 다룬다.
import { playScenarioAudio, startCapture, stopScenarioAudio, type Capture } from './audio';
import { useStore } from './store';

let capture: Capture | null = null;

export async function startCall(c: { kind: 'scenario'; id: string; speed?: number; text?: boolean } | { kind: 'live'; mono?: boolean } | { kind: 'type' }) {
  const { send, providers } = useStore.getState();
  stopCall(false);
  if (c.kind === 'scenario') {
    // STT 키가 있으면 진짜 음성인식을 거치는 replay-audio, 없으면 대본 텍스트 재생
    const audio = providers.stt && !c.text && (c.speed ?? 1) === 1;
    send({ t: 'call.start', mode: audio ? 'replay-audio' : 'replay-fixture', scenarioId: c.id, consentNotified: true, speed: c.speed });
    if (audio) playScenarioAudio(c.id);
  } else if (c.kind === 'live') {
    // 스피커폰(마이크 하나): 화자는 서버가 음질·목소리로 추정 / PC 통화: 마이크=나, 탭 오디오=상대
    capture = await startCapture({ mic: true, tab: !c.mono, raw: c.mono });
    send({ t: 'call.start', mode: 'live', consentNotified: true, audio: c.mono ? 'mono' : 'dual' });
  } else {
    send({ t: 'call.start', mode: 'type', consentNotified: true });
  }
}

export function stopCall(notify = true) {
  stopScenarioAudio();
  capture?.stop();
  capture = null;
  if (notify) useStore.getState().send({ t: 'call.end' });
}

/** 목소리 등록: 문장을 읽는 동안 마이크 음성을 등록 채널(2)로 보낸다 */
export async function enrollVoice(seconds: number, onTick: (left: number) => void) {
  const { send } = useStore.getState();
  send({ t: 'voice.enroll', action: 'start' });
  const cap = await startCapture({ mic: true, tab: false, micChannel: 2, raw: true }); // 통화 때와 같은 처리로 등록
  for (let left = seconds; left > 0; left--) { onTick(left); await new Promise((r) => setTimeout(r, 1000)); }
  cap.stop();
  onTick(0);
  send({ t: 'voice.enroll', action: 'done' });
}
