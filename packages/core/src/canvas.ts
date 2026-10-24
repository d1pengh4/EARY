// 분석 보드 레이아웃 엔진 (§8.11): 에이전트는 "어느 구역에 무엇을, 무엇과 연결"만 말하고, 좌표는 여기서 정한다.
// 규칙: 구역은 생성 순서대로 위에서 아래로 쌓인다. 놓인 요소의 x는 바뀌지 않고, y는 위 구역이 자랄 때만 같이 내려간다.
import type { BEdge, Board, BoardEl, BoardPatch, ItemTone, Ms, Placed, SectionLayout, SourceRef } from '@eary/schema';
import { applyBoardPatch, route } from './board';

export const CANVAS_W = 880;
const PAD = 24;
const HEAD = 44;
const GAP_Y = 20;
const INNER = CANVAS_W - PAD * 2;

const ITEM: Record<SectionLayout, { w: number; h: number; cols: number; gapX: number; gapY: number }> = {
  graph: { w: 200, h: 92, cols: 3, gapX: 72, gapY: 28 },
  cards: { w: 260, h: 96, cols: 3, gapX: 18, gapY: 16 },
  evidence: { w: 404, h: 120, cols: 2, gapX: 24, gapY: 16 },
  timeline: { w: 190, h: 88, cols: 4, gapX: 26, gapY: 16 },
  steps: { w: 190, h: 88, cols: 4, gapX: 26, gapY: 16 },
  notes: { w: INNER, h: 64, cols: 1, gapX: 0, gapY: 10 },
  search: { w: 404, h: 76, cols: 2, gapX: 24, gapY: 10 },
  table: { w: INNER, h: 52, cols: 1, gapX: 0, gapY: 0 },
};

export function createCanvas(id: string, nowMs: Ms): Board {
  return { id, templateId: 'canvas', title: '분석 보드', size: { w: CANVAS_W, h: 200 }, els: {}, placed: {}, edges: {}, order: [], badges: {}, updatedAtMs: nowMs };
}

type SectionEl = Extract<BoardEl, { kind: 'section' }>;
type Child = Extract<BoardEl, { kind: 'item' | 'row' | 'chip' }>;

function sections(b: Board): SectionEl[] {
  return b.order.map((id) => b.els[id]).filter((e): e is SectionEl => e?.kind === 'section');
}
function children(b: Board, sectionId: string): Child[] {
  return b.order.map((id) => b.els[id]).filter((e): e is Child => !!e && (e.kind === 'item' || e.kind === 'row' || e.kind === 'chip') && e.section === sectionId);
}

/** 구역 추가 (이미 있으면 제목·열만 갱신) */
export function upsertSection(b: Board, sec: { id: string; title: string; layout: SectionLayout; columns?: string[]; sources?: SourceRef[] }, nowMs: Ms): BoardPatch[] {
  const id = `sec:${sec.id}`;
  const cur = b.els[id];
  if (cur?.kind === 'section') {
    if (cur.title === sec.title && JSON.stringify(cur.columns) === JSON.stringify(sec.columns)) return [];
    return [{ update: { id, fields: { title: sec.title, columns: sec.columns ?? cur.columns } } }];
  }
  const last = sections(b).at(-1);
  const y = last ? b.placed[last.id]!.y + b.placed[last.id]!.h + GAP_Y : PAD;
  const el: SectionEl = { kind: 'section', id, zone: 'canvas', title: sec.title, layout: sec.layout, columns: sec.columns, sources: sec.sources ?? [] };
  const placed: Placed = { id, x: PAD, y, w: INNER, h: HEAD + 24 };
  const patches: BoardPatch[] = [{ add: { els: [el], placed: [placed] } }];
  if (sec.layout === 'table' && sec.columns?.length) {
    patches.push(...placeChild(applyAll(b, patches, nowMs), id, { kind: 'row', id: `${id}:head`, zone: 'canvas', section: id, cells: sec.columns, header: true, sources: [] }, nowMs));
  }
  patches.push({ resize: { h: y + placed.h + PAD } });
  void nowMs;
  return patches;
}

/** 구역 안에 항목·표 행·검색 칩을 넣는다. 같은 id면 내용만 갱신 (위치 그대로) */
export function upsertChild(b: Board, el: Child, nowMs: Ms): BoardPatch[] {
  const cur = b.els[el.id];
  if (cur) {
    if (JSON.stringify({ ...cur, sources: 0 }) === JSON.stringify({ ...el, sources: 0 })) return [];
    const badge: BoardPatch[] = el.kind === 'chip' ? [] : [{ badge: { id: el.id, text: '방금 갱신', untilMs: nowMs + 4000 } }];
    return [{ update: { id: el.id, fields: el } }, ...badge];
  }
  return placeChild(b, el.section, el, nowMs);
}

function placeChild(b: Board, sectionId: string, el: Child, nowMs: Ms): BoardPatch[] {
  const sec = b.els[sectionId];
  const sp = b.placed[sectionId];
  if (sec?.kind !== 'section' || !sp) return [];
  const spec = ITEM[sec.layout];
  const idx = children(b, sectionId).length;
  const col = idx % spec.cols;
  const row = Math.floor(idx / spec.cols);
  const w = sec.layout === 'table' ? INNER - 32 : spec.w;
  const x = sp.x + 16 + col * (spec.w + spec.gapX);
  const y = sp.y + HEAD + row * (spec.h + spec.gapY);
  const placed: Placed = { id: el.id, x, y, w, h: spec.h };
  const patches: BoardPatch[] = [{ add: { els: [el], placed: [placed] } }];
  if (el.kind !== 'chip') patches.push({ badge: { id: el.id, text: '방금 추가', untilMs: nowMs + 4000 } });

  // 구역이 자라면 그 아래 구역 전체를 같이 내린다 (위치 고정 규칙의 유일한 예외)
  const needH = y + spec.h + 16 - sp.y;
  if (needH > sp.h) {
    const dy = needH - sp.h;
    const moved: Placed[] = [{ ...sp, h: needH }];
    const below = new Set(sections(b).filter((s) => b.placed[s.id]!.y > sp.y).map((s) => s.id));
    for (const id of b.order) {
      const e = b.els[id];
      const p = b.placed[id];
      if (!e || !p) continue;
      const owner = e.kind === 'section' ? e.id : 'section' in e ? e.section : undefined;
      if (owner && below.has(owner)) moved.push({ ...p, y: p.y + dy });
    }
    patches.push({ move: { placed: moved } });
    const edges = Object.values(b.edges).filter((e) => moved.some((m) => m.id === e.from || m.id === e.to));
    if (edges.length) patches.push({ edges: rerouteEdges(b, edges, moved) });
    patches.push({ resize: { h: b.size.h + dy } });
  }
  void nowMs;
  return patches;
}

/** 같은 구역 또는 구역 사이 연결선. 에이전트는 from/to id만 준다 */
export function link(b: Board, e: { from: string; to: string; label?: string; kind: BEdge['kind'] }): BoardPatch[] {
  const pa = b.placed[e.from];
  const pb = b.placed[e.to];
  if (!pa || !pb || e.from === e.to) return [];
  const id = `edge:${e.from}->${e.to}`;
  if (b.edges[id] && b.edges[id]!.label === e.label) return [];
  const g = route(pa, pb);
  return [{ edges: [{ id, from: e.from, to: e.to, kind: e.kind, label: e.label, path: g.path, labelAt: g.labelAt }] }];
}

function rerouteEdges(b: Board, edges: BEdge[], moved: Placed[]): BEdge[] {
  const pos = { ...b.placed };
  for (const m of moved) pos[m.id] = m;
  return edges.map((e) => {
    const g = route(pos[e.from]!, pos[e.to]!);
    return { ...e, path: g.path, labelAt: g.labelAt };
  });
}

export function setSectionStatus(b: Board, sectionId: string, status: 'thinking' | 'idle'): BoardPatch[] {
  const cur = b.els[sectionId];
  if (cur?.kind !== 'section' || cur.status === status) return [];
  return [{ update: { id: sectionId, fields: { status } } }];
}

export const TONE_LABEL: Record<ItemTone, string> = {
  heard: '들은 말', claimed: '상대 주장', confirmed: '확인됨', contradicted: '말과 다름', unknown: '확인 못 함',
  warning: '주의', info: '안내', official: '공식 자료', news: '뉴스', reference: '참고',
};

// 내부: 패치 묶음을 임시로 적용해서 다음 배치를 계산 (구역 생성 직후 표 머리행처럼)
function applyAll(b: Board, ps: BoardPatch[], nowMs: Ms): Board {
  return ps.reduce((acc, p) => applyBoardPatch(acc, p, nowMs), b);
}
