import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { Entity, RiskSignal } from '@eary/schema';
import { soften, scrubPhones, withParticle, warningHeadline, toIcs, createBoard, createL0, computeLevel, JsonArrayStreamer, nextRisk, EMPTY_RISK, syncEntity, applyBoardPatch, route } from '../src';
import { loadPacks } from '../src/load';

const packs = loadPacks(join(import.meta.dir, '../../../data'));
const l0 = createL0(packs.lexicon, Object.values(packs.domains));

describe('L0', () => {
  test('사칭 첫 발화: 기관·인물·내 계좌, 도메인 추측', () => {
    const r = l0.scan('서울중앙지검 소속 홍길동 검사입니다. 본인 명의 계좌가 범죄에 연루되어 연락드렸습니다.');
    const keys = r.entities.map((e) => e.key);
    expect(keys).toContain('org:서울중앙지검');
    expect(keys).toContain('person:홍길동');
    expect(keys).toContain('account:me');
    expect(r.domainGuess).toBe('impersonation');
    const person = r.entities.find((e) => e.type === 'person')!;
    expect(person.value).toBe('홍길동 검사');
  });

  test('별칭과 띄어쓰기 변형도 같은 키', () => {
    const r = l0.scan('서울 중앙 지방 검찰청 에서 연락 드렸습니다');
    expect(r.entities[0]?.key).toBe('org:서울중앙지검');
  });

  test('STT 한 글자 오인식 허용 (실측: "서울중앙직검")', () => {
    const r = l0.scan('서울중앙직검 소속 홍길 동검사입니다');
    const org = r.entities.find((e) => e.type === 'org')!;
    expect(org.key).toBe('org:서울중앙지검');
    expect(org.confidence).toBeLessThan(0.9);
    expect(r.entities.find((e) => e.type === 'person')?.key).toBe('person:홍길동');
    expect(l0.scan('서울에서 중앙으로 갑니다').entities.filter((e) => e.type === 'org')).toHaveLength(0);
  });

  test('실제 RTZR 출력 (2026-10-24 실측) 그대로', () => {
    const c = l0.scan('2026 현제 4만 8271호입니다 가족에게도 말씀하지 마세요');
    expect(c.entities.find((e) => e.type === 'case')?.key).toBe('case:2026형제48271');
    expect(c.signals.map((s) => s.category)).toContain('secrecy');
    expect(l0.scan('계좌가 동결되기 전에 안전 계좌로 지금 바로 이체하셔야 합니다').signals.map((s) => s.category)).toContain('money_transfer');
    expect(l0.scan('수사중인 사건이라 외부에 말씀하시면 안됩니다 지금 협조해주셔야 합니다').signals.map((s) => s.category)).toEqual(expect.arrayContaining(['secrecy', 'time_pressure']));
    expect(l0.scan('오늘 안에 확인이 끝나야 합니다 다른 곳에 전화하지 마세요').entities.filter((e) => e.type === 'date')).toHaveLength(0);
  });

  test('사건번호 정규화 + 형광펜 원문 위치', () => {
    const text = '2026 형제 48271호입니다. 가족에게도 말씀하지 마세요.';
    const r = l0.scan(text);
    expect(r.entities.find((e) => e.type === 'case')?.key).toBe('case:2026형제48271');
    expect(r.signals.map((s) => s.category)).toContain('secrecy');
    const red = r.marks.find((m) => m.tone === 'red')!;
    expect(text.slice(red.start, red.end)).toBe('가족에게도 말씀하지');
  });

  test('행동 신호', () => {
    const cats = l0.scan('안전계좌로 지금 바로 이체하셔야 합니다. 문자로 가는 인증번호도 바로 불러주세요.').signals.map((s) => s.category);
    expect(cats).toContain('money_transfer');
    expect(cats).toContain('credential_request');
    expect(cats).toContain('time_pressure');
  });

  test('요금 상담: 금액·기간, 예상 비용 표시', () => {
    const r = l0.scan('36개월 약정이고, 두 상품을 결합하시면 월 12만 원 정도 나옵니다.');
    const amount = r.entities.find((e) => e.type === 'amount')!;
    expect(amount.key).toBe('amount:120000');
    expect(amount.attrs.estimate).toBe('true');
    expect(r.entities.some((e) => e.key === 'duration:36개월')).toBe(true);
    expect(r.domainGuess).toBe('billing');
    // 일반 팩과 공유하는 금액 패턴 때문에 동점이 나도 요금으로 (회귀)
    expect(l0.scan('두 상품을 결합하시면 월 12만 원 정도 나옵니다.').domainGuess).toBe('billing');
  });

  test('1ms 미만', () => {
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) l0.scan('계좌가 동결되기 전에 안전계좌로 지금 바로 이체하셔야 합니다. 서울중앙지검 홍길동 검사입니다.');
    expect((performance.now() - t0) / 200).toBeLessThan(1);
  });
});

const sig = (category: RiskSignal['category'], confirmed = true): RiskSignal => ({
  id: `s-${category}`, category, label: category, origin: ['L0'], confirmed, confidence: 0.9, sources: [], explanation: '', active: true,
});

describe('Risk', () => {
  test('디자인 단계: 주의 → 누적 → 최종', () => {
    const g = { domain: 'impersonation' as const, gate: [] };
    expect(computeLevel({ ...g, signals: [sig('secrecy'), sig('time_pressure'), sig('impersonation')] }).level).toBe('caution');
    expect(computeLevel({ ...g, signals: [sig('secrecy'), sig('time_pressure'), sig('impersonation'), sig('unverifiable_case')] }).level).toBe('accumulating');
    expect(computeLevel({ ...g, signals: [sig('secrecy'), sig('time_pressure'), sig('impersonation'), sig('money_transfer')] }).level).toBe('final');
  });

  test('잠정(L0만) 신호는 세지 않는다', () => {
    expect(computeLevel({ domain: 'impersonation', gate: [], signals: [sig('secrecy', false)] }).level).toBe('none');
  });

  test('요금 도메인 게이트: "오늘 가입하시면 할인"은 경고 아님', () => {
    expect(computeLevel({ domain: 'billing', gate: ['time_pressure', 'secrecy'], signals: [sig('time_pressure')] }).level).toBe('none');
    // 행동 신호가 나오면 게이트가 풀린다
    expect(computeLevel({ domain: 'billing', gate: ['time_pressure', 'secrecy'], signals: [sig('time_pressure'), sig('secrecy'), sig('money_transfer')] }).level).toBe('final');
  });

  test('단계는 내려가지 않는다 (고치기 예외)', () => {
    const g = { domain: 'impersonation' as const, gate: [] };
    const r1 = nextRisk(EMPTY_RISK, { ...g, signals: [sig('secrecy')] }, 100);
    expect(r1.level).toBe('caution');
    expect(nextRisk(r1, { ...g, signals: [] }, 200).level).toBe('caution');
    expect(nextRisk(r1, { ...g, signals: [] }, 200, true).level).toBe('none');
  });
});

const ent = (key: string, type: Entity['type'], value: string, certainty: Entity['certainty'] = 'claimed', attrs: Record<string, string> = {}): Entity => ({
  key, type, value, attrs, certainty, confidence: 0.9, origin: ['L0'], sources: [],
});

describe('Board placer', () => {
  const tpl = packs.templates['impersonation.entityMap']!;

  test('디자인 좌표 그대로 슬롯에 놓이고, 양 끝이 확정되면 연결선', () => {
    let b = createBoard(tpl, 'b1', 0);
    for (const e of [ent('org:서울중앙지검', 'org', '서울중앙지검'), ent('person:홍길동', 'person', '홍길동 검사'), ent('case:2026형제48271', 'case', '2026형제48271호'), ent('account:me', 'account', '내 명의 계좌', 'claimed', { owner: 'me' })]) {
      for (const p of syncEntity(b, tpl, e, 0)) b = applyBoardPatch(b, p, 0);
    }
    expect(b.placed['card:org:서울중앙지검']).toEqual({ id: 'card:org:서울중앙지검', x: 32, y: 32, w: 220, h: 112 });
    expect(b.placed['card:case:2026형제48271']).toMatchObject({ x: 352, y: 194 });
    expect(Object.keys(b.edges).sort()).toEqual(['edge:case->me_account', 'edge:org->person', 'edge:person->case']);
    // 사건 → 내 계좌: ㄱ자 (디자인: x≈478 세로, y≈410 가로)
    expect(b.edges['edge:case->me_account']!.path).toBe('M 482 318 L 482 410 L 640 410');
    const acc = b.els['card:account:me'];
    expect(acc?.kind === 'card' && acc.style).toBe('me');
  });

  test('잠정 카드는 선 없음 → 확정되면 선 + "방금 추가" 배지, 위치는 그대로', () => {
    let b = createBoard(tpl, 'b1', 0);
    for (const p of syncEntity(b, tpl, ent('org:서울중앙지검', 'org', '서울중앙지검'), 0)) b = applyBoardPatch(b, p, 0);
    for (const p of syncEntity(b, tpl, ent('person:홍길동', 'person', '홍길동 검사', 'provisional'), 0)) b = applyBoardPatch(b, p, 0);
    expect(Object.keys(b.edges)).toHaveLength(0);
    const before = b.placed['card:person:홍길동'];
    const patches = syncEntity(b, tpl, ent('person:홍길동', 'person', '홍길동 검사'), 500);
    for (const p of patches) b = applyBoardPatch(b, p, 500);
    expect(b.placed['card:person:홍길동']).toEqual(before!);
    expect(b.badges['card:person:홍길동']?.text).toBe('방금 추가');
    expect(Object.keys(b.edges)).toEqual(['edge:org->person']);
  });

  test('같은 입력이면 같은 결과 (결정론), 같은 값 재적용은 op 없음', () => {
    const b = createBoard(tpl, 'b1', 0);
    const e = ent('org:서울중앙지검', 'org', '서울중앙지검');
    expect(syncEntity(b, tpl, e, 0)).toEqual(syncEntity(b, tpl, e, 0));
    let b2 = b;
    for (const p of syncEntity(b, tpl, e, 0)) b2 = applyBoardPatch(b2, p, 0);
    expect(syncEntity(b2, tpl, e, 10)).toEqual([]);
  });

  test('사칭 보드 넘침 구역은 요구·조건 카드를 받지 않는다', () => {
    const b = createBoard(tpl, 'b1', 0);
    expect(syncEntity(b, tpl, ent('demand:다른곳에전화금지', 'demand', '다른 곳에 전화 금지'), 0)).toEqual([]);
    expect(syncEntity(b, tpl, ent('org:금융감독원', 'org', '금융감독원'), 0).length).toBeGreaterThan(0);
  });

  test('general 템플릿: 3열 격자', () => {
    const g = packs.templates['general.facts']!;
    let b = createBoard(g, 'g', 0);
    const es = [ent('amount:120000', 'amount', '12만 원 정도'), ent('duration:36개월', 'duration', '36개월'), ent('date:다음주중', 'date', '다음 주 중'), ent('product:인터넷', 'product', '인터넷')];
    for (const e of es) for (const p of syncEntity(b, g, e, 0)) b = applyBoardPatch(b, p, 0);
    expect(b.placed['card:date:다음주중']).toMatchObject({ x: 32 + 2 * (256 + 24), y: 32 });
    expect(b.placed['card:product:인터넷']).toMatchObject({ x: 32, y: 32 + 104 + 24 });
  });

  test('직선 라우팅', () => {
    expect(route({ x: 32, y: 32, w: 220, h: 112 }, { x: 32, y: 200, w: 220, h: 112 }).path).toBe('M 142 144 L 142 200');
  });
});

describe('JsonArrayStreamer', () => {
  test('원소가 닫히는 순간 하나씩 내보낸다', () => {
    const got: [string, unknown][] = [];
    const s = new JsonArrayStreamer((f, item) => got.push([f, item]));
    const full = '{"entities":[{"type":"org","value":"서울중앙지검","quote":"서울중앙지검"},{"type":"person","value":"홍길동 {검사}"}],"claims":[{"subject":"a"}]}';
    for (let i = 0; i < full.length; i += 7) s.push(full.slice(i, i + 7));
    expect(got.map(([f]) => f)).toEqual(['entities', 'entities', 'claims']);
    expect((got[1]![1] as { value: string }).value).toBe('홍길동 {검사}');
  });
});

describe('자유 실행 보강 (실측)', () => {
  test('한국어 금액 단위 합산', () => {
    const r = l0.scan('미환급금 23만 4천원이 있어서 연락드렸어요');
    expect(r.entities.find((e) => e.type === 'amount')?.key).toBe('amount:234000');
    expect(l0.scan('월 118,000원입니다').entities.find((e) => e.type === 'amount')?.key).toBe('amount:118000');
  });
  test('행동 요구가 서로 다른 둘이면 최종', () => {
    expect(computeLevel({ domain: 'impersonation', gate: [], signals: [sig('remote_app'), sig('credential_request')] }).level).toBe('final');
    expect(computeLevel({ domain: 'impersonation', gate: [], signals: [sig('remote_app')] }).level).toBe('caution');
  });
});

describe('최종 경고 문구·ICS', () => {
  test('요구 종류별 제목', () => {
    expect(warningHeadline(['money_transfer', 'credential_request'])).toBe('지금 송금하거나 인증번호를 알려주지 마세요');
    expect(warningHeadline(['remote_app', 'credential_request'])).toBe('앱을 설치하거나 비밀번호·인증번호를 알려주지 마세요');
    expect(warningHeadline(['remote_app'])).toBe('링크를 누르거나 앱을 설치하지 마세요');
  });
  test('ICS 형식', () => {
    const ics = toIcs({ title: '은행 문의', startIso: '2026-10-26T00:00:00.000Z', memo: 'm' });
    expect(ics).toContain('DTSTART:20261026T000000Z');
    expect(ics.split('\r\n')[0]).toBe('BEGIN:VCALENDAR');
  });
});

test('조사', () => {
  expect(withParticle('서울중앙지검 홍길동 검사', '을', '를')).toBe('서울중앙지검 홍길동 검사를');
  expect(withParticle('국민건강보험공단', '을', '를')).toBe('국민건강보험공단을');
  expect(withParticle('KT', '을', '를')).toBe('KT를');
});

describe('전화번호 안전장치 (실측 회귀)', () => {
  test('검색 결과의 업체 번호는 지우고 공식 번호만 남긴다', () => {
    const r = scrubPhones('전화 끊고, 직접 ‘찐센터’ (010‑3570‑8242) 같은 공식 번호로 확인해 보세요. 급하면 112, 금감원 1332.');
    expect(r.text).not.toContain('3570');
    expect(r.text).toContain('112');
    expect(r.text).toContain('1332');
    expect(r.removed).toHaveLength(1);
    expect(scrubPhones('서울중앙지검 공식 대표번호(02-530-3114)로 문의').text).not.toContain('530');
    expect(scrubPhones('국민건강보험공단 1577-1000').text).toContain('1577-1000');
    expect(scrubPhones('사건번호 2026형제48271호, 23만 4천원').text).toBe('사건번호 2026형제48271호, 23만 4천원');
  });
});

test('단정 표현 누그러뜨리기 (실측: "보이스피싱입니다! 즉시 전화를 끊고…")', () => {
  expect(soften('보이스피싱입니다! 즉시 전화를 끊고 112나 1332로 신고하세요!')).toBe('보이스피싱이 의심돼요. 즉시 전화를 끊고 112나 1332로 신고하세요.');
  expect(soften('확실히 사기예요')).toBeNull();
  expect(soften('이건 사기입니다.')).toBe('이건 사기가 의심돼요.');
  expect(soften('공식 대표번호로 직접 확인하세요')).toBe('공식 대표번호로 직접 확인하세요');
});
