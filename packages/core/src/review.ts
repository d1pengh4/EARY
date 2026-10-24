// 통화 종료 리뷰를 상태에서 규칙으로 만든다 (LLM 없이도 항상 나온다). 모든 항목은 원문 발언·시각에 연결된다. (§13)
import { withParticle } from './normalize';
import { ACTION_CATEGORIES, SIGNAL_LABEL, type CallState, type CalendarDraft, type Ref, type Review, type ReviewMoment, type ReviewOpen, type ReportField, type RiskSignal, type SignalCategory } from '@eary/schema';

export function clock(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(t / 3600))}:${p(Math.floor(t / 60) % 60)}:${p(t % 60)}`;
}

/** 최종 경고 제목: 요구 종류에 맞게 (디자인 3번 + 앱 설치 유형) */
export function warningHeadline(cats: SignalCategory[]): string {
  const money = cats.includes('money_transfer');
  const cred = cats.includes('credential_request');
  const app = cats.includes('remote_app');
  if (money && cred) return '지금 송금하거나 인증번호를 알려주지 마세요';
  if (app && cred) return '앱을 설치하거나 비밀번호·인증번호를 알려주지 마세요';
  if (money && app) return '지금 송금하거나 앱을 설치하지 마세요';
  if (money) return '지금 송금하지 마세요';
  if (cred) return '인증번호나 비밀번호를 알려주지 마세요';
  if (app) return '링크를 누르거나 앱을 설치하지 마세요';
  return '지금 상대의 요구를 따르지 마세요';
}

const live = (s: CallState) => Object.values(s.signals).filter((x) => x.active && x.confirmed);
const refOf = (s: CallState, sig: Pick<RiskSignal, 'sources'>): Ref[] => sig.sources.map((x) => ({ utteranceId: x.utteranceId, atMs: s.utterances[x.utteranceId]?.startMs ?? x.startMs }));

export function buildReview(s: CallState, endedAtMs: number): Review {
  const sigs = live(s);
  const cats = [...new Set(sigs.map((x) => x.category))];
  const ents = Object.values(s.entities).filter((e) => e.certainty !== 'provisional');
  const org = ents.find((e) => e.type === 'org');
  const person = ents.find((e) => e.type === 'person');
  const caseE = ents.find((e) => e.type === 'case');
  const account = ents.find((e) => e.type === 'account');
  const finals = s.risk.history.filter((h) => h.level === 'final').length;
  const suspicious = s.risk.level !== 'none' && (s.domain === 'impersonation' || cats.some((c) => ACTION_CATEGORIES.includes(c)));
  const kind = s.domain === 'billing' ? '요금·가입 상담 통화' : suspicious ? `${org?.attrs.kind === 'prosecution' || org?.attrs.kind === 'police' ? '수사기관' : org ? '기관' : ''} 사칭이 의심되는 통화`.trim() : '일반 통화';
  const title = `${kind}${finals ? ` · 최종 경고 ${finals}회` : s.risk.level !== 'none' ? ` · ${LEVEL_KO[s.risk.level]}` : ''}`;

  // ── 핵심 순간 ──
  const moments: ReviewMoment[] = [];
  const at = (utteranceId?: string) => (utteranceId ? s.utterances[utteranceId]?.startMs ?? 0 : 0);
  if (org) {
    const ev = Object.values(s.evidence).find((e) => e.id.startsWith('ev:prosecutor:'));
    moments.push({ atMs: at(org.sources[0]?.utteranceId), utteranceId: org.sources[0]?.utteranceId, title: `${org.value} 소속이라고 밝힘`, detail: ev ? `${ev.title} 조회 · ${evidenceWord(ev.status, ev.reason)}` : '소속은 확인되지 않음' });
  }
  for (const h of s.risk.history) {
    const because = h.because.map((id) => s.signals[id]).filter(Boolean) as RiskSignal[];
    // 이 단계 전환을 일으킨 마지막 발화 (검증 신호도 원문 발화를 출처로 가진다)
    const src = because.flatMap((b) => b.sources).filter((x) => s.utterances[x.utteranceId]).sort((a, b) => at(b.utteranceId) - at(a.utteranceId))[0];
    const labels = [...new Set(because.map((b) => b.label))];
    moments.push({ atMs: src ? at(src.utteranceId) : h.atMs, utteranceId: src?.utteranceId, title: h.level === 'final' ? `${labels.filter((l) => ['송금 요구', '인증정보 요구', '앱 설치 요구'].includes(l)).join('·') || '행동 요구'}` : `${labels.slice(-2).join('·') || '위험 신호'}`, detail: h.level === 'final' ? '최종 경고를 화면 중심에 표시' : `${LEVEL_KO[h.level]} 단계로 올라감`, level: h.level });
  }
  if (caseE) {
    const ev = Object.values(s.evidence).find((e) => e.id.startsWith('ev:case:'));
    moments.push({ atMs: at(caseE.sources[0]?.utteranceId), utteranceId: caseE.sources[0]?.utteranceId, title: `사건번호를 말함 (${caseE.value})`, detail: ev ? `공개 조회 · ${evidenceWord(ev.status, ev.reason)}` : '조회 전' });
  }
  const merged = mergeMoments(moments);

  // ── 아직 확인하지 못한 것 ("아니다"가 아니라 "확인 못 함") ──
  const open: ReviewOpen[] = [];
  if (s.callerNumber && suspicious) open.push({ title: '발신 번호의 실제 소유자', how: '통신사나 경찰을 통해서만 확인할 수 있어요.' });
  if (Object.values(s.evidence).some((e) => e.id.startsWith('ev:case:') && e.status === 'unverifiable')) open.push({ title: '비공개로 진행 중인 사건 여부', how: '공개 조회로는 알 수 없어, 공식 대표번호로 직접 문의해야 해요.' });
  if (person && person.attrs.status === '신원 미확인') open.push({ title: `${person.value}의 실제 신원`, how: '직접 찾은 기관 대표번호로 확인해 보세요.' });
  if (account && suspicious) open.push({ title: '내 계좌의 이상 여부', how: '거래 은행에 확인하면 알 수 있어요.' });
  const said = s.utteranceOrder.map((id) => s.utterances[id]?.text ?? '').join(' ');
  if (s.domain === 'billing') {
    const amount = ents.find((e) => e.type === 'amount');
    if (amount?.attrs.estimate === 'true') open.push({ title: '최종 월 요금', how: `‘${amount.value}’는 예상 비용이에요. 확정 금액을 다시 물어보세요.` });
    for (const [word, how] of [['위약금', '약정 중 해지하면 내는 비용이에요. 가입 전에 확인하세요.'], ['설치비', '월 요금과 따로 한 번 내는 비용이에요.']] as const) if (!said.includes(word)) open.push({ title: word, how: `통화에서 나오지 않았어요. ${how}` });
  }

  // ── 일정 미리보기 ──
  const calendar = calendarFor(s, suspicious, Boolean(account), endedAtMs);

  // ── 신고 준비안 (사칭 의심일 때만) ──
  const report = suspicious ? buildReport(s, sigs, endedAtMs) : undefined;

  return {
    title, durationMs: endedAtMs, endedAt: new Date(Date.parse(s.startedAt ?? new Date().toISOString()) + endedAtMs).toISOString(),
    summary: { text: ruleSummary(s, sigs, org?.value, person?.value), by: 'rule' },
    moments: merged, open, calendar, report,
  };
}

const LEVEL_KO = { none: '위험 신호 없음', caution: '주의', accumulating: '위험 신호 누적', final: '최종 경고' } as const;

function evidenceWord(status: string, reason?: string) {
  if (status === 'unverifiable') return reason === 'no_source' ? '조회 연결 전' : '확인 불가';
  return ({ found: '자료 발견', match: '말과 맞음', mismatch: '말과 다름', failed: '조회 실패', pending: '조회 중' } as Record<string, string>)[status] ?? status;
}

/** 같은 발화에서 나온 순간은 하나로 합친다 */
function mergeMoments(ms: ReviewMoment[]): ReviewMoment[] {
  const out: ReviewMoment[] = [];
  for (const m of [...ms].sort((a, b) => a.atMs - b.atMs)) {
    const prev = out.find((x) => m.utteranceId && x.utteranceId === m.utteranceId);
    if (prev) { prev.detail = `${prev.detail} · ${m.detail}`; if (m.level && (!prev.level || ORDER[m.level] > ORDER[prev.level])) prev.level = m.level; if (m.level === 'final') prev.title = m.title; continue; }
    out.push({ ...m });
  }
  return out;
}
const ORDER = { none: 0, caution: 1, accumulating: 2, final: 3 } as const;

function ruleSummary(s: CallState, sigs: RiskSignal[], org?: string, person?: string): string {
  const labels = [...new Set(sigs.filter((x) => !x.origin.includes('verify')).map((x) => x.label))];
  if (s.domain === 'billing') {
    const amount = Object.values(s.entities).find((e) => e.type === 'amount');
    const dur = Object.values(s.entities).find((e) => e.type === 'duration');
    return `요금·가입 상담 통화였어요.${amount ? ` 월 요금은 ‘${amount.value}’로 안내받았고` : ''}${dur ? ` 약정은 ${dur.value}이에요.` : ''} 위험 신호는 없었어요.`.replace('받았고 위험', '받았어요. 위험');
  }
  if (!labels.length && s.risk.level === 'none') return '특별한 위험 신호 없이 끝난 통화예요.';
  const who = org ? `${withParticle(`${org}${person ? ` ${person}` : ''}`, '을', '를')} 자칭한 상대가` : '상대가';
  const unverified = Object.values(s.evidence).filter((e) => e.status === 'unverifiable' || e.status === 'mismatch').map((e) => e.title);
  return `${who} ${labels.join(', ')} 등을 보였어요.${unverified.length ? ` ${unverified.slice(0, 2).join(', ')}에서는 말한 내용이 확인되지 않거나 공식 안내와 달랐어요.` : ''}`;
}

function calendarFor(s: CallState, suspicious: boolean, hasAccount: boolean, endedAtMs: number): CalendarDraft | undefined {
  const base = new Date(Date.parse(s.startedAt ?? new Date().toISOString()) + endedAtMs);
  const next = new Date(base);
  do next.setDate(next.getDate() + 1); while (next.getDay() === 0 || next.getDay() === 6); // 다음 평일
  next.setHours(9, 0, 0, 0);
  if (suspicious && hasAccount) return { title: '거래 은행에 계좌 이상 여부 문의', startIso: next.toISOString(), memo: '통화 요약과 확인 못 한 항목 포함' };
  if (suspicious) return { title: '기관 공식 대표번호로 직접 확인', startIso: next.toISOString(), memo: '통화에서 들은 번호가 아니라 직접 찾은 번호로' };
  const date = Object.values(s.entities).find((e) => e.type === 'date');
  if (s.domain === 'billing' && date) return { title: `설치 일정 확인 (${date.value})`, startIso: next.toISOString(), memo: '날짜가 정해지지 않았어요. 상담사에게 확정 날짜를 받으세요.' };
  return undefined;
}

function buildReport(s: CallState, sigs: RiskSignal[], endedAtMs: number): NonNullable<Review['report']> {
  const ents = Object.values(s.entities).filter((e) => e.certainty !== 'provisional');
  const org = ents.find((e) => e.type === 'org');
  const person = ents.find((e) => e.type === 'person');
  const account = ents.find((e) => e.type === 'account');
  const start = new Date(s.startedAt ?? new Date().toISOString());
  const end = new Date(start.getTime() + endedAtMs);
  const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const otherRefs = (e?: { sources: { utteranceId: string }[] }) => (e?.sources ?? []).filter((x) => s.utterances[x.utteranceId]?.speaker === 'other').map((x) => ({ utteranceId: x.utteranceId, atMs: s.utterances[x.utteranceId]?.startMs ?? 0 }));
  const demandCats: SignalCategory[] = ['secrecy', 'time_pressure', 'money_transfer', 'credential_request', 'remote_app'];
  const demands = demandCats.flatMap((c) => sigs.filter((x) => x.category === c && !x.origin.includes('verify')).slice(0, 1));
  const fields: ReportField[] = [
    { label: '통화 일시', value: `${start.getFullYear()}년 ${start.getMonth() + 1}월 ${start.getDate()}일 ${hm(start)} ~ ${hm(end)} (${clock(endedAtMs).replace(/^00:/, '')})`, refs: [] },
    ...(s.callerNumber ? [{ label: '발신 번호', value: s.callerNumber, refs: [], note: '화면에 표시된 번호 · 실제 소유자는 확인되지 않음' }] : []),
    ...(org || person ? [{ label: '상대가 밝힌 신원', value: [org?.value, person?.value].filter(Boolean).join(' 소속 '), refs: otherRefs(person ?? org), note: person?.attrs.status === '신원 미확인' || org?.attrs.status === '목록에 없음' ? '확인되지 않음' : undefined }] : []),
    ...(account ? [{ label: '주장 내용', value: '본인 명의 계좌가 범죄에 연루되었다고 주장', refs: otherRefs(account) }] : []),
    { label: '요구 사항', value: demands.map((d) => `${SIGNAL_LABEL[d.category]} ${clock(refOf(s, d)[0]?.atMs ?? 0)}`).join(' · ') || '없음', refs: demands.flatMap((d) => refOf(s, d)).slice(0, 6) },
    { label: '확인 결과', value: Object.values(s.evidence).map((e) => `${e.title}: ${evidenceWord(e.status, e.reason)}`).join(' · ') || '확인한 근거 없음', refs: [] },
  ];
  const lookups = Object.values(s.evidence).filter((e) => e.tier === 'lookup').length;
  return {
    title: `${org?.attrs.kind === 'prosecution' || org?.attrs.kind === 'police' ? '수사기관' : org ? '기관' : ''} 사칭 의심 전화 신고 준비안`.trim(),
    fields,
    attachments: [`통화 자막 ${s.utteranceOrder.length}개 발언 원문과 시각`, ...(lookups ? [`조회 결과 ${lookups}건`] : []), ...(s.mode === 'live' || s.mode === 'replay-audio' ? [`통화 음성 ${clock(endedAtMs).replace(/^00:/, '')} (용량이 커서 선택)`] : [])],
    excluded: '내 이름, 계좌번호, 연락처는 자동으로 넣지 않았어요. 필요하면 직접 추가하세요.',
  };
}

/** .ics 파일 내용 (OAuth 없이 일정 앱으로 가져가기) */
export function toIcs(c: CalendarDraft): string {
  const d = new Date(c.startIso);
  const f = (x: Date) => x.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const end = new Date(d.getTime() + 30 * 60_000);
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//EARY//KO', 'BEGIN:VEVENT', `UID:${f(d)}-eary`, `DTSTAMP:${f(new Date())}`, `DTSTART:${f(d)}`, `DTEND:${f(end)}`, `SUMMARY:${c.title}`, `DESCRIPTION:${c.memo}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}

/** 신고 준비안 → Markdown (복사·파일 저장) */
export function reportMarkdown(r: NonNullable<Review['report']>, damage: '없음' | '있음' | '미선택'): string {
  return [`# ${r.title}`, '', '> 이어리가 통화 기록에서 정리한 초안입니다. 제출 전 직접 확인하세요. 이어리는 대신 접수하지 않습니다.', '',
    ...r.fields.map((f) => `- **${f.label}**: ${f.value}${f.note ? ` _(${f.note})_` : ''}${f.refs.length ? ` — 원문 ${f.refs.map((x) => clock(x.atMs)).join(', ')}` : ''}`),
    `- **피해 여부**: ${damage}`, '', '## 함께 첨부할 근거', ...r.attachments.map((a) => `- ${a}`), '', `_${r.excluded}_`].join('\n');
}
