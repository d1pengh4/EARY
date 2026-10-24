// 캔버스: 상황에 맞는 여러 도식을 자기 레이아웃으로 그린다. 서로 좌표를 공유하지 않아 겹치거나 깨지지 않는다.
import type { Figure, FigTone, TreeNode } from '@eary/schema';
import { Component, useMemo, type ReactNode } from 'react';
import { useStore } from './store';

const TONE: Record<FigTone, string> = { neutral: '#1B1B1B', claim: '#5E6D68', ok: '#1F7A3A', warn: '#B07A00', danger: '#D6322B', info: '#2F5DD8' };
const TONE_BG: Record<FigTone, string> = { neutral: '#F6F5EC', claim: '#FFFFFF', ok: '#E8F4EC', warn: '#FFF0B8', danger: '#FFE3DF', info: '#E4ECFF' };
const clock = (ms?: number) => { if (ms === undefined) return ''; const t = Math.floor(ms / 1000); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };

/** 도식 하나가 렌더링 중 오류를 내도 앱 전체가 멈추지 않게 (실기: 캔버스 탭에서 화면 전체가 하얗게 사라졌다) */
export class FigureBoundary extends Component<{ children: ReactNode; label?: string }, { err: boolean }> {
  state = { err: false };
  static getDerivedStateFromError() { return { err: true }; }
  componentDidCatch(e: unknown) { console.warn('[eary] 그림 오류', this.props.label, e); }
  render() { return this.state.err ? <div className="sub">이 그림은 그리지 못했어요.</div> : this.props.children; }
}

export function CanvasFigures() {
  // 스토어에서 원본만 꺼내고 배열은 useMemo로 만든다 (선택자에서 새 배열을 만들면 무한 렌더링: React #185)
  const order = useStore((x) => x.state.figureOrder);
  const all = useStore((x) => x.state.figures);
  const figs = useMemo(() => order.map((id) => all[id]!).filter(Boolean), [order, all]);
  if (!figs.length) return <div className="host board-empty"><div className="hand">대화가 쌓이면 여기에 여러 그림이 그려져요</div></div>;
  // 중요한 도식이 먼저: 경고·흐름 → 비교 → 나머지
  const rank: Record<string, number> = { quote: 0, money: 1, stages: 2, tree: 3, meter: 4, compare: 5, graph: 6, balance: 7, radar: 8, heat: 9, timeline: 10, flow: 11, bars: 12, bubbles: 13, matrix: 14, checklist: 15, note: 16 };
  // 같은 종류는 규칙 도식이 앞, 에이전트 도식은 뒤. 인용은 규칙의 "결정적인 한마디"가 생기면 에이전트 인용을 숨긴다 (실기: 인용 두 장이 맨 위에)
  const hasRuleQuote = figs.some((f) => f.kind === 'quote' && f.meta.by === 'rule');
  const sorted = figs.filter((f) => !(hasRuleQuote && f.kind === 'quote' && f.meta.by === 'agent')).sort((a, b) => (rank[a.kind] ?? 20) - (rank[b.kind] ?? 20) || Number(a.meta.by === 'agent') - Number(b.meta.by === 'agent'));
  return (
    <div className="figs">
      {sorted.map((f) => (
        <figure key={f.id} className={`fig fig-${f.kind}${f.meta.by === 'agent' ? ' fig-agent' : ''}`} style={{ breakInside: 'avoid' }}>
          {'title' in f && f.title && <figcaption><span>{f.title}</span>{f.meta.by === 'agent' && <span className="pill p-teal">이어리가 그림</span>}</figcaption>}
          <FigureBoundary label={f.id}><Fig f={f} /></FigureBoundary>
        </figure>
      ))}
    </div>
  );
}

function Fig({ f }: { f: Figure }) {
  switch (f.kind) {
    case 'meter': return <Meter f={f} />;
    case 'stages': return <Stages f={f} />;
    case 'money': return <Money f={f} />;
    case 'quote': return <Quote f={f} />;
    case 'timeline': return <Timeline f={f} />;
    case 'compare': return <Compare f={f} />;
    case 'bars': return <Bars f={f} />;
    case 'checklist': return <Checklist f={f} />;
    case 'radar': return <Radar f={f} />;
    case 'heat': return <Heat f={f} />;
    case 'bubbles': return <Bubbles f={f} />;
    case 'balance': return <Balance f={f} />;
    case 'tree': return <Tree f={f} />;
    case 'graph': return <Graph f={f} />;
    case 'flow': return <Flow f={f} />;
    case 'matrix': return <Matrix f={f} />;
    case 'note': return <div className="fig-note" style={{ color: TONE[f.tone] }}>{f.text}</div>;
  }
}

type F<K extends Figure['kind']> = { f: Extract<Figure, { kind: K }> };

/** 반원 계기판: 바늘이 위험 단계를 가리킨다 */
function Meter({ f }: F<'meter'>) {
  const colors = ['#9CABA6', '#E0B400', '#E07B00', '#D6322B'];
  const arc = (i: number) => { const a0 = Math.PI * (1 - i / 4), a1 = Math.PI * (1 - (i + 1) / 4); const p = (a: number, r: number) => `${100 + r * Math.cos(a)} ${100 - r * Math.sin(a)}`; return `M ${p(a0, 80)} A 80 80 0 0 1 ${p(a1, 80)} L ${p(a1, 56)} A 56 56 0 0 0 ${p(a0, 56)} Z`; };
  const ang = Math.PI * (1 - (f.value + 0.5) / 4);
  return (
    <div className="meter">
      <svg viewBox="0 0 200 112" role="img" aria-label={`위험 정도: ${f.labels[f.value]}`}>
        {colors.map((c, i) => <path key={i} d={arc(i)} fill={c} opacity={i <= f.value ? 1 : 0.22} />)}
        <line x1="100" y1="100" x2={100 + 70 * Math.cos(ang)} y2={100 - 70 * Math.sin(ang)} stroke="#1B1B1B" strokeWidth="4" strokeLinecap="round" className="needle" />
        <circle cx="100" cy="100" r="7" fill="#1B1B1B" />
      </svg>
      <b style={{ color: colors[f.value] }}>{f.labels[f.value]}</b>
      {f.caption && <span className="sub">{f.caption}</span>}
    </div>
  );
}

/** 사기 수법 단계: 해당한 단계가 채워진 화살표 띠 */
function Stages({ f }: F<'stages'>) {
  const hits = f.stages.filter((s) => s.hit).length;
  return (
    <div>
      <ol className="stages">
        {f.stages.map((s, i) => (
          <li key={i} className={s.hit ? 'hit' : ''} title={s.quote}>
            <span className="st-n">{i + 1}</span><b>{s.label}</b>
            {s.hit && s.atMs !== undefined && <span className="mono st-t">{clock(s.atMs)}</span>}
          </li>
        ))}
      </ol>
      <div className="sub">{hits}/{f.stages.length}단계에 해당 · {hits >= 4 ? '전형적인 사칭 수법과 매우 비슷해요' : hits >= 2 ? '사칭 수법의 일부가 보여요' : '아직 판단하기 일러요'}</div>
    </div>
  );
}

/** 돈의 흐름: 내 돈 → 요구된 계좌, 가운데 ✗ */
function Money({ f }: F<'money'>) {
  return (
    <div className="money">
      <div className="mn-box">{f.from}</div>
      <svg viewBox="0 0 160 70" className="mn-arrow" aria-hidden="true">
        <defs><marker id="mn-h" orient="auto" markerWidth="6" markerHeight="6" refX="3" refY="3"><path d="M0 0 L6 3 L0 6 Z" fill="#D6322B" /></marker></defs>
        <path d="M 6 35 C 50 5, 110 5, 150 35" fill="none" stroke="#D6322B" strokeWidth="3" strokeDasharray="7 6" markerEnd="url(#mn-h)" className="mn-path" />
        <g transform="translate(80 22)"><circle r="14" fill="#fff" stroke="#D6322B" strokeWidth="2.5" /><path d="M -6 -6 L 6 6 M 6 -6 L -6 6" stroke="#D6322B" strokeWidth="3" strokeLinecap="round" /></g>
        {f.amount && <text x="80" y="62" textAnchor="middle" fontSize="12" fill="#7A1510" fontWeight="700">{f.amount}</text>}
      </svg>
      <div className="mn-box mn-dest">{f.to}</div>
      {f.note && <div className="mn-note">{f.note}</div>}
    </div>
  );
}

function Quote({ f }: F<'quote'>) {
  return (
    <blockquote className="fquote" style={{ borderColor: TONE[f.tone], background: TONE_BG[f.tone] }}>
      <span className="q-mark" aria-hidden="true">“</span>
      <p>{f.quote}</p>
      <footer><span>{f.speaker}{f.atMs !== undefined && ` · ${clock(f.atMs)}`}</span>{f.note && <b style={{ color: TONE[f.tone] }}>{f.note}</b>}</footer>
    </blockquote>
  );
}

/** 통화 흐름: 가로 시간축 위의 점 */
function Timeline({ f }: F<'timeline'>) {
  const setFocus = useStore((x) => x.setFocus);
  const max = Math.max(...f.events.map((e) => e.atMs), 1);
  return (
    <div className="tl">
      <div className="tl-axis" />
      {f.events.map((e, i) => (
        <button key={i} type="button" className={`tl-ev ${i % 2 ? 'down' : 'up'}${(e.atMs / max) < 0.15 ? ' edge-l' : (e.atMs / max) > 0.85 ? ' edge-r' : ''}`} style={{ left: `${4 + (e.atMs / max) * 88}%`, ['--c' as string]: TONE[e.tone] }} onClick={() => setFocus(e.utteranceId)}>
          <span className="tl-dot" /><span className="tl-lbl"><b>{e.label}</b><span className="mono">{clock(e.atMs)}</span></span>
        </button>
      ))}
    </div>
  );
}

function Compare({ f }: F<'compare'>) {
  const V = { match: ['말과 맞음', 'ok'], mismatch: ['말과 다름', 'danger'], unknown: ['확인 못 함', 'warn'] } as const;
  return (
    <div className="cmp">
      {f.rows.map((r, i) => (
        <div key={i} className="cmp-row">
          <div className="cmp-claim"><span className="lbl">들은 말</span>{r.claim}</div>
          <div className="cmp-mid" style={{ color: TONE[V[r.verdict][1]] }}>{r.verdict === 'match' ? '=' : r.verdict === 'mismatch' ? '≠' : '?'}</div>
          <div className="cmp-fact" style={{ borderColor: TONE[V[r.verdict][1]] }}><span className="lbl">확인한 사실</span>{r.fact}<span className="pill" style={{ background: TONE_BG[V[r.verdict][1]], color: TONE[V[r.verdict][1]] }}>{V[r.verdict][0]}</span></div>
        </div>
      ))}
    </div>
  );
}

function Bars({ f }: F<'bars'>) {
  const max = Math.max(...f.bars.map((b) => b.value), 1);
  return (
    <div className="bars">
      {f.bars.map((b, i) => (
        <div key={i} className="bar">
          <span className="bar-l">{b.label}</span>
          <span className="bar-track"><span className="bar-fill" style={{ width: `${(b.value / max) * 100}%`, background: TONE[b.tone] }} /></span>
          <span className="bar-v mono">{b.value.toLocaleString('ko-KR')}{f.unit}{b.note && <span className="sub"> · {b.note}</span>}</span>
        </div>
      ))}
    </div>
  );
}

function Checklist({ f }: F<'checklist'>) {
  return (
    <ul className="chk">
      {f.items.map((it, i) => (
        <li key={i} className={it.done ? 'done' : ''}>
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4" fill={it.done ? '#1F7A3A' : '#fff'} stroke={it.done ? '#1F7A3A' : '#1B1B1B'} strokeWidth="2" />{it.done && <path d="M7 12l3.5 3.5L17 9" stroke="#fff" strokeWidth="2.5" fill="none" strokeLinecap="round" />}</svg>
          <span><b>{it.text}</b>{it.why && <span className="sub" style={{ display: 'block' }}>{it.why}</span>}</span>
        </li>
      ))}
    </ul>
  );
}

/** 위험 레이더: 다섯 축 거미줄 */
function Radar({ f }: F<'radar'>) {
  const n = f.axes.length, cx = 110, cy = 100, R = 72;
  const pt = (i: number, r: number) => { const a = -Math.PI / 2 + (2 * Math.PI * i) / n; return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const; };
  const ring = (k: number) => f.axes.map((_, i) => pt(i, (R * k) / 3).join(',')).join(' ');
  const shape = f.axes.map((a, i) => pt(i, R * Math.max(0.06, a.value)).join(',')).join(' ');
  return (
    <svg viewBox="0 0 220 200" className="radar" role="img" aria-label={f.axes.map((a) => `${a.label} ${Math.round(a.value * 100)}%`).join(', ')}>
      {[1, 2, 3].map((k) => <polygon key={k} points={ring(k)} fill="none" stroke="#E6E3D4" />)}
      {f.axes.map((_, i) => { const [x, y] = pt(i, R); return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="#E6E3D4" />; })}
      <polygon points={shape} fill="rgba(214,50,43,.22)" stroke="#D6322B" strokeWidth="2.5" className="radar-shape" />
      {f.axes.map((a, i) => { const [x, y] = pt(i, R + 16); return <text key={i} x={x} y={y + 4} textAnchor="middle" fontSize="12" fontWeight="700" fill={a.value > 0.5 ? '#7A1510' : '#4F4F4A'}>{a.label}</text>; })}
    </svg>
  );
}

function Heat({ f }: F<'heat'>) {
  const setFocus = useStore((x) => x.setFocus);
  const C = ['#E6EEF2', '#FFE7A3', '#FFB36B', '#D6322B'];
  return (
    <div>
      <div className="heat">{f.cells.map((c, i) => <button key={i} type="button" className="heat-c" style={{ background: C[c.level] }} title={`${clock(c.atMs)} ${c.label}`} aria-label={`${clock(c.atMs)} 온도 ${c.level}`} onClick={() => setFocus(c.utteranceId)} />)}</div>
      <div className="heat-legend sub"><span>처음</span><span>차가움 → 뜨거움</span><span>지금</span></div>
    </div>
  );
}

function Bubbles({ f }: F<'bubbles'>) {
  const max = Math.max(...f.words.map((w) => w.count), 1);
  return (
    <div className="bubbles">
      {f.words.map((w, i) => {
        const size = 40 + (w.count / max) * 46;
        return <span key={i} className="bub" style={{ width: size, height: size, borderColor: TONE[w.tone], background: TONE_BG[w.tone], color: TONE[w.tone], fontSize: 11 + (w.count / max) * 5, animationDelay: `${i * 60}ms` }}><b>{w.text}</b>{w.count > 1 && <span>×{w.count}</span>}</span>;
      })}
    </div>
  );
}

/** 저울: 근거가 많은 쪽으로 기울어진다 */
function Balance({ f }: F<'balance'>) {
  const tilt = Math.max(-14, Math.min(14, (f.right.items.length - f.left.items.length) * 4));
  return (
    <div className="balance">
      <svg viewBox="-10 -30 260 120" aria-hidden="true">
        <polygon points="120,30 106,86 134,86" fill="#1B1B1B" />
        <g style={{ transform: `rotate(${tilt}deg)`, transformOrigin: '120px 30px', transition: 'transform .6s' }}>
          <line x1="30" y1="30" x2="210" y2="30" stroke="#1B1B1B" strokeWidth="4" strokeLinecap="round" />
          {/* 접시는 막대 끝에 매달려 늘 아래를 향한다 */}
          <g style={{ transform: `rotate(${-tilt}deg)`, transformOrigin: '30px 30px' }}><line x1="30" y1="30" x2="30" y2="46" stroke="#1F7A3A" strokeWidth="2" /><path d="M 10 46 L 50 46 L 42 58 L 18 58 Z" fill="#E8F4EC" stroke="#1F7A3A" strokeWidth="2" /></g>
          <g style={{ transform: `rotate(${-tilt}deg)`, transformOrigin: '210px 30px' }}><line x1="210" y1="30" x2="210" y2="46" stroke="#D6322B" strokeWidth="2" /><path d="M 190 46 L 230 46 L 222 58 L 198 58 Z" fill="#FFE3DF" stroke="#D6322B" strokeWidth="2" /></g>
        </g>
      </svg>
      <div className="bal-cols">
        <div><b style={{ color: '#1F7A3A' }}>{f.left.title} {f.left.items.length}</b><ul>{f.left.items.map((x) => <li key={x}>{x}</li>)}{!f.left.items.length && <li className="sub">아직 없어요</li>}</ul></div>
        <div><b style={{ color: '#D6322B' }}>{f.right.title} {f.right.items.length}</b><ul>{f.right.items.map((x) => <li key={x}>{x}</li>)}{!f.right.items.length && <li className="sub">아직 없어요</li>}</ul></div>
      </div>
    </div>
  );
}

/** 결정 나무: 지금 해당하는 길이 빛난다 */
function Tree({ f }: F<'tree'>) {
  return <div className="tree"><TreeBranch n={f.root} /></div>;
}
function TreeBranch({ n, edge }: { n: TreeNode; edge?: string }) {
  const leaf = !n.yes && !n.no;
  return (
    <div className={`tn${n.active ? ' on' : ''}`}>
      {edge && <span className="tn-edge">{edge}</span>}
      <div className={`tn-box${leaf ? ' leaf' : ''}`} style={leaf && n.tone ? { borderColor: TONE[n.tone], background: n.active ? TONE_BG[n.tone] : '#fff' } : undefined}>{n.label}</div>
      {!leaf && <div className="tn-kids">{n.yes && <TreeBranch n={n.yes} edge="예" />}{n.no && <TreeBranch n={n.no} edge="아니오" />}</div>}
    </div>
  );
}

/** 관계도: 들어오는 선이 없는 노드부터 층을 나눠 왼쪽 → 오른쪽, 곡선 화살표 */
function Graph({ f }: F<'graph'>) {
  const layer = new Map<string, number>();
  const incoming = new Map(f.nodes.map((n) => [n.id, 0]));
  for (const e of f.edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  const queue = f.nodes.filter((n) => !incoming.get(n.id)).map((n) => n.id);
  if (!queue.length && f.nodes[0]) queue.push(f.nodes[0].id);
  for (const id of queue) layer.set(id, 0);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    for (const e of f.edges.filter((x) => x.from === id)) if (!layer.has(e.to)) { layer.set(e.to, (layer.get(id) ?? 0) + 1); queue.push(e.to); }
  }
  for (const n of f.nodes) if (!layer.has(n.id)) layer.set(n.id, 0);
  const cols = Math.max(...layer.values()) + 1;
  const W = 150, H = 54, GX = 46, GY = 18;
  const pos = new Map<string, { x: number; y: number }>();
  const perCol: number[] = [];
  for (const n of f.nodes) { const c = layer.get(n.id)!; const r = perCol[c] ?? 0; perCol[c] = r + 1; pos.set(n.id, { x: 10 + c * (W + GX), y: 10 + r * (H + GY) }); }
  const vw = 20 + cols * W + (cols - 1) * GX, vh = 20 + Math.max(...perCol) * (H + GY) - GY;
  const ES = { claim: ['#5E6D68', '6 5'], solid: ['#1B1B1B', ''], money: ['#D6322B', '8 5'], warn: ['#E07B00', ''] } as const;
  return (
    <svg viewBox={`0 0 ${vw} ${vh}`} className="graph" role="img" aria-label={f.edges.map((e) => `${f.nodes.find((n) => n.id === e.from)?.label} → ${f.nodes.find((n) => n.id === e.to)?.label}`).join(', ')}>
      <defs>{Object.entries(ES).map(([k, [c]]) => <marker key={k} id={`g-${k}`} orient="auto" markerWidth="6" markerHeight="6" refX="5" refY="3"><path d="M0 0 L6 3 L0 6 Z" fill={c} /></marker>)}</defs>
      {f.edges.map((e, i) => {
        const a = pos.get(e.from), b = pos.get(e.to);
        if (!a || !b) return null;
        const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x - 4, y2 = b.y + H / 2;
        const back = x2 <= x1;
        const d = back ? `M ${a.x + W / 2} ${a.y + H} C ${a.x + W / 2} ${a.y + H + 40}, ${b.x + W / 2} ${b.y + H + 40}, ${b.x + W / 2} ${b.y + H + 4}` : `M ${x1} ${y1} C ${x1 + GX / 1.4} ${y1}, ${x2 - GX / 1.4} ${y2}, ${x2} ${y2}`;
        const [c, dash] = ES[e.style];
        return <g key={i}><path d={d} fill="none" stroke={c} strokeWidth="2" strokeDasharray={dash} markerEnd={`url(#g-${e.style})`} className="g-edge" />{e.label && <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} textAnchor="middle" fontSize="11" fill={c} fontWeight="700" paintOrder="stroke" stroke="#fff" strokeWidth="4">{e.label}</text>}</g>;
      })}
      {f.nodes.map((n) => { const p = pos.get(n.id)!; return (
        <g key={n.id} className="g-node">
          <rect x={p.x} y={p.y} width={W} height={H} rx="8" fill={TONE_BG[n.tone]} stroke={TONE[n.tone]} strokeWidth="2" strokeDasharray={n.tone === 'claim' ? '6 5' : ''} />
          <text x={p.x + 10} y={p.y + (n.sub ? 22 : 32)} fontSize="13.5" fontWeight="700" fill="#1B1B1B">{n.label.slice(0, 13)}</text>
          {n.sub && <text x={p.x + 10} y={p.y + 41} fontSize="11" fill="#4F4F4A">{n.sub.slice(0, 18)}</text>}
        </g>
      ); })}
    </svg>
  );
}

function Flow({ f }: F<'flow'>) {
  return (
    <ol className="flow">
      {f.steps.map((s, i) => (
        <li key={i} className={`fl-${s.state}`}><b>{s.label}</b>{s.sub && <span className="sub">{s.sub}</span>}{s.state === 'now' && <span className="pill p-teal">지금</span>}{s.state === 'warn' && <span className="pill p-red">주의</span>}</li>
      ))}
    </ol>
  );
}

function Matrix({ f }: F<'matrix'>) {
  return (
    <div className="mtx">
      <span />{f.xLabels.map((x) => <b key={x} className="mtx-h">{x}</b>)}
      {[0, 1].map((y) => (
        <div key={y} style={{ display: 'contents' }}>
          <b className="mtx-v">{f.yLabels[y]}</b>
          {[0, 1].map((x) => { const c = f.cells.find((c) => c.x === x && c.y === y); return <div key={x} className={`mtx-c q${y}${x}`}>{(c?.items ?? []).map((t) => <span key={t}>{t}</span>)}</div>; })}
        </div>
      ))}
    </div>
  );
}
