// 골든 시나리오: 서버 파이프라인 전체(L0 → 검증 → 위험 → 보드)를 대본 발화 단위로 돌린다. (§17.2)
// D1/L1 없이(결정론 예비 경로) 돌려서 언제나 같은 결과가 나와야 한다.
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { applyOps, createL0, initialState } from '@eary/core';
import { loadPacks, loadYaml } from '@eary/core/src/load';
import { SCENARIOS } from '@eary/scenario';
import type { CallState, S2C, Scenario } from '@eary/schema';
import { FastLlm } from '../src/fastLlm';
import { JevClient } from '../src/jev';
import { RtzrAuth } from '../src/rtzr';
import { CallSession } from '../src/session';
import { createVerifier, type MockData } from '../src/verify';

const DATA = join(import.meta.dir, '../../../data');
const packs = loadPacks(DATA);
const l0 = createL0(packs.lexicon, Object.values(packs.domains));
const verifier = createVerifier(loadYaml<MockData>(join(DATA, 'mock/lookups.yaml')));
const settle = () => new Promise((r) => setTimeout(r, 450)); // 가상 조회 350ms + 여유

function harness(jevKey?: string) {
  let client: CallState = initialState('x');
  const session = new CallSession({
    packs, l0, jev: new JevClient(jevKey), l1: new FastLlm({}), verifier, rtzr: new RtzrAuth(undefined, undefined), audioDir: '',
    send: (m: S2C) => { if (m.t === 'ops') client = applyOps(client, m.ops); if (m.t === 'welcome') client = m.snapshot; },
  });
  return { session, client: () => client };
}

async function runSteps(sc: Scenario, h: ReturnType<typeof harness>, onStep: (step: number) => void) {
  h.session.start('replay-fixture', undefined, true, sc.callerNumber);
  let i = 0;
  for (const step of sc.steps) {
    for (const u of step.utterances) {
      const id = `u${++i}`;
      h.session.onInterim(id, u.speaker, u.text.slice(0, Math.ceil(u.text.length / 2)), u.atMs);
      h.session.onFinal(id, u.speaker, u.text, u.atMs, u.atMs + 1000);
      await settle();
    }
    await new Promise((r) => setTimeout(r, 20)); // op 묶음 flush
    onStep(step.step);
  }
}

describe('impersonation-01 (결정론)', () => {
  test('단계 기대값 + 서버·클라이언트 상태 일치 + 보드', async () => {
    const sc = SCENARIOS['impersonation-01']!;
    const h = harness();
    const seen: Record<number, string> = {};
    await runSteps(sc, h, (n) => {
      const step = sc.steps.find((s) => s.step === n)!;
      seen[n] = h.session.state.risk.level;
      if (step.expect?.risk) expect(`${n}:${h.session.state.risk.level}`).toBe(`${n}:${step.expect.risk}`);
      for (const k of step.expect?.entities ?? []) expect(h.session.state.entities[k]?.certainty).not.toBe('provisional');
      for (const c of step.expect?.signals ?? []) expect(h.session.state.risk.activeCategories).toContain(c);
    });
    const s = h.session.state;
    // 클라이언트가 op만으로 만든 상태 = 서버 상태 (동형 리듀서)
    expect(JSON.stringify(h.client().risk)).toBe(JSON.stringify(s.risk));
    expect(JSON.stringify(h.client().boards)).toBe(JSON.stringify(s.boards));

    const board = s.boards['board:impersonation.entityMap']!;
    expect(board).toBeDefined();
    const org = board.els['card:org:서울중앙지검'];
    expect(org?.kind === 'card' && org.pills.map((p) => p.text)).toContain('목록에 없음');
    expect(board.els['callout:ev:case:case:2026형제48271']).toBeDefined();
    expect(board.els['callout:ev:official']).toBeDefined();
    expect(Object.keys(board.edges)).toEqual(expect.arrayContaining(['edge:org->person', 'edge:person->case', 'edge:case->me_account']));
    // 고도화: 요구 카드(나오는 순서대로, 겹치지 않게) + "나에게 요구" + 범례
    expect(board.els['demand:money_transfer']?.kind === 'card' && board.els['demand:money_transfer'].style).toBe('demand');
    expect(board.els['demand:credential_request']).toBeDefined();
    const d1 = board.placed['demand:money_transfer']!, d2 = board.placed['demand:credential_request']!;
    expect(d2.y).toBeGreaterThanOrEqual(d1.y + d1.h);
    expect(board.edges['edge:demands->me']?.label).toBe('나에게 요구');
    expect(board.els['hand:legend']).toBeDefined();
    expect(s.risk.finalWarning?.reasons.length).toBeGreaterThanOrEqual(3);
    expect(s.situation.text).toBe('상대가 송금과 인증번호 전달을 직접 요구하고 있어요');
    expect(s.suggestions[0]?.id).toBe('dont_transfer');
    expect(s.risk.history.map((x) => x.level)).toEqual(['caution', 'accumulating', 'final']);
    console.log('단계별:', seen, '\n신호:', s.risk.activeCategories.join(', '));
  }, 20000);
});

describe('billing-01 대조군', () => {
  test('정상 통화: 경고 0, 금액·기간 카드', async () => {
    const sc = SCENARIOS['billing-01']!;
    const h = harness();
    await runSteps(sc, h, () => {});
    const s = h.session.state;
    expect(s.risk.level).toBe('none');
    // 요금 비교 보드 (디자인 5·11번)
    const board = s.boards['board:billing.compare']!;
    expect(board).toBeDefined();
    expect(s.activeBoardId).toBe('board:billing.compare');
    const tbl = board.els['tbl:compare'];
    expect(tbl?.kind === 'table' && tbl.rows.map((r) => r.cells.slice(0, 2).join(':'))).toEqual(['월 요금:‘12만 원 정도’', '약정:36개월', '설치:다음 주 중', '설치비:아직 안내 없음', '위약금:아직 안내 없음']);
    expect(tbl?.kind === 'table' && tbl.rows[0]!.cells[3]).toBe('범위 안'); // 12만 vs 가상 요금표 118,000원
    expect(board.els['hand:estimate']).toBeDefined();
    const todo = board.els['co:todo'];
    expect(todo?.kind === 'callout' && todo.body).toBe('위약금\n설치비\n요금에 포함된 항목');
    const banner = board.els['banner:total'];
    expect(banner?.kind === 'banner' && banner.text).toContain('= 약 432만 원');
    expect(Object.keys(board.edges)).toEqual(expect.arrayContaining(['edge:step:apply->step:visit', 'edge:step:visit->step:bill']));
  }, 20000);
});

describe('interim 흔들림', () => {
  test('말하는 중인 사건번호는 슬롯을 차지하지 않고, final 뒤 카드는 하나', async () => {
    const h = harness();
    h.session.start('replay-fixture');
    for (const part of ['2026형제48', '2026형제4827', '2026형제48271호입니다']) h.session.onInterim('u1', 'other', part, 0);
    h.session.onFinal('u1', 'other', '2026형제48271호입니다. 가족에게도 말씀하지 마세요.', 0, 1000);
    await settle();
    const board = Object.values(h.session.state.boards)[0]!;
    const cases = Object.values(board.els).filter((e) => e.kind === 'card' && e.entityKey?.startsWith('case:'));
    expect(cases.map((c) => c.id)).toEqual(['card:case:2026형제48271']);
    expect(Object.values(h.session.state.entities).filter((e) => e.certainty === 'provisional')).toHaveLength(0);
  });
});

describe('L1 안전장치 (실측 회귀)', () => {
  test('L1이 사건번호·날짜를 지어내도 보드·위험 단계에 들어가지 않고, 기관명은 같은 키로 합쳐진다', async () => {
    let client: CallState = initialState('x');
    // 2026-10-24 실측 L1 출력을 그대로 흉내 낸다
    const fakeL1 = {
      enabled: true, available: true, model: 'fake',
      async extract(_c: string, last: string, onEntity: (e: { type: string; value: string; quote: string; name?: string }) => void) {
        if (last.includes('범주')) onEntity({ type: 'case', value: '범주', quote: '범주' });
        if (last.includes('서울중앙지검')) onEntity({ type: 'org', value: '서울중앙지방검찰청', quote: '서울중앙지검' });
        if (last.includes('오늘')) onEntity({ type: 'date', value: '오늘', quote: '오늘' });
        if (last.includes('전화하지')) onEntity({ type: 'demand', value: '다른 곳에 전화 금지', quote: '다른 곳에 전화하지 마세요' });
        return { firstMs: 1, totalMs: 1 };
      },
    } as unknown as FastLlm;
    const session = new CallSession({ packs, l0, jev: new JevClient(undefined), l1: fakeL1, verifier, rtzr: new RtzrAuth(undefined, undefined), audioDir: '', send: (m: S2C) => { if (m.t === 'ops') client = applyOps(client, m.ops); } });
    session.start('replay-fixture');
    session.onFinal('o1', 'other', '서울중앙지검 소속 홍길동 검사입니다 본인 명의 계좌가 범주에 연루되어 연락드렸습니다', 0, 1000);
    await settle();
    session.onFinal('o2', 'other', '오늘 안에 확인이 끝나야 합니다 다른 곳에 전화하지 마세요', 2000, 3000);
    await settle();
    const s = session.state;
    expect(Object.keys(s.entities).filter((k) => k.startsWith('case:'))).toEqual([]);
    expect(Object.keys(s.entities).filter((k) => k.startsWith('date:'))).toEqual([]);
    expect(Object.keys(s.entities).filter((k) => k.startsWith('org:'))).toEqual(['org:서울중앙지검']);
    expect(s.risk.activeCategories).not.toContain('unverifiable_case');
    expect(s.risk.level).toBe('caution');
    const board = s.boards['board:impersonation.entityMap']!;
    expect(Object.keys(board.els).some((k) => k.includes('demand'))).toBe(false);
  });
});

describe('통화 종료 리뷰 (결정론)', () => {
  test('사칭 대본 → 리뷰·미확인·일정·신고 준비안', async () => {
    const sc = SCENARIOS['impersonation-01']!;
    const h = harness();
    await runSteps(sc, h, () => {});
    h.session.handle({ t: 'call.end' });
    await new Promise((r) => setTimeout(r, 30));
    const r = h.client().review!;
    expect(r).toBeDefined();
    expect(r.title).toBe('수사기관 사칭이 의심되는 통화 · 최종 경고 1회');
    expect(r.summary.by).toBe('rule');
    expect(r.moments.map((m) => m.level ?? '-')).toContain('final');
    expect(r.moments[0]!.title).toBe('서울중앙지검 소속이라고 밝힘');
    expect(r.open.map((o) => o.title)).toEqual(expect.arrayContaining(['발신 번호의 실제 소유자', '비공개로 진행 중인 사건 여부', '내 계좌의 이상 여부']));
    expect(r.calendar?.title).toBe('거래 은행에 계좌 이상 여부 문의');
    const f = Object.fromEntries(r.report!.fields.map((x) => [x.label, x]));
    expect(f['상대가 밝힌 신원']!.value).toBe('서울중앙지검 소속 홍길동 검사');
    expect(f['상대가 밝힌 신원']!.note).toBe('확인되지 않음');
    expect(f['요구 사항']!.value).toContain('송금 요구');
    expect(f['요구 사항']!.refs.length).toBeGreaterThan(0);
    // 개인정보 자동 제외
    expect(JSON.stringify(r.report)).not.toContain('계좌번호:');
    expect(r.report!.excluded).toContain('자동으로 넣지 않았어요');
  }, 20000);

  test('요금 대조군 → 신고 준비안 없음, 확인 못 한 것에 위약금·설치비', async () => {
    const h = harness();
    await runSteps(SCENARIOS['billing-01']!, h, () => {});
    h.session.handle({ t: 'call.end' });
    await new Promise((r) => setTimeout(r, 30));
    const r = h.client().review!;
    expect(r.report).toBeUndefined();
    expect(r.title).toBe('요금·가입 상담 통화');
    expect(r.open.map((o) => o.title)).toEqual(expect.arrayContaining(['최종 월 요금', '위약금', '설치비']));
  }, 20000);
});

describe('발언 고치기 (디자인 12번)', () => {
  test('오인식을 고치면 그 발언에서 나온 신호가 꺼지고, 이 경우에만 단계가 내려간다', async () => {
    const h = harness();
    h.session.start('replay-fixture');
    h.session.onFinal('o1', 'other', '수사 중이라 외부에 말씀하시면 안 됩니다', 0, 1000);
    await settle();
    expect(h.session.state.risk.level).toBe('caution');
    // 실제로는 "외부 기관에 말씀하셔도 됩니다"였다
    h.session.handle({ t: 'utterance.edit', utteranceId: 'o1', text: '외부 기관에 말씀하셔도 됩니다' });
    await settle();
    expect(h.session.state.utterances.o1!.status).toBe('edited');
    expect(h.session.state.utterances.o1!.rev).toBe(1);
    expect(h.session.state.risk.level).toBe('none');
    expect(h.session.state.risk.history.at(-1)?.level).toBe('none'); // 내려간 사실도 기록
  });

  test('화자 바꾸기: 상대로 잘못 들어간 내 말의 위험 신호는 꺼진다', async () => {
    const h = harness();
    h.session.start('replay-fixture');
    h.session.onFinal('o1', 'other', '지금 바로 이체하셔야 하나요?', 0, 1000);
    await settle();
    expect(h.session.state.risk.activeCategories).toContain('money_transfer');
    h.session.handle({ t: 'utterance.speaker', utteranceId: 'o1', speaker: 'me' });
    await settle();
    const u = h.session.state.utterances.o1!;
    expect([u.speaker, u.label, u.speakerSource, u.status]).toEqual(['me', '나', 'user', 'final']);
    expect(h.session.state.risk.activeCategories).not.toContain('money_transfer');
    expect(h.session.state.risk.level).toBe('none');
  });
});
