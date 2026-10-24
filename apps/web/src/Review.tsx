// 통화 종료 후 화면: 리뷰(4번) · 전체 기록(6번) · 신고 준비안(7번). 모든 항목은 원문 발언으로 이동할 수 있다.
import { clock, reportMarkdown, toIcs } from '@eary/core';
import type { CallState, Ref, Review as ReviewT, Utterance } from '@eary/schema';
import { useMemo, useState } from 'react';
import { useStore } from './store';

type Tab = 'review' | 'record' | 'report';

export function ReviewArea() {
  const review = useStore((x) => x.state.review);
  const [tab, setTab] = useState<Tab>('review');
  if (!review) return <div className="host board-empty"><div className="hand">리뷰를 만드는 중이에요</div></div>;
  return (
    <>
      <div className="tabs" role="tablist">
        <TabBtn on={tab === 'review'} onClick={() => setTab('review')}>통화 리뷰</TabBtn>
        <TabBtn on={tab === 'record'} onClick={() => setTab('record')}>전체 기록</TabBtn>
        {review.report && <TabBtn on={tab === 'report'} onClick={() => setTab('report')}>신고 준비안</TabBtn>}
      </div>
      {tab === 'review' && <ReviewView r={review} openReport={() => setTab('report')} />}
      {tab === 'record' && <RecordView />}
      {tab === 'report' && review.report && <ReportView r={review} />}
    </>
  );
}

function TabBtn({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" role="tab" aria-selected={on} className={`tab${on ? ' tab-on' : ''}`} onClick={onClick}>{children}</button>;
}

function Jump({ r }: { r: Ref }) {
  const setFocus = useStore((x) => x.setFocus);
  return <button type="button" className="pill p-gray ref" onClick={() => setFocus(r.utteranceId)}>{clock(r.atMs)} 발언</button>;
}

function ReviewView({ r, openReport }: { r: ReviewT; openReport: () => void }) {
  const send = useStore((x) => x.send);
  const setFocus = useStore((x) => x.setFocus);
  const [calendarOff, setCalendarOff] = useState(false);
  const [when, setWhen] = useState(() => (r.calendar ? toLocalInput(r.calendar.startIso) : ''));
  const downloadIcs = () => {
    if (!r.calendar) return;
    download(`eary-${r.calendar.title}.ics`, toIcs({ ...r.calendar, startIso: new Date(when).toISOString() }), 'text/calendar');
  };
  return (
    <div className="rv">
      <section className="rv-card rv-wide">
        <div className="lbl">통화 요약{r.summary.by === 'ai' ? ' · AI가 다듬음' : ''}</div>
        <p className="rv-summary">{r.summary.text}</p>
        <div className="sub">총 통화 시간 <span className="mono">{clock(r.durationMs)}</span></div>
      </section>

      {r.moments.length > 0 && (
        <section className="rv-card rv-wide">
          <h2 className="h2">핵심 순간 <span className="sub" style={{ fontWeight: 400 }}>눌러서 해당 발언 보기</span></h2>
          <ol className="moments">
            {r.moments.map((m, i) => (
              <li key={i}>
                <button type="button" onClick={() => m.utteranceId && setFocus(m.utteranceId)}>
                  <span className="mono">{clock(m.atMs)}</span>
                  <span style={{ flex: 1 }}><b>{m.title}</b><span className="sub" style={{ display: 'block' }}>{m.detail}</span></span>
                  {m.level && m.level !== 'none' && <span className={`pill ${m.level === 'final' ? 'p-red' : 'p-amber'}`}>{m.level === 'final' ? '경고' : m.level === 'accumulating' ? '누적' : '주의'}</span>}
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}

      {r.open.length > 0 && (
        <section className="rv-card">
          <h2 className="h2">아직 확인하지 못한 것</h2>
          <div className="sub">‘아니다’가 아니라 ‘확인 못 함’이에요.</div>
          <ul className="open">{r.open.map((o) => <li key={o.title}><span className="pill p-amber">미확인</span> <b>{o.title}</b><span className="sub" style={{ display: 'block' }}>{o.how}</span></li>)}</ul>
        </section>
      )}

      {r.calendar && !calendarOff && (
        <section className="rv-card">
          <h2 className="h2">일정에 추가 미리보기</h2>
          <div><b>{r.calendar.title}</b></div>
          <label className="sub" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>일시 <input className="field" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
          <div className="sub">메모 · {r.calendar.memo}</div>
          <div className="row-btns">
            <button className="btn btn-primary" type="button" onClick={downloadIcs}>일정 파일 받기 (.ics)</button>
            <button className="btn" type="button" onClick={() => setCalendarOff(true)}>건너뛰기</button>
          </div>
        </section>
      )}

      {r.report && (
        <section className="rv-card">
          <h2 className="h2">신고 준비안 미리보기</h2>
          {r.report.fields.filter((f) => ['상대가 밝힌 신원', '요구 사항'].includes(f.label)).map((f) => <div key={f.label} className="sub"><b style={{ color: 'var(--ink)' }}>{f.label}</b> {f.value}</div>)}
          <div className="row-btns"><button className="btn btn-primary" type="button" onClick={openReport}>준비안 열기</button></div>
        </section>
      )}

      <section className="rv-card">
        <h2 className="h2">기록 보관</h2>
        {r.stored
          ? <div className="sub"><span className="pill p-teal">저장됨</span> 자막, 검색 근거, 리뷰가 이 기기에 저장돼 있어요. 음성 원본은 저장하지 않아요. 보관 기간 <b>{r.stored.retentionDays}일</b> 뒤 자동으로 지워져요.</div>
          : <div className="sub">자막, 도식, 검색 근거가 이 화면에만 있어요. 서버를 끄면 사라져요.</div>}
        <div className="row-btns">
          <button className="btn" type="button" onClick={() => send({ t: 'call.new' })}>새 통화</button>
          {r.stored && <button className="btn" type="button" onClick={() => send({ t: 'call.new', deleteRecord: true })}>기록 삭제하고 새 통화</button>}
        </div>
      </section>
    </div>
  );
}

const FILTERS = [['all', '전체'], ['risk', '위험 신호'], ['other', '상대'], ['me', '나']] as const;

function RecordView() {
  const s = useStore((x) => x.state);
  const focus = useStore((x) => x.focusUtterance);
  const setFocus = useStore((x) => x.setFocus);
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>('all');
  const [q, setQ] = useState('');
  const utts = s.utteranceOrder.map((id) => s.utterances[id]!).filter((u) => u.status !== 'interim');
  const shown = utts.filter((u) => (filter === 'all' || (filter === 'risk' ? u.tags.length > 0 : u.speaker === filter)) && (!q || u.text.replace(/\s+/g, '').includes(q.replace(/\s+/g, ''))));
  const count = (f: (typeof FILTERS)[number][0]) => utts.filter((u) => f === 'all' || (f === 'risk' ? u.tags.length > 0 : u.speaker === f)).length;
  const linked = useMemo(() => (focus ? linkedTo(s, focus) : []), [s, focus]);
  return (
    <div className="rv">
      <section className="rv-card rv-wide">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {FILTERS.map(([k, label]) => <button key={k} type="button" className={`tab${filter === k ? ' tab-on' : ''}`} onClick={() => setFilter(k)}>{label} {count(k)}</button>)}
          <label className="sr" htmlFor="rq">대화에서 찾기</label>
          <input id="rq" className="field" style={{ flex: '1 1 200px' }} placeholder="대화에서 찾기 (예: 사건번호, 계좌)" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="sub" style={{ fontSize: 13 }}>시각순 · 자막은 음성에서 바뀐 글이라 틀릴 수 있어요</div>
        <ul className="transcript" style={{ maxHeight: 520 }}>
          {shown.map((u) => <RecordLine key={u.id} u={u} focus={u.id === focus} onClick={() => setFocus(u.id)} />)}
          {shown.length === 0 && <li className="sub">조건에 맞는 발언이 없어요.</li>}
        </ul>
      </section>
      {focus && (
        <section className="rv-card rv-wide">
          <h2 className="h2">이 발언에 연결된 것 <span className="mono sub">{clock(s.utterances[focus]?.startMs ?? 0)}</span></h2>
          {linked.length ? <ul className="open">{linked.map((l, i) => <li key={i}><span className={`pill ${l.tone}`}>{l.kind}</span> {l.text}</li>)}</ul> : <div className="sub">연결된 정보·근거가 없어요.</div>}
        </section>
      )}
    </div>
  );
}

function RecordLine({ u, focus, onClick }: { u: Utterance; focus: boolean; onClick: () => void }) {
  return (
    <li className={`ln${focus ? ' focus' : ''}`}>
      <span className="dot" style={{ background: u.speaker === 'me' ? 'var(--ink)' : 'var(--blue)' }} />
      <button type="button" className="ln-btn" onClick={onClick}>
        <span className="meta"><span>{u.label}</span><span className="mono">{clock(u.startMs)}</span>{u.status === 'edited' && <span className="pill p-gray">고침</span>}</span>
        <span className="tx" style={{ display: 'block' }}>{u.text}</span>
        {u.tags.length > 0 && <span className="tags">{u.tags.map((t) => <span key={t}>{t}</span>)}</span>}
      </button>
    </li>
  );
}

/** 발언 → 그 발언을 출처로 가진 엔티티·신호·근거·보드 항목 ("그때의 보드" 대신 연결 목록) */
function linkedTo(s: CallState, id: string): { kind: string; text: string; tone: string }[] {
  const out: { kind: string; text: string; tone: string }[] = [];
  for (const e of Object.values(s.entities)) if (e.sources.some((x) => x.utteranceId === id)) out.push({ kind: '정보', text: `${e.value}${e.attrs.status ? ` · ${e.attrs.status}` : ''}`, tone: 'p-teal' });
  for (const g of Object.values(s.signals)) if (g.active && g.confirmed && g.sources.some((x) => x.utteranceId === id)) out.push({ kind: '위험 신호', text: `${g.label} — ${g.explanation}`, tone: 'p-red' });
  for (const ev of Object.values(s.evidence)) if (ev.linkedUtteranceIds.includes(id)) out.push({ kind: ev.tier === 'official' ? '공식 자료' : '조회 결과', text: `${ev.title}: ${ev.scope}${ev.isMock ? ' · 시연용 가상 출처' : ''}`, tone: 'p-amber' });
  return out;
}

function ReportView({ r }: { r: ReviewT }) {
  const rep = r.report!;
  const [damage, setDamage] = useState<'없음' | '있음' | '미선택'>('미선택');
  const [copied, setCopied] = useState(false);
  const md = reportMarkdown(rep, damage);
  return (
    <div className="rv">
      <section className="rv-card rv-wide">
        <div className="lbl">초안 · 제출 전</div>
        <h2 className="h2" style={{ fontSize: 22, fontFamily: 'var(--display)', fontWeight: 400 }}>{rep.title}</h2>
        <div className="sub">이어리가 통화 기록에서 정리했고, 모든 항목에 원문 발언과 시각이 연결돼 있어요.</div>
        <dl className="report">
          {rep.fields.map((f) => (
            <div key={f.label}>
              <dt>{f.label}</dt>
              <dd>{f.value}{f.note && <span className="pill p-gray" style={{ marginLeft: 8 }}>{f.note}</span>}{f.refs.length > 0 && <span className="refs">{f.refs.slice(0, 4).map((x, i) => <Jump key={i} r={x} />)}</span>}</dd>
            </div>
          ))}
          <div>
            <dt>피해 여부</dt>
            <dd>
              <fieldset className="damage"><legend className="sr">피해 여부</legend>
                {(['없음', '있음'] as const).map((v) => <label key={v}><input type="radio" name="damage" checked={damage === v} onChange={() => setDamage(v)} /> {v}</label>)}
                <span className="sub">직접 선택</span>
              </fieldset>
              {damage === '있음' && <div className="next urgent" style={{ marginTop: 8 }}><b>은행에 먼저 지급정지를 요청하세요.</b></div>}
            </dd>
          </div>
        </dl>
      </section>
      <section className="rv-card">
        <h2 className="h2">함께 첨부할 근거</h2>
        <ul className="open">{rep.attachments.map((a) => <li key={a}>{a}</li>)}</ul>
        <h2 className="h2" style={{ marginTop: 12 }}>준비안에 넣지 않은 것</h2>
        <div className="sub">{rep.excluded}</div>
      </section>
      <section className="rv-card">
        <h2 className="h2">내보내기</h2>
        <div className="sub">신고는 직접 접수해야 해요. 이어리가 대신 접수하지 않고, 준비안을 복사하거나 파일로 저장할 수 있어요.</div>
        <div className="row-btns">
          <button className="btn btn-primary" type="button" onClick={() => { void navigator.clipboard?.writeText(md).then(() => setCopied(true)); }}>{copied ? '복사했어요' : '준비안 복사'}</button>
          <button className="btn" type="button" onClick={() => download('eary-신고준비안.md', md, 'text/markdown')}>파일로 저장</button>
          <button className="btn" type="button" onClick={() => window.print()}>인쇄</button>
        </div>
        <div className="sub">신고 창구 바로가기 · 연결 준비 중</div>
      </section>
    </div>
  );
}

function download(name: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function toLocalInput(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
