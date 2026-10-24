import { describe, expect, test } from 'bun:test';
import type { Board, BoardPatch } from '@eary/schema';
import { applyBoardPatch, createCanvas, link, upsertChild, upsertSection } from '../src';

const apply = (b: Board, ps: BoardPatch[]) => ps.reduce((acc, p) => applyBoardPatch(acc, p, 0), b);
const item = (section: string, id: string) => ({ kind: 'item' as const, id, zone: 'canvas', section: `sec:${section}`, label: 'L', value: id, tone: 'claimed' as const, pills: [], sources: [] });

describe('canvas layout', () => {
  test('구역은 위에서 아래로 쌓이고, 항목은 구역 안 격자', () => {
    let b = createCanvas('c', 0);
    b = apply(b, upsertSection(b, { id: 'heard', title: '들은 정보', layout: 'cards' }, 0));
    b = apply(b, upsertSection(b, { id: 'map', title: '관계', layout: 'graph' }, 0));
    for (const id of ['a', 'b', 'c', 'd']) b = apply(b, upsertChild(b, item('heard', id), 0));
    const pa = b.placed.a!, pd = b.placed.d!;
    expect(pa.x).toBe(24 + 16);
    expect(pd.x).toBe(pa.x); // 4번째는 다음 줄 첫 칸
    expect(pd.y).toBeGreaterThan(pa.y);
    // 위 구역이 자라서 아래 구역이 내려갔다 (겹치지 않음)
    const heard = b.placed['sec:heard']!, map = b.placed['sec:map']!;
    expect(map.y).toBeGreaterThanOrEqual(heard.y + heard.h);
    expect(b.size.h).toBeGreaterThanOrEqual(map.y + map.h);
  });

  test('자라도 이미 놓인 x는 그대로, 아래 구역 항목과 연결선도 함께 이동', () => {
    let b = createCanvas('c', 0);
    b = apply(b, upsertSection(b, { id: 'heard', title: '들은 정보', layout: 'cards' }, 0));
    b = apply(b, upsertSection(b, { id: 'map', title: '관계', layout: 'graph' }, 0));
    b = apply(b, upsertChild(b, item('map', 'x'), 0));
    b = apply(b, upsertChild(b, item('map', 'y'), 0));
    b = apply(b, link(b, { from: 'x', to: 'y', label: '소속 주장', kind: 'claim' }));
    const before = { ...b.placed.x! };
    for (const id of ['a', 'b', 'c', 'd']) b = apply(b, upsertChild(b, item('heard', id), 0));
    expect(b.placed.x!.x).toBe(before.x);
    expect(b.placed.x!.y).toBeGreaterThan(before.y);
    expect(b.edges['edge:x->y']!.path).toContain(String(b.placed.x!.y + Math.round(b.placed.x!.h / 2)));
  });

  test('같은 id 재적용은 갱신만, 같은 내용이면 op 없음', () => {
    let b = createCanvas('c', 0);
    b = apply(b, upsertSection(b, { id: 'heard', title: '들은 정보', layout: 'cards' }, 0));
    b = apply(b, upsertChild(b, item('heard', 'a'), 0));
    expect(upsertChild(b, item('heard', 'a'), 1)).toEqual([]);
    const ps = upsertChild(b, { ...item('heard', 'a'), tone: 'contradicted' }, 1);
    expect(ps[0]).toMatchObject({ update: { id: 'a' } });
  });

  test('표 구역은 머리행을 먼저 둔다', () => {
    let b = createCanvas('c', 0);
    b = apply(b, upsertSection(b, { id: 'cmp', title: '비교', layout: 'table', columns: ['항목', '상대가 한 말', '공식 자료'] }, 0));
    const head = b.els['sec:cmp:head'];
    expect(head?.kind === 'row' && head.header).toBe(true);
  });
});
