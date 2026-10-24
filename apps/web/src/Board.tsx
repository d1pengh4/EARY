// 화이트보드 렌더러: 서버 배치기가 정한 좌표대로 HTML 요소 + SVG 연결선을 그린다. 측정(getBoundingClientRect) 없음. (§8.1, §8.10-6)
import { handRotation } from '@eary/core';
import type { BEdge, Board as BoardT, BoardEl, PillSpec, Placed } from '@eary/schema';
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { callNow, useStore } from './store';

const LOGICAL_W = 880;

export function Board({ board }: { board: BoardT }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const now = useNow(500);
  const startedAt = useStore((s) => s.state.startedAt);
  const t = startedAt ? now - Date.parse(startedAt) : 0;

  // 컨테이너 폭에 맞춰 배율만 바꾼다 (0.85~1.3, 그보다 좁으면 가로 스크롤)
  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    // 폭에 맞추되 화면 높이도 넘지 않게 (실기: 1.3배로 키우면 723px 창에서 보드 아래가 잘렸다)
    const fit = () => {
      const w = el.clientWidth;
      const top = el.getBoundingClientRect().top + window.scrollY;
      const availH = Math.max(420, window.innerHeight - Math.min(top, 260) - 24);
      // 높이 맞춤은 0.9까지만 줄인다 (실기: 0.75면 글자가 작고 오른쪽이 비었다)
      setScale(Math.max(0.75, Math.min(1.1, w / LOGICAL_W, Math.max(0.9, availH / board.size.h))));
    };
    const ro = new ResizeObserver(fit);
    window.addEventListener('resize', fit);
    fit();
    ro.observe(el);
    return () => { ro.disconnect(); window.removeEventListener('resize', fit); };
  }, [board.size.h]);

  return (
    <div ref={frameRef} className="board-scroll">
      <div className="host-frame" style={{ width: board.size.w * scale, height: board.size.h * scale }}>
        <div className="host" style={{ width: board.size.w, height: board.size.h, transform: `scale(${scale})` }} aria-label={`${board.title} 보드`}>
          <svg className="edges" width={board.size.w} height={board.size.h} aria-hidden="true">
            <defs>
              {(['claim', 'evidence', 'sequence', 'pointer'] as const).map((k) => (
                <marker key={k} id={`arrow-${k}`} orient="auto" markerWidth="5" markerHeight="5" refX="2" refY="2" overflow="visible">
                  <path d="M0 0 L4 2 L0 4 Z" className={`e-${k}`} style={{ fill: k === 'pointer' ? 'var(--blue)' : 'var(--edge)', stroke: 'none', strokeDasharray: 'none' }} />
                </marker>
              ))}
            </defs>
            {Object.values(board.edges).map((e) => <Edge key={e.id} e={e} />)}
          </svg>
          {Object.values(board.edges).filter((e) => e.label && e.labelAt).map((e) => (
            <div key={`l-${e.id}`} className="alab" style={{ left: e.labelAt!.x, top: e.labelAt!.y }}>{e.label}</div>
          ))}
          {board.order.map((id) => {
            const el = board.els[id];
            const p = board.placed[id];
            if (!el || !p) return null;
            const badge = board.badges[id];
            return <El key={id} el={el} p={p} badge={badge && badge.untilMs > t ? badge.text : undefined} />;
          })}
        </div>
      </div>
    </div>
  );
}

const Edge = memo(function Edge({ e }: { e: BEdge }) {
  const arrow = e.kind !== 'evidence';
  return <path d={e.path} className={`e-${e.kind}`} markerEnd={arrow ? `url(#arrow-${e.kind})` : undefined} />;
});

const El = memo(function El({ el, p, badge }: { el: BoardEl; p: Placed; badge?: string }) {
  const setFocus = useStore((s) => s.setFocus);
  const jump = () => setFocus(el.sources[el.sources.length - 1]?.utteranceId);
  const style = { left: p.x, top: p.y, width: p.w, minHeight: p.h };

  if (el.kind === 'card' && el.style === 'demand') {
    // 요구 카드: 아이콘 + 요구 + 발언 시각을 한 줄로 (56px 안에 들어가게, 실기에서 세 줄이 잘렸다)
    return (
      <button type="button" className={`el c-demand${badge === '방금 추가' ? ' halo' : ''}`} style={{ ...style, height: p.h }} onClick={jump} aria-label={`상대의 ${el.value}${el.sub ? `, ${el.sub}` : ''}`}>
        <span className="demand-row"><CardIcon kind="demand" /><b>{el.value}</b>{el.sub && <span className="demand-at mono">{el.sub.replace(' 발언', '')}</span>}</span>
      </button>
    );
  }
  if (el.kind === 'card') {
    return (
      <button type="button" className={`el c-${el.style}${el.zone === 'overflow' ? ' compact' : ''}${badge === '방금 추가' ? ' halo' : ''}`} style={{ ...style, height: p.h }} onClick={jump} aria-label={`${el.label} ${el.value}`} title={el.value}>
        <span>
          <span className="lbl card-head"><CardIcon kind={el.id.startsWith('demand:') ? 'demand' : (el.entityKey?.split(':')[0] ?? '')} />{el.label}</span>{' '}
          {badge && <span className="pill p-teal">{badge}</span>}
          <span className={`v${el.entityKey?.startsWith('case:') ? ' mono' : ''}`}>{el.value}</span>
          {el.sub && <span className="sub">{el.sub}</span>}
          {el.pills.length > 0 && <span className="pills">{el.pills.map((x) => <Pill key={x.text} p={x} />)}</span>}
        </span>
      </button>
    );
  }
  if (el.kind === 'callout') {
    return (
      <button type="button" className={`el co co-${el.tone}`} style={style} onClick={jump}>
        <span>
          {el.tone === 'signal' ? <b className="v">{el.title}</b> : <span className="lbl">{el.title}</span>}{' '}
          {el.pills.map((x) => <Pill key={x.text} p={x} />)}
          {badge && <> <span className="pill p-teal">{badge}</span></>}
          <span className="body-text">{el.body}</span>
        </span>
      </button>
    );
  }
  if (el.kind === 'table') {
    return (
      <div className="el tblbox" style={{ ...style, height: 'auto' }}>
        <table className="ctable">
          <thead><tr>{el.columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
          <tbody>
            {el.rows.map((r) => (
              <tr key={r.id} className={r.highlight ? 'hl' : undefined}>
                {r.cells.map((c, i) => (i === 0 ? <th key={i} scope="row">{c}</th> : <td key={i}>{c}{r.pills?.[i] && <> <Pill p={r.pills[i]!} /></>}</td>))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (el.kind === 'section') {
    return (
      <div className={`sec${el.status === 'thinking' ? ' sec-thinking' : ''}`} style={{ left: p.x, top: p.y, width: p.w, height: p.h }}>
        <div className="sec-head"><span>{el.title}</span>{el.status === 'thinking' && <span className="pill p-teal">생각 중…</span>}</div>
      </div>
    );
  }
  if (el.kind === 'item') {
    const Tag = el.url ? 'a' : 'button';
    return (
      <Tag {...(el.url ? { href: el.url, target: '_blank', rel: 'noreferrer' } : { type: 'button' as const, onClick: jump })} className={`el it t-${el.tone}${badge === '방금 추가' ? ' halo' : ''}`} style={{ ...style, height: p.h }}>
        <span>
          <span className="lbl">{el.label}</span>{' '}
          {badge && <span className="pill p-teal">{badge}</span>}
          <span className="v">{el.value}</span>
          {el.sub && <span className="sub it-sub">{el.sub}</span>}
          {el.pills.length > 0 && <span className="pills">{el.pills.map((x) => <Pill key={x.text} p={x} />)}</span>}
        </span>
      </Tag>
    );
  }
  if (el.kind === 'row') {
    return (
      <div className={`trow${el.header ? ' thead' : ''}${el.tone ? ` t-${el.tone}` : ''}`} style={{ left: p.x, top: p.y, width: p.w, height: p.h, gridTemplateColumns: `repeat(${el.cells.length}, 1fr)` }}>
        {el.cells.map((c, i) => <span key={i}>{c}</span>)}
      </div>
    );
  }
  if (el.kind === 'chip') {
    return <div className={`chipline s-${el.state}`} style={{ left: p.x, top: p.y, width: p.w }} role="status">{el.state === 'running' ? '⌕ ' : el.state === 'done' ? '✓ ' : '· '}{el.text}</div>;
  }
  if (el.kind === 'hand') {
    return <div className="hand" style={{ left: p.x, top: p.y, width: p.w, transform: `rotate(${handRotation(el.id)}deg)` }}>{el.text}</div>;
  }
  if (el.kind === 'banner') return <div className="el co co-info" style={style}><span style={{ fontSize: 16 }}>{el.text}</span></div>;
  return null;
});

/** 카드 종류 아이콘 (선 아이콘, 글자색을 따른다) */
function CardIcon({ kind }: { kind: string }) {
  const d: Record<string, string> = {
    org: 'M4 21V9l8-5 8 5v12M9 21v-6h6v6M3 21h18', // 기관
    person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0', // 인물
    case: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6', // 사건 서류
    account: 'M3 7h18v12H3zM3 11h18M7 15h4', // 계좌
    demand: 'M12 3l10 18H2zM12 10v5M12 18v.5', // 요구(경고)
    amount: 'M12 3v18M17 7H9.5a3 3 0 0 0 0 6h5a3 3 0 0 1 0 6H6', // 금액
    date: 'M4 6h16v15H4zM4 10h16M9 3v5M15 3v5', // 일정
  };
  const path = d[kind];
  if (!path) return null;
  return <svg className="card-ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
}

function Pill({ p }: { p: PillSpec }) {
  return <span className={`pill p-${p.tone}`}>{p.text}</span>;
}

export function useNow(every: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

export { callNow };
