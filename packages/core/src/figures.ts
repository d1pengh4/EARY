// 캔버스 도식 — 규칙으로 즉시 만드는 것들 (LLM을 기다리지 않는다). 상황에 맞는 도식만 골라 낸다.
import { ACTION_CATEGORIES, SIGNAL_LABEL, type CallState, type Figure, type FigTone, type SignalCategory, type TreeNode } from '@eary/schema';
import type { Tariff } from './billingBoard';

const LEVEL_LABELS: [string, string, string, string] = ['위험 신호 없음', '주의', '위험 신호 누적', '최종 경고'];
const LEVEL_VALUE = { none: 0, caution: 1, accumulating: 2, final: 3 } as const;

/** 가족·지인 호칭 — "엄마 나야" 같은 가족 사칭 (기관 사칭과 안내가 달라야 한다) */
export const FAMILY = /^(엄마|아빠|어머니|아버지|아들|딸|누나|언니|오빠|형|동생|이모|삼촌|고모|할머니|할아버지|여보|자기|손자|손녀)$/;
export const familyClaim = (s: CallState) => Object.values(s.entities).some((e) => e.type === 'person' && e.certainty !== 'provisional' && FAMILY.test(e.value) && s.utterances[e.sources[0]?.utteranceId ?? '']?.speaker !== 'me');

export function buildRuleFigures(s: CallState, tariff?: Tariff): Figure[] {
  const out: Figure[] = [];
  const live = Object.values(s.signals).filter((x) => x.active && x.confirmed);
  const cats = new Set<SignalCategory>(live.map((x) => x.category));
  const ents = Object.values(s.entities).filter((e) => e.certainty !== 'provisional');
  const org = ents.find((e) => e.type === 'org');
  const person = ents.find((e) => e.type === 'person');
  const caseE = ents.find((e) => e.type === 'case');
  const account = ents.find((e) => e.type === 'account');
  // 상대가 말한 금액을 먼저 (실기: 내가 말한 "지금 6만9천원 내요"를 상담원 주장으로 그림)
  const spk = (e: { sources: { utteranceId?: string }[] }) => s.utterances[e.sources[0]?.utteranceId ?? '']?.speaker;
  const amount = ents.find((e) => e.type === 'amount' && spk(e) !== 'me') ?? ents.find((e) => e.type === 'amount');
  const authority = org && (['prosecution', 'police', 'regulator'].includes(org.attrs.kind ?? '') || org.attrs.authority === 'true');
  const at = (id?: string) => (id ? s.utterances[id]?.startMs : undefined);
  const firstOf = (c: SignalCategory) => live.filter((x) => x.category === c).sort((a, b) => (a.sources[0]?.startMs ?? 0) - (b.sources[0]?.startMs ?? 0))[0];
  const textOf = (id?: string) => (id ? s.utterances[id]?.text : undefined);
  const suspicious = live.length > 0 || s.domain === 'impersonation';
  // 위험 신호 없는 일반 상담(요금 등)에는 "끊고 다시 걸기"·저울 같은 사기 대응 그림을 그리지 않는다 (실기: SKT 요금 상담에 저울·다시 걸기)
  const routine = !suspicious && !authority;

  // ① 위험 게이지 — 무슨 통화든 흐름을 한눈에
  if (s.utteranceOrder.length) {
    out.push({ kind: 'meter', id: 'meter', title: '지금 위험 정도', value: LEVEL_VALUE[s.risk.level], labels: LEVEL_LABELS, caption: s.risk.activeCategories.length ? s.risk.activeCategories.map((c) => SIGNAL_LABEL[c]).join(' · ') : '아직 위험 신호가 없어요' });
  }

  // ② 사기 수법 단계 — 기관 사칭형 통화의 전형적인 흐름에서 어디까지 왔나
  if (suspicious && (authority || live.length >= 2)) {
    const demand = live.filter((x) => ACTION_CATEGORIES.includes(x.category)).sort((a, b) => (a.sources[0]?.startMs ?? 0) - (b.sources[0]?.startMs ?? 0))[0];
    out.push({
      kind: 'stages', id: 'stages', title: '사기 수법 단계로 보면',
      stages: [
        { label: familyClaim(s) && !authority ? '가족 자칭' : authority || !org ? '기관 자칭' : '회사 자칭', hit: Boolean(authority || person || org), quote: textOf((person ?? org)?.sources[0]?.utteranceId), atMs: at((person ?? org)?.sources[0]?.utteranceId) },
        { label: '겁주기', hit: Boolean(caseE || account || cats.has('unverifiable_case')), quote: textOf((caseE ?? account)?.sources[0]?.utteranceId), atMs: at((caseE ?? account)?.sources[0]?.utteranceId) },
        { label: '고립시키기', hit: cats.has('secrecy') || cats.has('isolation'), quote: textOf(firstOf('secrecy')?.sources[0]?.utteranceId), atMs: firstOf('secrecy')?.sources[0]?.startMs },
        { label: '서두르게 하기', hit: cats.has('time_pressure'), quote: textOf(firstOf('time_pressure')?.sources[0]?.utteranceId), atMs: firstOf('time_pressure')?.sources[0]?.startMs },
        { label: '돈·정보 요구', hit: Boolean(demand), quote: textOf(demand?.sources[0]?.utteranceId), atMs: demand?.sources[0]?.startMs },
      ],
    });
  }

  // ③ 돈의 흐름 — 송금 요구가 나오면
  const money = firstOf('money_transfer');
  if (money) {
    const t = textOf(money.sources[0]?.utteranceId) ?? '';
    const dest = /안전\s?계좌|안전한\s?계좌/.test(t) ? '상대가 말한 "안전계좌"' : /지정\s?계좌/.test(t) ? '상대가 지정한 계좌' : '상대가 말한 계좌';
    out.push({ kind: 'money', id: 'money', title: '요구받은 돈의 흐름', from: account ? '내 명의 계좌' : '내 돈', to: dest, amount: amount?.value, via: '전화로 요구', warn: true, note: authority ? '수사기관·금융기관은 전화로 이체를 요구하지 않아요' : '전화로 받은 계좌로 보내기 전에 직접 확인하세요' });
  }

  // ④ 결정적인 한마디 — 가장 위험한 요구를 크게
  const worst = firstOf('money_transfer') ?? firstOf('credential_request') ?? firstOf('remote_app');
  if (worst) {
    const u = s.utterances[worst.sources[0]?.utteranceId ?? ''];
    if (u) out.push({ kind: 'quote', id: 'quote', title: '결정적인 한마디', quote: u.text, speaker: u.label, atMs: u.startMs, note: `${worst.label} — 이 말이 나오면 멈추세요`, tone: 'danger' });
  }

  // ⑤ 통화 흐름 타임라인 — 핵심 순간 3개 이상일 때
  const events: { atMs: number; label: string; tone: FigTone; utteranceId?: string }[] = [];
  if (org) events.push({ atMs: at(org.sources[0]?.utteranceId) ?? 0, label: `${org.value}${person ? ` ${person.attrs.name ?? ''}` : ''} 자칭`, tone: 'claim', utteranceId: org.sources[0]?.utteranceId });
  if (caseE) events.push({ atMs: at(caseE.sources[0]?.utteranceId) ?? 0, label: `사건번호 ${caseE.value}`, tone: 'claim', utteranceId: caseE.sources[0]?.utteranceId });
  for (const c of ['secrecy', 'time_pressure', 'money_transfer', 'credential_request', 'remote_app'] as SignalCategory[]) {
    const f = firstOf(c);
    if (f) events.push({ atMs: f.sources[0]?.startMs ?? 0, label: SIGNAL_LABEL[c], tone: ACTION_CATEGORIES.includes(c) ? 'danger' : 'warn', utteranceId: f.sources[0]?.utteranceId });
  }
  if (s.domain === 'billing') for (const e of ents.filter((x) => ['amount', 'duration', 'date'].includes(x.type))) events.push({ atMs: at(e.sources[0]?.utteranceId) ?? 0, label: e.value, tone: 'info', utteranceId: e.sources[0]?.utteranceId });
  if (events.length >= 3) out.push({ kind: 'timeline', id: 'timeline', title: '통화 흐름', events: events.sort((a, b) => a.atMs - b.atMs) });

  // ⑥ 말 vs 사실 — 공식 안내·조회 결과와 대조
  const rows: Extract<Figure, { kind: 'compare' }>['rows'] = [];
  const ev = Object.values(s.evidence);
  const off = ev.find((e) => e.tier === 'official' && e.status === 'mismatch');
  if (off && (money || worst)) rows.push({ claim: `“${(textOf((money ?? worst)!.sources[0]?.utteranceId) ?? '').slice(0, 40)}”`, fact: off.quote ?? off.title, verdict: 'mismatch' });
  const caseEv = ev.find((e) => e.id.startsWith('ev:case:'));
  if (caseE && caseEv) rows.push({ claim: `사건번호 ${caseE.value}`, fact: caseEv.status === 'unverifiable' ? (caseEv.reason === 'no_source' ? '사건 조회는 본인 인증이 필요해요' : '공개 조회에서 찾지 못했어요') : '조회 결과 있음', verdict: caseEv.status === 'found' ? 'match' : 'unknown' });
  if (person && !routine) rows.push({ claim: `${person.value}`, fact: person.attrs.sub ?? '통화만으로는 본인인지 알 수 없어요', verdict: 'unknown' });
  if (s.domain === 'billing' && amount && tariff) {
    const n = Number(amount.attrs.won);
    rows.push({ claim: `월 ${amount.value}`, fact: `공식 요금표 월 ${tariff.monthly.toLocaleString('ko-KR')}원`, verdict: Math.abs(n - tariff.monthly) / tariff.monthly <= 0.1 ? 'match' : 'mismatch' });
  }
  if (rows.length >= 1) out.push({ kind: 'compare', id: 'compare', title: '들은 말 vs 확인한 사실', rows });

  // ⑦ 요금 막대 — 숫자로 비교
  if (s.domain === 'billing' && amount) {
    const n = Number(amount.attrs.won);
    // 같은 말 안에 금액과 기간이 함께 있을 때만 총액을 계산한다 (실기: "약정 8개월 남아서"를 새 요금 × 8개월로 계산)
    const months = Number(ents.find((e) => e.type === 'duration' && e.sources[0]?.utteranceId === amount.sources[0]?.utteranceId)?.attrs.months ?? NaN);
    const bars: Extract<Figure, { kind: 'bars' }>['bars'] = [{ label: '상담원이 말한 월 요금', value: n, tone: amount.attrs.estimate === 'true' ? 'claim' : 'neutral', note: amount.attrs.estimate === 'true' ? '정도 = 예상' : undefined }];
    if (tariff) bars.push({ label: '공식 요금표 월 요금', value: tariff.monthly, tone: 'ok' });
    // 내가 말한 지금 요금과 나란히 (막대 하나로는 비교가 안 된다)
    const mine = ents.find((e) => e.type === 'amount' && spk(e) === 'me' && e !== amount && Number(e.attrs.won) > 0);
    if (mine) bars.unshift({ label: '내가 말한 지금 요금', value: Number(mine.attrs.won), tone: 'neutral' });
    if (bars.length >= 2) out.push({ kind: 'bars', id: 'bars', title: '월 요금 비교', unit: '원', bars });
    if (Number.isFinite(months)) out.push({ kind: 'bars', id: 'bars-total', title: `약정 ${months}개월 총액 감 잡기`, unit: '원', bars: [{ label: `월 ${amount.value} × ${months}개월`, value: n * months, tone: 'info', note: '설치비·위약금 제외' }] });
  }

  // ⑧ 할 일 체크리스트
  const items: Extract<Figure, { kind: 'checklist' }>['items'] = [];
  if ((authority || person) && !routine) items.push(familyClaim(s) && !authority ? { text: '끊고 원래 알던 가족 번호로 다시 걸기', done: false, why: '목소리만으로는 가족인지 알 수 없어요' } : { text: '통화를 끊고 직접 찾은 대표번호로 다시 걸기', done: false, why: '통화만으로는 본인인지 알 수 없어요' });
  if (cats.has('money_transfer')) items.push({ text: '송금하지 않기', done: false });
  if (cats.has('credential_request')) items.push({ text: '인증번호·비밀번호 알려주지 않기', done: false });
  if (cats.has('remote_app')) items.push({ text: '링크 누르거나 앱 설치하지 않기', done: false });
  const said = s.utteranceOrder.map((id) => s.utterances[id]?.text ?? '').join(' ');
  if (s.domain === 'billing') for (const w of ['위약금', '설치비', '요금에 포함된 항목']) items.push({ text: `${w} 물어보기`, done: said.includes(w.replace('요금에 포함된 항목', '포함')) });
  for (const sg of s.suggestions.filter((x) => x.kind === 'ask')) if (!items.some((i) => i.text === sg.text)) items.push({ text: sg.text, done: false, why: sg.why });
  if (items.length >= 2) out.push({ kind: 'checklist', id: 'checklist', title: '지금 할 일', items: items.slice(0, 6) });

  // ⑨ 위험 레이더 — 다섯 축이 얼마나 부풀었나 (신호 수 + Jev 확률)
  if (live.length >= 2) {
    const score = (cs: SignalCategory[]) => Math.min(1, live.filter((x) => cs.includes(x.category)).reduce((a, x) => a + Math.max(0.5, x.d1Prob ?? x.confidence), 0) / 1.6);
    out.push({ kind: 'radar', id: 'radar', title: '위험 모양', axes: [
      { label: '사칭', value: Math.max(score(['impersonation', 'unverifiable_case']), authority ? 0.35 : org ? 0.25 : 0) },
      { label: '고립', value: score(['secrecy', 'isolation']) },
      { label: '압박', value: score(['time_pressure']) },
      { label: '금전', value: score(['money_transfer']) },
      { label: '정보', value: score(['credential_request', 'remote_app', 'official_mismatch']) },
    ] });
  }

  // ⑩ 통화 온도 띠 — 상대 발화마다 얼마나 뜨거웠나
  const others = s.utteranceOrder.map((id) => s.utterances[id]!).filter((u) => u && u.speaker === 'other' && u.status !== 'interim');
  if (others.length >= 3) {
    out.push({ kind: 'heat', id: 'heat', title: '통화 온도', cells: others.map((u) => {
      const sig = live.filter((x) => x.sources.some((y) => y.utteranceId === u.id)).map((x) => x.category);
      const level = sig.some((c) => ACTION_CATEGORIES.includes(c)) ? 3 : sig.some((c) => c === 'secrecy' || c === 'time_pressure') ? 2 : ents.some((e) => (e.type === 'org' || e.type === 'person' || e.type === 'case') && e.sources.some((y) => y.utteranceId === u.id)) ? 1 : 0;
      return { label: u.text.slice(0, 24), level: level as 0 | 1 | 2 | 3, atMs: u.startMs, utteranceId: u.id };
    }) });
  }

  // ⑪ 반복된 말 — 압박 표현을 몇 번이나 했나
  const PHRASES: [RegExp, string, FigTone][] = [[/지금\s?바로|당장/g, '지금 바로', 'warn'], [/오늘\s?안에/g, '오늘 안에', 'warn'], [/시간이\s?없/g, '시간이 없다', 'warn'], [/(외부|가족|아무|은행|주변)\S*\s?(에게도|에는|에)?\s?말(씀)?하(시|지)/g, '말하지 마라', 'danger'], [/다른\s?곳에\s?(전화|연락)/g, '다른 곳에 연락 마라', 'danger'], [/안전\s?(한)?\s?계좌/g, '안전계좌', 'danger'], [/인증\s?번호/g, '인증번호', 'danger'], [/협조/g, '협조', 'claim'], [/범죄|연루|대포/g, '범죄 연루', 'claim'], [/환급|미환급/g, '환급', 'claim']];
  const otherText = others.map((u) => u.text).join(' ');
  const words = PHRASES.map(([re, text, tone]) => ({ text, count: (otherText.match(re) ?? []).length, tone })).filter((w) => w.count > 0).sort((a, b) => b.count - a.count);
  if (words.length >= 3 || words.some((w) => w.count >= 2)) out.push({ kind: 'bubbles', id: 'bubbles', title: '상대가 반복한 말', words });

  // ⑫ 믿을 근거 vs 의심 근거 저울 — 기관을 자칭한 통화
  if ((authority || person) && !routine) {
    const trust: string[] = [];
    if (/대표번호로|공식\s?홈페이지|직접\s?(전화|확인)/.test(otherText)) trust.push('상대가 직접 확인해 보라고 함');
    if (/조정\s?가능|편하신|방문/.test(otherText)) trust.push('일정 조정·방문을 제안함');
    if (/절대\s?(물어보지|요구하지)\s?않/.test(otherText)) trust.push('비밀번호를 묻지 않는다고 밝힘');
    if (!live.some((x) => ACTION_CATEGORIES.includes(x.category))) trust.push('돈·정보 요구 없음');
    const doubt = [...new Set(live.map((x) => x.label))];
    if (person) doubt.push('통화만으로는 본인 확인 불가');
    out.push({ kind: 'balance', id: 'balance', title: '믿을 근거 vs 의심 근거', left: { title: '믿을 근거', items: trust }, right: { title: '의심 근거', items: doubt } });
  }

  // ⑬ 지금 할 일 결정 나무 — 지금 해당하는 길이 빛난다
  if (suspicious || authority) {
    const asked = live.some((x) => ACTION_CATEGORIES.includes(x.category));
    const claimed = Boolean(authority || person);
    const pressed = cats.has('secrecy') || cats.has('time_pressure');
    const root: TreeNode = {
      label: '돈·인증번호·앱 설치를 요구했나?', active: true,
      yes: { label: '멈추고 끊기 → 직접 찾은 번호로 확인', tone: 'danger', active: asked },
      no: {
        label: '기관·회사를 자칭했나?', active: !asked,
        yes: { label: pressed ? '비밀·재촉이 있다 → 다시 걸어 확인' : '다시 걸어 본인 확인', tone: pressed ? 'warn' : 'info', active: !asked && claimed },
        no: { label: '필요한 것만 묻고 기록 남기기', tone: 'ok', active: !asked && !claimed },
      },
    };
    out.push({ kind: 'tree', id: 'tree', title: '지금 어떻게 하면 될까', root });
  }

  return out;
}
