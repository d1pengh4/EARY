// 분석 로그: 에이전트·검색이 만든 것을 최신순 목록으로 (좌표 배치 없음 → 깨질 일이 없다)
import type { Board, BoardEl } from '@eary/schema';
import { useStore } from './store';

const SECTION_KO: Record<string, string> = { 'sec:heard': '들은 정보', 'sec:search': '검색', 'sec:evidence': '확인 결과', 'sec:think': '메모' };
const TONE_PILL: Record<string, string> = { official: 'p-teal', news: 'p-gray', reference: 'p-gray', contradicted: 'p-red', warning: 'p-red', unknown: 'p-amber', confirmed: 'p-teal', info: 'p-teal', claimed: 'p-gray', heard: 'p-gray' };

export function CanvasLog({ board }: { board: Board }) {
  const setFocus = useStore((x) => x.setFocus);
  const thinking = board.els['sec:think']?.kind === 'section' && (board.els['sec:think'] as Extract<BoardEl, { kind: 'section' }>).status === 'thinking';
  const sectionTitle = (id: string) => { const el = board.els[id]; return SECTION_KO[id] ?? (el?.kind === 'section' ? el.title : ''); };
  const rows = board.order.map((id) => board.els[id]).filter((e): e is Exclude<BoardEl, { kind: 'section' }> => !!e && e.kind !== 'section' && !(e.kind === 'row' && e.header)).reverse();
  return (
    <div className="log" aria-live="polite">
      {thinking && <div className="log-row log-thinking"><span className="pill p-teal">생각 중…</span> 이어리가 대화와 검색 결과를 보고 정리하고 있어요</div>}
      {rows.length === 0 && <div className="sub">통화가 진행되면 검색과 확인 과정이 여기에 쌓여요.</div>}
      {rows.map((el) => {
        const sec = 'section' in el ? el.section : '';
        const kind = sectionTitle(sec);
        const badge = board.badges[el.id];
        if (el.kind === 'chip') return <div key={el.id} className={`log-row log-chip s-${el.state}`}><span className="log-kind">검색</span><span>{el.state === 'running' ? '찾는 중 · ' : ''}{el.text.replace(/^검색 · /, '')}</span></div>;
        if (el.kind === 'row') {
          const cols = (board.els[sec] as Extract<BoardEl, { kind: 'section' }> | undefined)?.columns ?? [];
          return (
            <div key={el.id} className={`log-row log-check${el.tone ? ` t-${el.tone}` : ''}`}>
              <span className="log-kind">{kind || '대조'}</span>
              <span className="log-cells">{el.cells.map((c, i) => <span key={i}><b>{cols[i] ?? ''}</b> {c}</span>)}</span>
            </div>
          );
        }
        if (el.kind === 'item') {
          const body = (
            <>
              <span className="log-kind">{kind}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className={`pill ${TONE_PILL[el.tone] ?? 'p-gray'}`}>{el.label}</span> <b>{el.value}</b>
                {el.sub && <span className="sub" style={{ display: 'block' }}>{el.sub}</span>}
                {el.pills.length > 0 && <span className="pills">{el.pills.map((p) => <span key={p.text} className={`pill p-${p.tone}`}>{p.text}</span>)}</span>}
              </span>
              {badge && <span className="pill p-teal">{badge.text}</span>}
            </>
          );
          return el.url
            ? <a key={el.id} className="log-row" href={el.url} target="_blank" rel="noreferrer">{body}</a>
            : <button key={el.id} type="button" className="log-row" onClick={() => setFocus(el.sources[el.sources.length - 1]?.utteranceId)}>{body}</button>;
        }
        return null;
      })}
    </div>
  );
}
