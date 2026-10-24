// 보드 배치기: 템플릿 슬롯·구역 규칙으로 좌표를 결정론적으로 정한다. LLM은 좌표를 내지 않는다. (§8.5, §8.10)
import type { BEdge, Board, BoardEl, BoardPatch, CardStyle, Entity, Ms, PillSpec, Placed } from '@eary/schema';
import { hash } from './normalize';
import type { BoardTemplate, Rect, TemplateZone } from './packs';

export const BADGE_MS = 4000;

export function createBoard(tpl: BoardTemplate, id: string, nowMs: Ms): Board {
  return { id, templateId: tpl.id, title: tpl.title, size: { ...tpl.size }, els: {}, placed: {}, edges: {}, order: [], badges: {}, updatedAtMs: nowMs };
}

const TYPE_LABEL: Record<string, string> = {
  org: '기관', person: '인물', case: '사건', account: '계좌', amount: '금액', date: '일정',
  duration: '기간', condition: '조건', demand: '요구', product: '상품',
};
const TYPE_ORDER = ['org', 'person', 'product', 'amount', 'duration', 'date', 'condition', 'demand', 'case', 'account'];

export function cardId(entityKey: string) {
  return `card:${entityKey}`;
}

function styleOf(e: Entity, slotStyle?: 'me'): CardStyle {
  if (e.certainty === 'provisional') return 'provisional';
  if (e.certainty === 'contradicted') return 'contradicted';
  if (slotStyle === 'me' || e.attrs.owner === 'me') return 'me';
  return e.certainty === 'confirmed' ? 'confirmed' : 'claimed';
}

function pillsOf(e: Entity): PillSpec[] {
  const pills: PillSpec[] = [];
  if (e.certainty === 'provisional') pills.push({ text: '듣는 중', tone: 'gray' });
  if (e.attrs.status) pills.push({ text: e.attrs.status, tone: (e.attrs.statusTone as PillSpec['tone']) ?? 'amber' });
  if (e.attrs.estimate === 'true') pills.push({ text: '예상 비용', tone: 'amber' });
  return pills;
}

function valueOf(e: Entity): string {
  if (e.type === 'person' && e.certainty !== 'confirmed') return `${e.value} (자칭)`;
  return e.value;
}

function cardFor(e: Entity, zone: string, slot: string | undefined, label: string, slotStyle?: 'me'): Extract<BoardEl, { kind: 'card' }> {
  return {
    kind: 'card', id: cardId(e.key), entityKey: e.key, zone, slot, label,
    value: valueOf(e), pills: pillsOf(e), sub: e.attrs.sub, style: styleOf(e, slotStyle), sources: e.sources,
  };
}

/** 엔티티 1개를 보드에 반영: 이미 있으면 갱신, 없으면 슬롯 → 넘침 구역 순으로 배치 */
export function syncEntity(board: Board, tpl: BoardTemplate, e: Entity, nowMs: Ms): BoardPatch[] {
  const id = cardId(e.key);
  const existing = board.els[id];
  if (existing && existing.kind === 'card') {
    const slotStyle = existing.slot ? tpl.slots[existing.slot]?.style : undefined;
    const next = cardFor(e, existing.zone, existing.slot, existing.label, slotStyle);
    const changed = next.value !== existing.value || next.style !== existing.style || JSON.stringify(next.pills) !== JSON.stringify(existing.pills) || next.sub !== existing.sub;
    if (!changed) return [];
    const patches: BoardPatch[] = [{ update: { id, fields: next } }];
    // 잠정 → 확정은 "방금 추가"(처음 보이는 확정), 값·상태 변경은 "방금 갱신"
    if (existing.style === 'provisional' && next.style !== 'provisional') patches.push({ badge: { id, text: '방금 추가', untilMs: nowMs + BADGE_MS } });
    else if (next.style !== 'provisional') patches.push({ badge: { id, text: '방금 갱신', untilMs: nowMs + BADGE_MS } });
    patches.push(...edgesFor(board, tpl, id, { [id]: board.placed[id]! }, { [id]: next }));
    return patches;
  }

  // 1) 슬롯
  const taken = new Set(Object.values(board.els).map((el) => (el.kind === 'card' ? el.slot : undefined)).filter(Boolean));
  for (const [slotName, slot] of Object.entries(tpl.slots)) {
    if (slot.match.type !== e.type || taken.has(slotName)) continue;
    // "나" 칸은 내 명의 계좌만 (실기: 상대가 말한 "안전계좌"가 "나" 칸에 들어가 "전화를 받은 나" 카드와 겹쳤다)
    if (slot.style === 'me' && e.attrs.owner !== 'me') continue;
    const el = cardFor(e, 'slot', slotName, slot.label, slot.style);
    const placed: Placed = { id, x: slot.x, y: slot.y, w: slot.w, h: slot.h };
    const patches: BoardPatch[] = [{ add: { els: [el], placed: [placed] } }];
    patches.push(...edgesFor(board, tpl, id, { [id]: placed }, { [id]: el }));
    return patches;
  }

  // 2) 넘침 구역 (sorted grid). 이미 놓인 칸 수 = 다음 빈칸
  const zoneName = tpl.zones.overflow ? 'overflow' : tpl.zones.facts ? 'facts' : undefined;
  if (!zoneName) return [];
  const zone = tpl.zones[zoneName]!;
  if (zone.types && !zone.types.includes(e.type)) return [];
  const used = Object.values(board.els).filter((el) => el.zone === zoneName).length;
  // 넘침 구역은 정해진 높이 안에서만 쌓는다 (facts 격자는 보드를 늘려 가며 쌓음)
  if (zoneName === 'overflow' && zone.cell && Math.ceil((used + 1) / (zone.cols ?? 1)) * (zone.cell.h + (zone.gap ?? 16)) - (zone.gap ?? 16) > zone.h) return [];
  const cell = gridCell(zone, used);
  const el = cardFor(e, zoneName, undefined, TYPE_LABEL[e.type] ?? e.type);
  const placed: Placed = { id, ...cell };
  const patches: BoardPatch[] = [{ add: { els: [el], placed: [placed] } }];
  const bottom = cell.y + cell.h + 32;
  if (bottom > board.size.h) patches.push({ resize: { h: bottom } });
  return patches;
}

export function gridCell(zone: TemplateZone, index: number): Rect {
  const cw = zone.cell?.w ?? zone.w;
  const ch = zone.cell?.h ?? 96;
  const gap = zone.gap ?? 16;
  const cols = zone.cols ?? 1;
  const col = index % cols;
  const row = Math.floor(index / cols);
  return { x: zone.x + col * (cw + gap), y: zone.y + row * (ch + gap), w: cw, h: ch };
}

/** 템플릿 relations 중 양 끝이 모두 놓인 것만 claim 연결선을 긋는다 */
function edgesFor(board: Board, tpl: BoardTemplate, changedId: string, extraPlaced: Record<string, Placed>, extraEls: Record<string, BoardEl>): BoardPatch[] {
  const els = { ...board.els, ...extraEls };
  const placed = { ...board.placed, ...extraPlaced };
  const bySlot: Record<string, string> = {};
  for (const el of Object.values(els)) if (el.kind === 'card' && el.slot) bySlot[el.slot] = el.id;
  const out: BEdge[] = [];
  for (const rel of tpl.relations) {
    const a = bySlot[rel.from];
    const b = bySlot[rel.to];
    if (!a || !b || (a !== changedId && b !== changedId)) continue;
    const pa = placed[a];
    const pb = placed[b];
    if (!pa || !pb) continue;
    const ea = els[a];
    const eb = els[b];
    // 잠정 카드끼리는 선을 긋지 않는다 (확정된 뒤에 그린다)
    if (ea?.kind === 'card' && ea.style === 'provisional') continue;
    if (eb?.kind === 'card' && eb.style === 'provisional') continue;
    const id = `edge:${rel.from}->${rel.to}`;
    if (board.edges[id]) continue;
    const g = route(pa, pb);
    out.push({ id, from: a, to: b, kind: 'claim', label: rel.label, path: g.path, labelAt: g.labelAt });
  }
  return out.length ? [{ edges: out }] : [];
}

/** 설명 박스(callout)를 구역에 넣거나 갱신 */
export function syncCallout(board: Board, tpl: BoardTemplate, el: Extract<BoardEl, { kind: 'callout' }>, nowMs: Ms, linkTo?: string): BoardPatch[] {
  const zone = tpl.zones[el.zone];
  if (!zone) return [];
  const existing = board.els[el.id];
  if (existing) {
    if (JSON.stringify(existing) === JSON.stringify(el)) return [];
    return [{ update: { id: el.id, fields: el } }, { badge: { id: el.id, text: '방금 갱신', untilMs: nowMs + BADGE_MS } }];
  }
  const placed: Placed = { id: el.id, x: zone.x, y: zone.y, w: zone.w, h: zone.h };
  const patches: BoardPatch[] = [{ add: { els: [el], placed: [placed] } }];
  if (linkTo && board.placed[linkTo]) {
    const g = route(placed, board.placed[linkTo]!, false);
    patches.push({ edges: [{ id: `edge:${el.id}->${linkTo}`, from: el.id, to: linkTo, kind: 'evidence', path: g.path }] });
  }
  return patches;
}

/** 직선(축이 겹치면) 또는 ㄱ자 한 번 꺾은선. 경로는 보드 좌표계 SVG path. (§8.5-5) */
export function route(a: Rect, b: Rect, _arrow = true): { path: string; labelAt: { x: number; y: number } } {
  const ox0 = Math.max(a.x, b.x);
  const ox1 = Math.min(a.x + a.w, b.x + b.w);
  if (ox1 - ox0 >= 24) {
    const x = Math.round((ox0 + ox1) / 2);
    const [top, bottom] = a.y + a.h <= b.y ? [a.y + a.h, b.y] : [b.y + b.h, a.y];
    const down = a.y + a.h <= b.y;
    const y0 = down ? top : bottom;
    const y1 = down ? bottom : top;
    return { path: `M ${x} ${y0} L ${x} ${y1}`, labelAt: { x: x + 12, y: Math.round((y0 + y1) / 2) } };
  }
  const oy0 = Math.max(a.y, b.y);
  const oy1 = Math.min(a.y + a.h, b.y + b.h);
  if (oy1 - oy0 >= 24) {
    const y = Math.round((oy0 + oy1) / 2);
    const right = a.x + a.w <= b.x;
    const x0 = right ? a.x + a.w : a.x;
    const x1 = right ? b.x : b.x + b.w;
    return { path: `M ${x0} ${y} L ${x1} ${y}`, labelAt: { x: Math.round((x0 + x1) / 2), y: y - 14 } };
  }
  // ㄱ자: a의 아래(또는 위) 중앙에서 세로로 b의 중앙 높이까지, 그다음 가로로 b의 옆변까지
  const ax = Math.round(a.x + a.w / 2);
  const by = Math.round(b.y + b.h / 2);
  const y0 = b.y > a.y ? a.y + a.h : a.y;
  const x1 = b.x > ax ? b.x : b.x + b.w;
  return { path: `M ${ax} ${y0} L ${ax} ${by} L ${x1} ${by}`, labelAt: { x: Math.round((ax + x1) / 2), y: by - 14 } };
}

/** 손글씨 메모 회전각: id 해시로 -2.0 ~ -1.0도 (결정론) */
export function handRotation(id: string): number {
  return -1 - (hash(id) % 100) / 100;
}

export function applyBoardPatch(board: Board, patch: BoardPatch, atMs: Ms): Board {
  const b: Board = { ...board, updatedAtMs: atMs };
  if ('add' in patch) {
    b.els = { ...b.els };
    b.placed = { ...b.placed };
    b.order = [...b.order];
    for (const el of patch.add.els) { b.els[el.id] = el; if (!b.order.includes(el.id)) b.order.push(el.id); }
    for (const p of patch.add.placed) b.placed[p.id] = p;
    if (patch.add.edges) { b.edges = { ...b.edges }; for (const e of patch.add.edges) b.edges[e.id] = e; }
  } else if ('update' in patch) {
    const cur = b.els[patch.update.id];
    if (cur) b.els = { ...b.els, [cur.id]: { ...cur, ...patch.update.fields } as BoardEl };
  } else if ('move' in patch) {
    b.placed = { ...b.placed };
    for (const p of patch.move.placed) b.placed[p.id] = p;
  } else if ('edges' in patch) {
    b.edges = { ...b.edges };
    for (const e of patch.edges) b.edges[e.id] = e;
  } else if ('remove' in patch) {
    const id = patch.remove.id;
    const els = { ...b.els }; delete els[id];
    const placed = { ...b.placed }; delete placed[id];
    const edges = Object.fromEntries(Object.entries(b.edges).filter(([, e]) => e.from !== id && e.to !== id));
    b.els = els; b.placed = placed; b.edges = edges; b.order = b.order.filter((x) => x !== id);
  } else if ('badge' in patch) {
    b.badges = { ...b.badges, [patch.badge.id]: { text: patch.badge.text, untilMs: patch.badge.untilMs } };
  } else if ('resize' in patch) {
    b.size = { ...b.size, h: Math.max(b.size.h, patch.resize.h) };
  }
  return b;
}

export { TYPE_ORDER };
