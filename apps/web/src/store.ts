// 클라이언트 스토어: 서버 op을 공유 리듀서로 적용한다. seq가 끊기면 hello로 다시 받는다. (§6.1, §6.3)
import { applyOps, initialState } from '@eary/core';
import type { C2S, CallState, LatencySpan, ProviderStatus, S2C } from '@eary/schema';
import { create } from 'zustand';

interface Store {
  state: CallState;
  seq: number;
  connected: boolean;
  providers: ProviderStatus;
  metrics: Record<string, number[]>;
  focusUtterance?: string;
  voice?: { enrolled: boolean; seconds: number; note?: string };
  send: (m: C2S) => void;
  setFocus: (id?: string) => void;
}

let ws: WebSocket | null = null;
const queue: C2S[] = [];

export const useStore = create<Store>((set, get) => ({
  state: initialState('local'),
  seq: 0,
  connected: false,
  providers: { stt: false, d1: false, l1: false, l2: false },
  metrics: {},
  send: (m) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    else queue.push(m);
  },
  setFocus: (id) => set({ focusUtterance: id }),
}));

function onMessage(msg: S2C) {
  const s = useStore.getState();
  if (msg.t === 'welcome') {
    try { sessionStorage.setItem('eary.session', msg.sessionId); } catch { /* 저장 불가여도 진행 */ }
    // 재개(resume)면 스냅샷 없이 seq만 맞추고 이어지는 ops로 따라잡는다
    useStore.setState(msg.snapshot ? { state: msg.snapshot, seq: msg.seq, providers: msg.providers } : { seq: msg.seq, providers: msg.providers });
  } else if (msg.t === 'ops') {
    if (msg.from !== s.seq + 1) {
      // 순서가 끊겼다 → 스냅샷 다시 받기
      if (msg.ops.length) s.send({ t: 'hello' });
      return;
    }
    useStore.setState({ state: applyOps(s.state, msg.ops), seq: s.seq + msg.ops.length });
  } else if (msg.t === 'metrics') {
    const metrics = { ...s.metrics };
    for (const sp of msg.spans as LatencySpan[]) metrics[sp.name] = [...(metrics[sp.name] ?? []), sp.ms].slice(-50);
    useStore.setState({ metrics });
  } else if (msg.t === 'voice') {
    useStore.setState({ voice: { enrolled: msg.enrolled, seconds: msg.seconds, note: msg.note } });
  } else if (msg.t === 'error') {
    console.warn('[eary]', msg.code, msg.message);
  }
}

export function sendBinary(frame: Uint8Array) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(frame);
}

export function connect() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  ws = new WebSocket(url);
  ws.onopen = () => {
    useStore.setState({ connected: true });
    // 같은 탭이면 이전 세션에 다시 붙는다 (새로고침·끊김 복구, §6.3)
    let sessionId: string | undefined;
    try { sessionId = sessionStorage.getItem('eary.session') ?? undefined; } catch { /* 없음 */ }
    const { seq } = useStore.getState();
    ws!.send(JSON.stringify(sessionId ? { t: 'hello', sessionId, ...(seq > 0 ? { lastSeq: seq } : {}) } : { t: 'hello' }));
    while (queue.length) ws!.send(JSON.stringify(queue.shift()));
  };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data as string) as S2C);
  ws.onclose = () => {
    useStore.setState({ connected: false });
    setTimeout(connect, 800);
  };
}

/** 통화 시작 기준 경과 ms (배지 만료·타이머용) */
export function callNow(state: CallState): number {
  return state.startedAt ? Date.now() - Date.parse(state.startedAt) : 0;
}
