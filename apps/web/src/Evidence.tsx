// 공식 근거 보기 (디자인 10번): 조회 결과(가상 포함) + 웹 검색 자료 + 에이전트 판정을 한곳에. "확인 불가 ≠ 없음"
import type { BoardEl, CallState, Evidence as Ev } from '@eary/schema';
import { useState } from 'react';
import { useStore } from './store';

type Kind = 'official' | 'lookup' | 'reference';
interface Row { id: string; kind: Kind; title: string; status: string; tone: 'teal' | 'red' | 'amber' | 'gray'; body?: string; scope?: string; url?: string; host?: string; mock?: boolean; caveat?: string; utterance?: string }

const STATUS: Record<string, [string, Row['tone']]> = {
  pending: ['조회 중', 'gray'], found: ['자료 발견', 'teal'], match: ['말과 맞음', 'teal'], mismatch: ['차이 발견', 'red'],
  unverifiable: ['확인 불가', 'amber'], failed: ['조회 실패', 'gray'],
};

function collect(s: CallState): Row[] {
  const rows: Row[] = Object.values(s.evidence).map((e: Ev) => {
    const [label, tone] = e.status === 'unverifiable' && e.reason === 'no_source' ? ['조회 연결 전', 'gray' as const] : STATUS[e.status] ?? ['확인 중', 'gray' as const];
    return { id: e.id, kind: e.tier === 'official' ? 'official' : e.tier === 'lookup' ? 'lookup' : 'reference', title: e.title, status: label, tone, body: e.quote ?? (e.query ? `검색어 ${e.query} → 결과 ${e.resultCount ?? 0}건` : undefined), scope: e.scope, mock: e.isMock, caveat: e.caveat, utterance: e.linkedUtteranceIds[0] };
  });
  const canvas = s.boards['board:canvas'];
  if (canvas) {
    for (const id of canvas.order) {
      const el = canvas.els[id] as BoardEl | undefined;
      if (el?.kind !== 'item' || !el.url) continue;
      const kind: Kind = el.tone === 'official' ? 'official' : 'reference';
      rows.push({ id, kind, title: el.value, status: el.tone === 'official' ? '공식 자료' : el.tone === 'news' ? '뉴스' : '참고', tone: el.tone === 'official' ? 'teal' : 'gray', body: el.sub, url: el.url, host: el.pills[0]?.text });
    }
    for (const id of canvas.order) {
      const el = canvas.els[id] as BoardEl | undefined;
      if (el?.kind === 'item' && el.section === 'sec:evidence' && !el.url && id.startsWith('ev:') && !s.evidence[id.slice(3)]) rows.push({ id, kind: 'lookup', title: el.label, status: el.pills[0]?.text ?? '판정', tone: el.tone === 'contradicted' ? 'red' : el.tone === 'confirmed' ? 'teal' : 'amber', body: el.value });
    }
  }
  const order: Kind[] = ['official', 'lookup', 'reference'];
  return rows.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

export function EvidenceView() {
  const s = useStore((x) => x.state);
  const setFocus = useStore((x) => x.setFocus);
  const [f, setF] = useState<'all' | Kind>('all');
  const rows = collect(s);
  const shown = rows.filter((r) => f === 'all' || r.kind === f);
  const n = (k: 'all' | Kind) => rows.filter((r) => k === 'all' || r.kind === k).length;
  return (
    <div className="ev">
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {([['all', '전체'], ['official', '공식 자료'], ['lookup', '조회 결과'], ['reference', '참고']] as const).map(([k, l]) => (
          <button key={k} type="button" className={`tab${f === k ? ' tab-on' : ''}`} onClick={() => setF(k)}>{l} {n(k)}</button>
        ))}
      </div>
      {shown.length === 0 && <div className="sub">아직 확인한 근거가 없어요.</div>}
      <div className="ev-list">
        {shown.map((r) => (
          <article key={r.id} className={`ev-card ev-${r.kind}`}>
            <div className="ev-head">
              <span className="lbl">{r.kind === 'official' ? '공식 자료 · 1순위' : r.kind === 'lookup' ? '조회 결과' : '참고 · 뉴스와 후기'}</span>
              <span className={`pill p-${r.tone}`}>{r.status}</span>
              {r.mock && <span className="pill p-gray">시연용 가상 출처</span>}
            </div>
            <b className="ev-title">{r.title}</b>
            {r.body && <div className="ev-body">{r.kind === 'official' && r.body.startsWith('‘') === false && r.status !== '공식 자료' ? `“${r.body}”` : r.body}</div>}
            {r.scope && <div className="sub" style={{ fontSize: 13.5 }}>{r.scope}</div>}
            {r.caveat && <div className="sub" style={{ fontSize: 13.5 }}>{r.caveat}</div>}
            <div className="row-btns">
              {r.url && <a className="btn btn-ghost" href={r.url} target="_blank" rel="noreferrer">원문 열기{r.host ? ` · ${r.host}` : ''}</a>}
              {r.utterance && <button className="btn btn-ghost" type="button" onClick={() => setFocus(r.utterance)}>연결 발언 보기</button>}
            </div>
          </article>
        ))}
      </div>
      <div className="ev-legend sub">
        <span><span className="pill p-teal">자료 발견</span> 말과 맞음</span>
        <span><span className="pill p-red">차이 발견</span> 말과 다름</span>
        <span><span className="pill p-amber">확인 불가</span> 없다는 뜻은 아니에요</span>
        <span>검색에 나온 이름이나 번호는 통화 상대의 신원을 증명하지 않아요.</span>
      </div>
    </div>
  );
}

export function evidenceCount(s: CallState) {
  return collect(s).length;
}
