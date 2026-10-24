// 개발 패널 (⌘⇧D): 모드 전환, 재생 속도, 자유 입력 주입, 지연 측정, 공급사 상태. (§14.2 시연 중 안전장치)
import { useState } from 'react';
import { startCall, stopCall } from './calls';
import { useStore } from './store';

export function DevPanel({ onClose }: { onClose: () => void }) {
  const { send, metrics, providers, connected, state } = useStore();
  const [speed, setSpeed] = useState(1);
  const [speaker, setSpeaker] = useState<'other' | 'me'>('other');
  const [text, setText] = useState('');
  const p = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] ?? 0;
  const [textOnly, setTextOnly] = useState(false);
  const start = (id: string) => void startCall({ kind: 'scenario', id, speed, text: textOnly });

  return (
    <div className="card dev" role="dialog" aria-label="개발 패널">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>개발 패널</b>
        <button className="btn-ghost btn" type="button" onClick={onClose}>닫기</button>
      </div>
      <div className="row">
        <span className={connected ? 'ok' : 'off'}>WS {connected ? '연결' : '끊김'}</span>
        <span className={providers.d1 ? 'ok' : 'off'}>D1 Jev {providers.d1 ? 'on' : 'off'}</span>
        <span className={providers.l1 ? 'ok' : 'off'}>L1 {providers.l1 ? 'on' : 'off'}</span>
        <span className={providers.stt ? 'ok' : 'off'}>STT RTZR {providers.stt ? 'on' : 'off'}</span>
        <span className="off">L2 미연결</span>
      </div>
      <div className="row">
        <button className="btn" type="button" onClick={() => start('impersonation-01')}>사칭 대본</button>
        <button className="btn" type="button" onClick={() => start('billing-01')}>요금 대본</button>
        <label>속도 <select className="field" style={{ minHeight: 36 }} value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>{[0.5, 1, 2, 4].map((v) => <option key={v} value={v}>×{v}</option>)}</select></label>
        <label><input type="checkbox" checked={textOnly} onChange={(e) => setTextOnly(e.target.checked)} /> 텍스트 재생(STT 생략)</label>
        <button className="btn" type="button" onClick={() => stopCall()} disabled={state.phase !== 'listening'}>통화 종료</button>
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { send({ t: 'type.inject', speaker, text: text.trim() }); setText(''); } }}>
        <select className="field" style={{ minHeight: 36 }} value={speaker} onChange={(e) => setSpeaker(e.target.value as 'other' | 'me')} aria-label="화자">
          <option value="other">상대</option>
          <option value="me">나</option>
        </select>
        <input className="field" style={{ flex: 1, minHeight: 36 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="자유 입력: 문장을 넣으면 STT final처럼 처리" aria-label="자유 입력" />
      </form>
      <table>
        <tbody>
          {Object.entries(metrics).map(([k, xs]) => (
            <tr key={k}><td>{k}</td><td>n={xs.length}</td><td>p50 {p(xs, 0.5).toFixed(0)}ms</td><td>p95 {p(xs, 0.95).toFixed(0)}ms</td></tr>
          ))}
          {Object.keys(metrics).length === 0 && <tr><td>지연 측정값 없음</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
