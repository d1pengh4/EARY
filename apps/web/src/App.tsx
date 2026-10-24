// 화면 골격: 헤더 / 보드 영역 / 기록·AI 요청 (디자인 캔버스 0~3·8번, §11.2)
import type { CallState, Mark, RiskSignal, Utterance } from '@eary/schema';
import { Fragment, useEffect, useRef, useState } from 'react';
import { Board, useNow } from './Board';
import { warningHeadline, withParticle } from '@eary/core';
import { enrollVoice, goHome, startCall, stopCall } from './calls';
import { ReviewArea } from './Review';
import { CanvasLog } from './CanvasLog';
import { CanvasFigures, FigureBoundary } from './Figures';
import { EvidenceView, evidenceCount } from './Evidence';
import { DevPanel } from './DevPanel';
import { useStore } from './store';

export function App() {
  const [dev, setDev] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); setDev((v) => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <Header />
      <div className="body">
        <MainArea />
        <aside className="aside">
          <Transcript />
          <Ask />
        </aside>
      </div>
      {dev && <DevPanel onClose={() => setDev(false)} />}
    </div>
  );
}

function clockText(ms: number) {
  const t = Math.floor(ms / 1000); const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(t / 3600))}:${p(Math.floor(t / 60) % 60)}:${p(t % 60)}`;
}

function riskPill(s: CallState) {
  const n = s.risk.activeCategories.length;
  switch (s.risk.level) {
    case 'final': return <span className="pill p-solid" style={{ height: 30, fontSize: 14 }}>최종 경고</span>;
    case 'accumulating': return <span className="pill p-amber" style={{ height: 30, fontSize: 14 }}>위험 신호 누적 · {n}건</span>;
    case 'caution': return <span className="pill p-amber" style={{ height: 30, fontSize: 14 }}>주의 · 위험 신호 {n}건</span>;
    default: return <span className="pill p-gray" style={{ height: 30, fontSize: 14 }}>{s.phase === 'idle' ? '대기 중' : s.domain === 'billing' || s.domain === 'general' ? `${s.domain === 'billing' ? '요금 상담' : '일반 상담'} · 위험 신호 없음` : '위험 신호 없음'}</span>;
  }
}

function Header() {
  const s = useStore((x) => x.state);
  const now = useNow(1000);
  const elapsed = s.startedAt && s.phase === 'listening' ? Math.max(0, now - Date.parse(s.startedAt)) : 0;
  const hh = (n: number) => String(Math.floor(n)).padStart(2, '0');
  const timer = `${hh(elapsed / 3_600_000)}:${hh((elapsed / 60_000) % 60)}:${hh((elapsed / 1000) % 60)}`;
  // 로고 = 처음 화면. 통화 중에는 실수로 끊기지 않게 두 번 눌러야 한다
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 3000); return () => clearTimeout(t); }, [armed]);
  const onLogo = () => {
    if (s.phase === 'listening' && !armed) { setArmed(true); return; }
    setArmed(false);
    goHome();
  };
  return (
    <header className="card header">
      <button type="button" className="brand brand-btn" onClick={onLogo} aria-label={s.phase === 'listening' ? '통화를 끝내고 처음 화면으로' : '처음 화면으로'}>
        <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true"><rect x="3" y="10" width="4" height="8" rx="2" fill="#1B1B1B" /><rect x="9" y="5" width="4" height="18" rx="2" fill="#1B1B1B" /><rect x="15" y="8" width="4" height="12" rx="2" fill="#1B1B1B" /><rect x="21" y="11" width="4" height="6" rx="2" fill="#1B1B1B" /></svg>
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span className="brand-name">이어리</span>
            <span className="mono" style={{ fontSize: 12, color: '#55645F', letterSpacing: '0.08em' }}>EARY</span>
          </div>
          {s.callerNumber && <div className="mono" style={{ fontSize: 13, color: 'var(--muted)' }}>☎ {s.callerNumber}</div>}
        </div>
        {armed && <span className="brand-tip" role="status">한 번 더 누르면 통화를 끝내고 처음으로 가요</span>}
      </button>
      <div className="situation">
        <div className="lbl">{s.phase === 'ended' ? '통화 리뷰' : '현재 상황'}</div>
        <div className="situation-text" aria-live="polite">{s.phase === 'ended' && s.review ? s.review.title : s.situation.text}</div>
      </div>
      <div className="status">
        <span aria-live={s.risk.level === 'final' ? 'assertive' : 'polite'}>{riskPill(s)}</span>
        {s.phase !== 'idle' && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 14, color: '#55645F' }}>
            <span className={`live${s.phase === 'listening' ? '' : ' off'}`} />
            {s.phase === 'listening' ? `듣는 중${s.consentNotified ? ' · 녹음 고지됨' : ''}` : '통화 종료'}
          </span>
        )}
        {s.phase === 'listening' && <span className="mono" style={{ fontSize: 18, fontWeight: 500 }}>{timer}</span>}
        {s.phase === 'ended' && s.review && <span className="mono" style={{ fontSize: 18, fontWeight: 500 }}>{clockText(s.review.durationMs)}</span>}
        {s.phase === 'listening' && <button className="btn" type="button" onClick={() => stopCall()}>통화 종료</button>}
      </div>
    </header>
  );
}

function MainArea() {
  const s = useStore((x) => x.state);
  const send = useStore((x) => x.send);
  const board = s.activeBoardId ? s.boards[s.activeBoardId] : undefined;
  const showWarning = s.risk.level === 'final' && s.risk.finalWarning && !s.risk.finalWarning.dismissed;

  const [view, setView] = useState<'board' | 'evidence' | 'figures'>('board');
  // 새 통화·처음 화면이 되면 보던 탭(공식 근거 등)을 되돌린다 (실기: 로고로 홈에 가도 빈 근거 화면이 남았다)
  useEffect(() => { setView('board'); }, [s.callId, s.phase]);
  useEffect(() => { const on = () => setView('evidence'); window.addEventListener('eary:evidence', on); return () => window.removeEventListener('eary:evidence', on); }, []);
  if (s.phase === 'ended') return <section className="card main"><ReviewArea /></section>;
  const evN = evidenceCount(s);

  return (
    <section className="card main">
      {s.boardOrder.length > 0 && (
        <div className="tabs" role="tablist">
          {[...s.boardOrder].sort((a, b) => Number(s.boards[a]?.templateId === 'canvas') - Number(s.boards[b]?.templateId === 'canvas')).map((id) => {
            const b = s.boards[id]!;
            const on = id === s.activeBoardId;
            return (
              <button key={id} type="button" role="tab" aria-selected={on && view === 'board'} className={`tab${on && view === 'board' ? ' tab-on' : ''}`} onClick={() => { setView('board'); send({ t: 'board.focus', boardId: id }); }}>
                {b.title}
                {!on && b.updatedAtMs > 0 && <span className="tab-dot" aria-label="새 변화" />}
              </button>
            );
          })}
          {s.figureOrder.length > 0 && <button type="button" role="tab" aria-selected={view === 'figures'} className={`tab${view === 'figures' ? ' tab-on' : ''}`} onClick={() => setView('figures')}>캔버스 {s.figureOrder.length}</button>}
          {evN > 0 && <button type="button" role="tab" aria-selected={view === 'evidence'} className={`tab${view === 'evidence' ? ' tab-on' : ''}`} onClick={() => setView('evidence')}>공식 근거 {evN}</button>}
        </div>
      )}
      {view === 'evidence' ? <EvidenceView /> : view === 'figures' ? <><NextAction /><FigureBoundary label="canvas"><CanvasFigures /></FigureBoundary></> : showWarning ? <FinalWarning /> : (
        <>
          <NextAction />
          {board ? (board.templateId === 'canvas' ? <CanvasLog board={board} /> : <Board board={board} />) : <EmptyBoard />}
        </>
      )}
    </section>
  );
}

function NextAction() {
  const s = useStore((x) => x.state);
  const top = s.suggestions[0];
  if (!top || s.phase === 'idle') return null;
  return (
    <div className={`next${top.id === 'dont_transfer' ? ' urgent' : ''}`}>
      <span className="lbl" style={{ color: 'inherit' }}>다음 행동</span>
      <b>{top.text}</b>
      {top.why && <span style={{ fontSize: 14.5 }}>{top.why}</span>}
    </div>
  );
}

function EmptyBoard() {
  const s = useStore((x) => x.state);
  const stt = useStore((x) => x.providers.stt);
  const [err, setErr] = useState<string>();
  const run = (f: () => Promise<void>) => { setErr(undefined); f().catch((e: Error) => setErr(e.message)); };
  return (
    <div className="host board-empty">
      <div className="hand">{s.phase === 'idle' ? '통화가 시작되면 여기에 그려져요' : s.phase === 'ended' ? '통화가 끝났어요' : '듣고 있어요. 정보가 나오면 그려져요'}</div>
      {s.phase !== 'listening' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
            <button className="btn btn-primary" type="button" style={{ minHeight: 56, padding: '0 28px', fontSize: 17 }} onClick={() => run(() => startCall({ kind: 'scenario', id: 'prosecutor-02' }))}>시연 시작 · 검찰 사칭 전화</button>
            <button className="btn" type="button" style={{ minHeight: 56 }} onClick={() => run(() => startCall({ kind: 'scenario', id: 'billing-01' }))}>대조군 · 요금 상담</button>
          </div>
          <div className="sub">{stt ? '시연은 실제 음성인식(RTZR)을 거쳐요.' : '음성인식 키가 없어 대본 텍스트로 재생해요.'}</div>
          {stt && <LiveStart run={run} />}
          {err && <div className="sub" role="alert" style={{ color: 'var(--red-x)' }}>{err}</div>}
        </div>
      )}
    </div>
  );
}

// 애국가 1절 (공공 영역). 누구나 외워서 편하게 읽고, 10초 분량이라 등록 시간도 10초
const ENROLL_SECONDS = 10;
const ENROLL_TEXT = '동해 물과 백두산이 마르고 닳도록 하느님이 보우하사 우리나라 만세. 무궁화 삼천리 화려 강산 대한 사람 대한으로 길이 보전하세.';

/** 실제 통화 듣기: 스피커폰(마이크 하나, 목소리 등록) 또는 PC 통화(마이크 + 탭 오디오) */
function LiveStart({ run }: { run: (f: () => Promise<void>) => void }) {
  const voice = useStore((x) => x.voice);
  const [left, setLeft] = useState(0);
  return (
    <div className="live-start">
      <div className="live-opt">
        <b>스피커폰 · 마이크 하나</b>
        <span className="sub">휴대폰 스피커폰을 노트북 마이크 가까이 두세요. 내 목소리와 전화 음질로 화자를 구분해요.</span>
        <div className="enroll">
          <span className="lbl">1. 목소리 등록 ({ENROLL_SECONDS}초)</span>
          {left > 0 ? <span className="pill p-teal">{left}초 · 애국가 1절을 소리 내어 읽어 주세요</span> : voice?.enrolled ? <span className="pill p-teal">{voice.note ?? '등록됨'}</span> : voice?.note ? <span className="pill p-amber">{voice.note}</span> : null}
          <q>{ENROLL_TEXT}</q>
          <button className="btn" type="button" disabled={left > 0} onClick={() => run(() => enrollVoice(ENROLL_SECONDS, setLeft))}>{voice?.enrolled ? '다시 등록' : '등록 시작'}</button>
        </div>
        <button className="btn btn-primary" type="button" onClick={() => run(() => startCall({ kind: 'live', mono: true }))}>2. 스피커폰 통화 듣기</button>
        {!voice?.enrolled && <span className="sub" style={{ fontSize: 13 }}>등록 없이도 전화 음질로 구분하지만, 등록하면 더 정확해요.</span>}
      </div>
      <div className="live-opt">
        <b>PC 통화 · 마이크 + 탭 오디오</b>
        <span className="sub">웹 통화 탭을 고르고 공유 창에서 “탭 오디오도 공유”를 켜 주세요. 이어폰을 쓰면 정확해요.</span>
        <button className="btn" type="button" onClick={() => run(() => startCall({ kind: 'live' }))}>PC 통화 듣기</button>
      </div>
    </div>
  );
}

function FinalWarning() {
  const s = useStore((x) => x.state);
  const send = useStore((x) => x.send);
  const setFocus = useStore((x) => x.setFocus);
  const reasons = (s.risk.finalWarning?.reasons ?? []).map((id) => s.signals[id]).filter(Boolean) as RiskSignal[];
  const ts = (ms: number) => { const t = Math.floor(ms / 1000); return `00:${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
  return (
    <div className="warn" role="alert">
      <h2>{warningHeadline(s.risk.activeCategories)}</h2>
      <div style={{ fontSize: 16.5 }}>여러 근거가 겹쳤고, 상대가 {withParticle([s.risk.activeCategories.includes('money_transfer') && '송금', s.risk.activeCategories.includes('remote_app') && '앱 설치', s.risk.activeCategories.includes('credential_request') && '인증정보 전달'].filter(Boolean).join('·') || '위험한 행동', '을', '를')} 직접 요구했어요.</div>
      <div className="lbl">경고 근거 · 눌러서 해당 발언 보기</div>
      <ol className="reasons">
        {dedupeByCategory(reasons).map((r, i) => (
          <li key={r.id}>
            <button type="button" onClick={() => setFocus(r.sources[0]?.utteranceId)}>
              <span className="n">{i + 1}</span>
              <span style={{ flex: 1 }}>
                <b>{r.label}</b>
                <span style={{ display: 'block', fontSize: 15 }}>{r.explanation}</span>
              </span>
              <span className="mono" style={{ fontSize: 13, color: 'var(--muted)' }}>{r.origin.includes('verify') && !r.sources.length ? '공식 자료' : ts(r.sources[0]?.startMs ?? 0)}</span>
            </button>
          </li>
        ))}
      </ol>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button className="btn btn-danger" type="button" onClick={() => { send({ t: 'warning.ack', action: 'hangup_and_check' }); stopCall(); }}>통화를 끊고 직접 확인하기</button>
        <button className="btn" type="button" onClick={() => stopCall()}>통화 종료하고 신고 준비안 보기</button>
        <button className="btn" type="button" onClick={() => send({ t: 'warning.ack', action: 'keep_listening' })}>계속 듣기</button>
      </div>
      <div className="sub">이미 송금했거나 번호를 알려줬다면 거래 은행 고객센터에 바로 연락해 지급정지를 요청하세요. 이어리가 대신 연락하지는 않아요.</div>
      <div className="sub">이어리는 상대에게 말하거나 통화를 대신 끊지 않습니다. 선택은 직접 하실 수 있어요.</div>
    </div>
  );
}

function dedupeByCategory(xs: RiskSignal[]) {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.category) ? false : (seen.add(x.category), true)));
}

function Transcript() {
  const s = useStore((x) => x.state);
  const focus = useStore((x) => x.focusUtterance);
  const listRef = useRef<HTMLUListElement>(null);
  const [follow, setFollow] = useState(true);
  const last = s.utteranceOrder[s.utteranceOrder.length - 1];
  const lastText = last ? s.utterances[last]?.text : '';

  useEffect(() => {
    if (follow && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [lastText, follow, s.utteranceOrder.length]);
  useEffect(() => {
    if (!focus) return;
    document.getElementById(`utt-${focus}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFollow(false);
  }, [focus]);

  return (
    <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h2 className="h2">통화 기록</h2>
      {s.utteranceOrder.length === 0 ? (
        <div className="sub">아직 기록이 없어요. 통화 음성은 글로 바뀌어 화면 분석에만 쓰이고, 상대에게는 들리지 않아요.</div>
      ) : (
        <ul className="transcript" ref={listRef} onScroll={(e) => { const el = e.currentTarget; setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24); }}>
          {s.utteranceOrder.map((id) => <Line key={id} u={s.utterances[id]!} focus={id === focus} />)}
          {s.phase === 'listening' && <li className="ln" style={{ color: '#55645F' }}><span className="dot" style={{ background: '#9CABA6' }} /><div style={{ fontSize: 14 }}>듣는 중…</div></li>}
        </ul>
      )}
      {!follow && <button className="btn" type="button" onClick={() => setFollow(true)}>지금으로 이동</button>}
      {s.utteranceOrder.length > 0 && <div className="sub" style={{ fontSize: 13 }}>자막은 음성에서 바뀐 글이라 틀릴 수 있어요.</div>}
    </section>
  );
}

function Line({ u, focus }: { u: Utterance; focus: boolean }) {
  const send = useStore((x) => x.send);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(u.text);
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (draft.trim() && draft.trim() !== u.text) send({ t: 'utterance.edit', utteranceId: u.id, text: draft.trim() });
    setEditing(false);
  };
  if (editing) {
    // 디자인 12번: 오인식 고치기 → 저장하면 도식과 검색을 다시 확인
    return (
      <li id={`utt-${u.id}`} className="ln editing">
        <form style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }} onSubmit={save}>
          <span className="lbl">{u.label} · 고치는 중</span>
          <label className="sr" htmlFor={`edit-${u.id}`}>발언 고치기</label>
          <input id={`edit-${u.id}`} className="field" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <span className="sub" style={{ fontSize: 13 }}>저장하면 이 발언으로 도식과 검색을 다시 확인해요.</span>
            <span style={{ display: 'flex', gap: 8 }}><button className="btn" type="button" onClick={() => { setDraft(u.text); setEditing(false); }}>취소</button><button className="btn btn-primary" type="submit">저장</button></span>
          </div>
        </form>
      </li>
    );
  }
  return (
    <li id={`utt-${u.id}`} className={`ln${focus ? ' focus' : ''}`}>
      <span className="dot" style={{ background: u.speaker === 'me' ? 'var(--ink)' : 'var(--blue)' }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="meta"><span>{u.label}</span>{u.speakerSource === 'inferred' && <span className="pill p-gray">화자 추정</span>}{u.status === 'edited' && <span className="pill p-gray">고침</span>}</div>
        <div className={`tx${u.status === 'interim' ? ' interim' : ''}`}><Marked text={u.text} marks={u.marks} /></div>
        {u.tags.length > 0 && <div className="tags">{u.tags.map((t) => <span key={t}>{t}</span>)}</div>}
        {u.status !== 'interim' && (
          <div className="acts">
            <button className="btn btn-ghost" type="button" style={{ fontSize: 13, minHeight: 32 }} onClick={() => { setDraft(u.text); setEditing(true); }}>고치기</button>
            <button className="btn btn-ghost" type="button" style={{ fontSize: 13, minHeight: 32 }} onClick={() => send({ t: 'utterance.speaker', utteranceId: u.id, speaker: u.speaker === 'me' ? 'other' : 'me' })}>{u.speaker === 'me' ? '상대 말이에요' : '내 말이에요'}</button>
          </div>
        )}
      </div>
    </li>
  );
}

function Marked({ text, marks }: { text: string; marks: Mark[] }) {
  const out: React.ReactNode[] = [];
  let i = 0;
  for (const m of [...marks].sort((a, b) => a.start - b.start)) {
    if (m.start < i) continue;
    if (m.start > i) out.push(text.slice(i, m.start));
    out.push(<mark key={m.start} className={`m-${m.tone}`}>{text.slice(m.start, m.end)}</mark>);
    i = m.end;
  }
  out.push(text.slice(i));
  return <>{out.map((x, k) => <Fragment key={k}>{x}</Fragment>)}</>;
}

function Ask() {
  const s = useStore((x) => x.state);
  const send = useStore((x) => x.send);
  const [text, setText] = useState('');
  const disabled = s.phase === 'idle';
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    send({ t: 'chat.ask', text: text.trim() });
    setText('');
  };
  return (
    <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2 className="h2" style={{ fontSize: 15 }}>AI에게 요청</h2>
      {s.chat.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 240, overflow: 'auto' }}>
          {s.chat.map((t) => <div key={t.id} className={t.role === 'me' ? 'bb-me' : 'bb-ai'}>{t.text}</div>)}
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button className="chip" type="button" disabled={disabled} onClick={() => send({ t: 'chat.ask', text: '더 쉽게 설명', preset: 'simplify' })}>더 쉽게 설명</button>
        <button className="chip" type="button" disabled={disabled} onClick={() => window.dispatchEvent(new Event('eary:evidence'))}>공식 근거 보기</button>
        <button className="chip" type="button" disabled={disabled} onClick={() => send({ t: 'chat.ask', text: '지금 할 일', preset: 'todo' })}>지금 할 일</button>
      </div>
      <form style={{ display: 'flex', gap: 8 }} onSubmit={submit}>
        <label className="sr" htmlFor="ask">이어리에게 질문하기</label>
        <input id="ask" className="field" style={{ flex: 1, minWidth: 0 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={disabled ? '통화가 시작되면 물어볼 수 있어요' : '짧게 물어보세요'} disabled={disabled} />
        <button className="btn btn-primary" type="submit" aria-label="보내기" style={{ width: 44, padding: 0 }} disabled={disabled}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        </button>
      </form>
    </section>
  );
}
