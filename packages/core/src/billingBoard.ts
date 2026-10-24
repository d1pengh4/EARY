// 요금 상담 보드 (디자인 5·11번): 상태에서 결정론적으로 만든다. 좌표는 템플릿 구역 그대로.
import type { BEdge, BoardEl, CallState, Placed, PillSpec, TableRow } from '@eary/schema';
import { route } from './board';
import type { BoardTemplate } from './packs';

export interface Tariff { monthly: number; monthlyNote?: string; contractMonths: number[]; installFee?: string; penalty?: string }

const won = (n: number) => (n >= 10_000 && n % 10_000 === 0 ? `${n / 10_000}만 원` : `${n.toLocaleString('ko-KR')}원`);

export function buildBillingBoard(s: CallState, tpl: BoardTemplate, tariff?: Tariff): { els: BoardEl[]; placed: Placed[]; edges: BEdge[] } {
  const ents = Object.values(s.entities).filter((e) => e.certainty !== 'provisional');
  const amount = ents.find((e) => e.type === 'amount');
  const dur = ents.find((e) => e.type === 'duration');
  const date = ents.find((e) => e.type === 'date');
  const said = s.utteranceOrder.map((id) => s.utterances[id]).filter((u) => u && u.status !== 'interim' && u.speaker === 'other').map((u) => u!.text).join(' ');
  const src = (e?: { sources: CallState['entities'][string]['sources'] }) => e?.sources ?? [];
  const pill = (text: string, tone: PillSpec['tone']): PillSpec => ({ text, tone });

  // ── 비교표 ──
  const est = amount?.attrs.estimate === 'true';
  const n = amount ? Number(amount.attrs.won) : NaN;
  const inRange = tariff && Number.isFinite(n) ? Math.abs(n - tariff.monthly) / tariff.monthly <= 0.1 : undefined;
  const months = dur ? Number(dur.attrs.months) : NaN;
  const rows: TableRow[] = [
    { id: 'monthly', cells: ['월 요금', amount ? `‘${amount.value}’` : '아직 안내 없음', tariff ? `월 ${tariff.monthly.toLocaleString('ko-KR')}원${tariff.monthlyNote ? ` (${tariff.monthlyNote})` : ''}` : '조회 중…', amount && tariff ? (inRange ? '범위 안' : '차이 있음') : '—'],
      pills: [null, est ? pill('예상 비용', 'amber') : null, tariff ? pill('자료 발견', 'teal') : null, amount && tariff ? pill(inRange ? '범위 안' : '차이 발견', inRange ? 'teal' : 'red') : null] },
    { id: 'contract', cells: ['약정', dur ? dur.value : '아직 안내 없음', tariff ? `${tariff.contractMonths.join('·')}개월 약정 상품이 있어요` : '—', dur && tariff ? (tariff.contractMonths.includes(months) ? '일치' : '확인 필요') : '—'],
      pills: [null, null, null, dur && tariff ? pill(tariff.contractMonths.includes(months) ? '일치' : '확인 필요', tariff.contractMonths.includes(months) ? 'teal' : 'amber') : null] },
    { id: 'install', cells: ['설치', date ? date.value : '아직 안내 없음', '일정은 상담 후 정해져요', date ? '날짜 미정' : '—'], pills: [null, date ? pill('날짜 미정', 'gray') : null, null, null] },
    { id: 'installFee', cells: ['설치비', said.includes('설치비') ? '안내 있음 (기록 확인)' : '아직 안내 없음', tariff?.installFee ?? '—', said.includes('설치비') ? '확인' : '물어보세요'], pills: [null, null, null, said.includes('설치비') ? null : pill('물어보세요', 'amber')] },
    { id: 'penalty', cells: ['위약금', said.includes('위약금') ? '안내 있음 (기록 확인)' : '아직 안내 없음', tariff?.penalty ?? '—', said.includes('위약금') ? '확인' : '물어보세요'], pills: [null, null, null, said.includes('위약금') ? null : pill('물어보세요', 'amber')] },
  ];
  const els: BoardEl[] = [{ kind: 'table', id: 'tbl:compare', zone: 'table', columns: ['항목', '상담원이 한 말', '공식 요금표', '비교'], rows, sources: [...src(amount), ...src(dur)] }];

  // ── 손글씨 메모 (최대 2개) ──
  if (est) els.push({ kind: 'hand', id: 'hand:estimate', zone: 'hand', text: `‘${amount!.value.replace(/\s*정도$/, '')} 정도’라서 예상 비용이에요. 최종 금액은 아직 확정이 아니에요`, pointsTo: 'tbl:compare', sources: src(amount) });

  // ── 아직 안 물어본 것 ──
  const todo = [!said.includes('위약금') && '위약금', !said.includes('설치비') && '설치비', !/포함/.test(said) && '요금에 포함된 항목'].filter(Boolean) as string[];
  if (amount || dur) els.push({ kind: 'callout', id: 'co:todo', zone: 'todo', tone: 'amber', title: '아직 안 물어본 것', body: todo.length ? todo.join('\n') : '주요 조건은 모두 물어봤어요', pills: [], sources: [] });

  // ── 절차 ──
  if (amount || dur || date) {
    const step = (id: string, zone: string, title: string, sub: string, pills: PillSpec[]): BoardEl => ({ kind: 'card', id, zone, label: '', value: title, sub, pills, style: 'confirmed', sources: [] });
    els.push(step('step:apply', 'step1', '가입 신청', '이번 통화에서 진행', []));
    els.push(step('step:visit', 'step2', '설치 방문', date ? date.value : '날짜 안내 전', [pill('날짜 미정', 'gray')]));
    els.push(step('step:bill', 'step3', '첫 청구', '설치 다음 달', [pill(est || !amount ? '금액 미확정' : '금액 안내됨', est || !amount ? 'amber' : 'teal')]));
  }

  // ── 약정 기간 감 잡기 / 일정 안내 ──
  if (Number.isFinite(n) && Number.isFinite(months)) {
    const total = n * months;
    els.push({ kind: 'banner', id: 'banner:total', zone: 'footer', text: `약정 기간 동안의 감 잡기 · ${est ? '예상 ' : ''}${won(n)} × ${months}개월 = 약 ${Math.round(total / 10_000).toLocaleString('ko-KR')}만 원 · 설치비와 위약금은 빠진 금액이에요`, sources: [...src(amount), ...src(dur)] });
  } else if (date) {
    els.push({ kind: 'banner', id: 'banner:total', zone: 'footer', text: '설치 날짜가 정해지면 일정에 추가할 수 있어요.', sources: src(date) });
  }

  const placed: Placed[] = els.map((e) => { const z = tpl.zones[e.zone]!; return { id: e.id, x: z.x, y: z.y, w: z.w, h: z.h }; });
  const pos = Object.fromEntries(placed.map((p) => [p.id, p]));
  const edges: BEdge[] = [];
  const seq = (a: string, b: string) => { if (pos[a] && pos[b]) { const g = route(pos[a]!, pos[b]!); edges.push({ id: `edge:${a}->${b}`, from: a, to: b, kind: 'sequence', path: g.path }); } };
  seq('step:apply', 'step:visit');
  seq('step:visit', 'step:bill');
  if (pos['hand:estimate'] && pos['tbl:compare']) {
    const h = pos['hand:estimate']!; const t = pos['tbl:compare']!;
    edges.push({ id: 'edge:hand->tbl', from: 'hand:estimate', to: 'tbl:compare', kind: 'pointer', path: `M ${h.x} ${h.y + 34} L ${t.x + t.w - 4} ${h.y + 34}` });
  }
  return { els, placed, edges };
}
