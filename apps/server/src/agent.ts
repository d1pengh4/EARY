// 보드 에이전트 (§8.11): 대화와 검색 결과를 계속 보면서 "무엇을 확인하고 어떻게 보여 줄지" 스스로 정해 분석 보드에 그린다.
// - 좌표는 정하지 않는다. 구역·항목·연결의 "의도"만 내고 배치는 core/canvas.ts가 한다.
// - 위험 단계는 바꿀 수 없다 (P2). 판정(verdict)은 근거 카드로만 남는다.
import { link, scrubPhones, setSectionStatus, upsertChild, upsertSection } from '@eary/core';
import type { Board, BoardPatch, ItemTone, SectionLayout, SourceRef } from '@eary/schema';
import type { ChatMsg, GroqChat, ToolDef } from './groqChat';
import { readPage, type MergedHit, type WebSearch } from './search';

export interface AgentContext {
  transcript: { id: string; who: string; text: string }[];
  heard: { id: string; type: string; value: string; status: string }[];
  signals: string[];
  risk: string;
  domain: string;
}

export interface CanvasPort {
  board(): Board | undefined;
  apply(patches: BoardPatch[]): void;
  context(): AgentContext;
  now(): number;
  log(line: string): void;
}

const MAX_STEPS = 3; // 한 단계 ≈ 1.4~2.4k 토큰 (실측). 무료 등급 분당 8k 안에 들도록
const MAX_RESULT_CARDS = 10;
const MIN_INTERVAL_MS = 7000; // 무료 등급(모델별 분당 8k 토큰) 안에서 돌기 위한 최소 간격
const DEBOUNCE_MS = 900;

const SYSTEM = `너는 통화를 함께 듣는 보조 "이어리"의 분석 보드 담당이다. 사용자는 통화 중이라 글을 길게 못 읽는다.
목표: 상대가 한 말을 이해하고 검증하기 쉽게, 보드에 스스로 판단해서 정리한다.
매 턴 우선순위:
1) 대조표 갱신: section(id "check", layout "table", columns ["상대가 한 말","공식 자료","판단"])에 주장 하나당 row 하나. 판단은 "맞음"·"다름"·"확인 못 함" 중 하나. 이미 검색한 결과(searched)로 판단할 수 있으면 검색하지 말고 바로 쓴다.
2) 바로 쓸 수 있는 사실(공식 신청 경로, 기관이 안 하는 일)을 공식 자료(official)에서 찾으면 note로 짧게 알린다. 전화번호는 공식 자료(정부·공공기관 도메인)의 결과에 있을 때만 쓰고, 블로그·업체·뉴스의 번호는 절대 쓰지 않는다.
3) 아직 확인 안 된 주장이 있으면 web_search 1~2번. 공식 자료(정부·공공기관) 우선, 뉴스·후기는 참고.
4) 관계(graph)·순서(steps)·일정(timeline)이 이해에 도움이 될 때만 새 구역으로 그린다.
이미 있는 구역·항목은 유지하고 새로 알게 된 것만 추가하거나 상태를 바꾼다. 같은 내용을 다시 만들지 않는다.
규칙: 단정하지 않는다. "확인 못 함"은 "없음"이 아니다. 검색 결과는 통화 상대의 신원을 증명하지 않는다. 이어리는 대신 행동하지 않는다.
글은 짧게: label 2~6자, value 25자 이내, note 40자 이내. 한 턴에 도구 호출은 꼭 필요한 만큼만. 더 할 게 없으면 done.
id는 영문 소문자·숫자·밑줄로 짧게. 들은 정보 카드(heard:...)는 이미 보드에 있으니 link로 연결만 해도 된다.
기본 구역은 이미 있다. 새로 만들지 말고 이 id를 그대로 쓴다: heard(들은 정보), search(찾은 자료), evidence(확인 결과), think(메모).
쓸 수 있는 도구는 web_search, read_page, section, item, row, link, verdict, note, done뿐이다.`;

const TOOLS: ToolDef[] = [
  fn('web_search', '웹 검색. 결과는 보드 "찾은 자료"에 자동으로 표시된다. 결과 id(r1, r2…)를 verdict에 쓴다.', { query: str('한국어 검색어, 짧게'), why: str('왜 찾는지 (화면 표시용, 15자 이내)') }, ['query', 'why']),
  fn('read_page', '검색 결과 페이지 본문에서 관련 문장만 읽는다.', { result_id: str('r1 같은 검색 결과 id'), focus: str('찾을 내용') }, ['result_id', 'focus']),
  fn('section', '보드에 구역을 만든다 (있으면 제목만 갱신).', { id: str('구역 id'), title: str('구역 제목, 12자 이내'), layout: { type: 'string', enum: ['graph', 'table', 'timeline', 'steps', 'cards', 'evidence', 'notes'] }, columns: { type: 'array', items: { type: 'string' }, description: 'table일 때 열 이름' } }, ['id', 'title', 'layout']),
  fn('item', '구역에 항목(카드)을 넣거나 갱신한다.', { section: str('구역 id'), id: str('항목 id'), label: str('짧은 분류'), value: str('핵심 내용'), tone: tone(), note: str('보조 설명(선택)'), utterances: { type: 'array', items: { type: 'string' }, description: '근거 발화 id' } }, ['section', 'id', 'label', 'value', 'tone']),
  fn('row', '표 구역에 행을 넣거나 갱신한다. cells 순서 = columns 순서.', { section: str('표 구역 id'), id: str('행 id'), cells: { type: 'array', items: { type: 'string' } }, tone: tone() }, ['section', 'id', 'cells']),
  fn('link', '두 항목을 선으로 잇는다.', { from: str('항목 id'), to: str('항목 id'), label: str('관계, 6자 이내'), kind: { type: 'string', enum: ['claim', 'evidence', 'sequence'] } }, ['from', 'to', 'kind']),
  fn('verdict', '주장 항목을 검색 근거로 판정하고 근거 카드를 남긴다.', { item: str('판정할 항목 id'), status: { type: 'string', enum: ['confirmed', 'contradicted', 'unknown'] }, reason: str('판정 이유 40자 이내'), result_ids: { type: 'array', items: { type: 'string' } } }, ['item', 'status', 'reason']),
  fn('note', '사용자에게 꼭 필요한 짧은 메모를 남긴다.', { text: str('40자 이내'), tone: { type: 'string', enum: ['info', 'warning'] } }, ['text']),
  fn('done', '이번 턴에 할 일이 끝났다.', {}, []),
];

export class BoardAgent {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private again = false;
  private lastRun = 0;
  private results = new Map<string, MergedHit>();
  private resultSeq = 0;
  private searched: { q: string; top: string[] }[] = [];
  private searchSeq = 0;
  private shownUrls = new Set<string>();
  private abort: AbortController | null = null;

  constructor(private readonly chat: GroqChat, private readonly web: WebSearch, private readonly port: CanvasPort) {}

  get enabled() {
    return this.chat.enabled;
  }

  /** 새 발화·검색 결과·질문이 생기면 부른다. 묶어서 한 번만 돈다 */
  trigger(reason: string) {
    if (!this.chat.available) return;
    if (this.running) { this.again = true; return; }
    if (this.timer) return;
    const wait = Math.max(DEBOUNCE_MS, this.lastRun + MIN_INTERVAL_MS - Date.now());
    this.timer = setTimeout(() => { this.timer = null; void this.run(reason); }, wait);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort?.abort();
  }

  /** 서버가 스스로 하는 검색(새 기관·주장이 나왔을 때)도 같은 경로로 그린다 */
  async search(query: string, why: string, sources: SourceRef[] = []): Promise<{ id: string; title: string; host: string; tier: string; snippet: string }[]> {
    if (this.searched.some((s) => s.q === query)) return [];
    const chipId = `chip:${++this.searchSeq}`;
    this.ensureSection('search', '찾은 자료', 'search');
    this.child({ kind: 'chip', id: chipId, zone: 'canvas', section: 'sec:search', text: `검색 · ${why} · “${query}”`, state: 'running', sources });
    const shown = new Set<string>();
    const show = (merged: MergedHit[]) => {
      // 검색어당 최대 2장, 공식·뉴스가 있으면 참고는 뺀다, 보드 전체 10장까지 (실측: 30장 넘게 쌓여 보드를 덮음)
      const rel = merged.filter((x) => relevant(x, query));
      const strong = rel.filter((x) => x.tier !== 'reference');
      for (const h of (strong.length ? strong : rel).slice(0, 2)) {
        const key = h.url;
        if (shown.has(key) || this.shownUrls.has(key)) continue;
        if (this.shownUrls.size >= MAX_RESULT_CARDS) break;
        shown.add(key);
        this.shownUrls.add(key);
        const rid = this.remember(h);
        this.child({ kind: 'item', id: `res:${rid}`, zone: 'canvas', section: 'sec:search', label: TIER_KO[h.tier], value: h.title.slice(0, 40), tone: h.tier as ItemTone, pills: [{ text: h.host, tone: 'gray' }], sub: h.snippet.slice(0, 70), url: h.url, sources });
      }
    };
    const run = await this.web.search(query, (m) => show(m));
    show(run.merged);
    const kept = run.merged.filter((x) => relevant(x, query)).length;
    this.child({ kind: 'chip', id: chipId, zone: 'canvas', section: 'sec:search', text: `검색 · ${why} · “${query}” · 관련 ${kept}건 · ${Math.round(run.ms)}ms`, state: kept ? 'done' : 'failed', sources });
    const top = run.merged.filter((x) => relevant(x, query)).slice(0, 4).map((h) => ({ id: this.remember(h), title: h.title.slice(0, 60), host: h.host, tier: h.tier, snippet: h.snippet.slice(0, 160) }));
    this.searched.push({ q: query, top: top.map((t) => `${t.id}[${t.tier}] ${t.title} (${t.host})`) });
    this.port.log(`search "${query}" ${run.merged.length}건 ${Math.round(run.ms)}ms ${JSON.stringify(run.perProvider)}`);
    return top;
  }

  private remember(h: MergedHit): string {
    for (const [id, x] of this.results) if (x.url === h.url) return id;
    const id = `r${++this.resultSeq}`;
    this.results.set(id, h);
    return id;
  }

  private async run(reason: string) {
    const b = this.port.board();
    if (!b) return;
    this.running = true;
    this.lastRun = Date.now();
    this.abort = new AbortController();
    this.ensureSection('think', '이어리가 정리 중', 'notes');
    this.port.apply(setSectionStatus(this.port.board()!, 'sec:think', 'thinking'));
    try {
      const ctx = this.port.context();
      const msgs: ChatMsg[] = [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: JSON.stringify({ trigger: reason, ...ctx, transcript: ctx.transcript.slice(-6), board: this.boardSummary(), searched: this.searched.slice(-4).map((x) => ({ q: x.q, top: x.top.slice(0, 3) })) }) },
      ];
      for (let step = 0; step < MAX_STEPS; step++) {
        const r = await this.chat.chat(msgs, TOOLS, this.abort.signal);
        if (!r) { this.port.log('agent: 응답 없음 (한도 초과 또는 도구 호출 오류) → 이번 턴 종료'); break; }
        this.port.log(`agent step ${step + 1} ${r.model} ${Math.round(r.ms)}ms ${r.tokens}tok ${(r.msg.tool_calls ?? []).map((t) => t.function.name).join(',') || 'text'}`);
        msgs.push({ role: 'assistant', content: r.msg.content ?? '', tool_calls: r.msg.tool_calls });
        const calls = r.msg.tool_calls ?? [];
        if (!calls.length) break;
        let done = false;
        // 검색은 병렬로, 그리기는 순서대로
        const results = await Promise.all(calls.map(async (c) => {
          let args: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
          try { args = JSON.parse(c.function.arguments || '{}'); } catch { return { c, out: { error: 'bad json' } }; }
          if (c.function.name === 'done') { done = true; return { c, out: { ok: true } }; }
          return { c, out: await this.exec(c.function.name, args) };
        }));
        for (const { c, out } of results) msgs.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(out).slice(0, 1200) });
        if (done) break;
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') this.port.log(`agent error ${(e as Error).message}`);
    } finally {
      const nb = this.port.board();
      if (nb) this.port.apply(setSectionStatus(nb, 'sec:think', 'idle'));
      this.running = false;
      if (this.again) { this.again = false; this.trigger('대화가 이어짐'); }
    }
  }

  private async exec(name: string, a: Record<string, any>): Promise<unknown> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const sid = (x: string) => (BUILTIN.has(slug(x)) ? `sec:${slug(x)}` : `sec:ag_${slug(x)}`);
    const iid = (x: string) => (String(x).startsWith('heard:') || String(x).startsWith('res:') ? String(x) : `ag:${slug(x)}`);
    switch (name) {
      case 'web_search':
        return { results: await this.search(String(a.query).slice(0, 80), String(a.why ?? '확인').slice(0, 20)) };
      case 'read_page': {
        const h = this.results.get(String(a.result_id));
        if (!h) return { error: 'unknown result_id' };
        return await readPage(h.url, String(a.focus ?? ''));
      }
      case 'section': {
        const layout = (LAYOUTS.includes(a.layout) ? a.layout : 'cards') as SectionLayout;
        if (BUILTIN.has(slug(a.id))) return { ok: true, note: '기본 구역은 이미 있다' };
        this.port.apply(upsertSection(this.port.board()!, { id: `ag_${slug(a.id)}`, title: String(a.title).slice(0, 20), layout, columns: Array.isArray(a.columns) ? a.columns.map(String).slice(0, 4) : undefined }, this.port.now()));
        return { ok: true };
      }
      case 'item': {
        if (!this.port.board()!.els[sid(a.section)] && !BUILTIN.has(slug(a.section))) this.port.apply(upsertSection(this.port.board()!, { id: `ag_${slug(a.section)}`, title: String(a.section).slice(0, 20), layout: 'cards' }, this.port.now()));
        this.child({ kind: 'item', id: iid(a.id), zone: 'canvas', section: sid(a.section), label: String(a.label).slice(0, 12), value: String(a.value).slice(0, 40), tone: toneOf(a.tone), pills: [], sub: a.note ? String(a.note).slice(0, 60) : undefined, sources: this.srcs(a.utterances) });
        return { ok: true };
      }
      case 'row': {
        const sec = this.port.board()!.els[sid(a.section)];
        if (sec?.kind !== 'section' || sec.layout !== 'table') return { error: 'table section first' };
        this.child({ kind: 'row', id: `ag:${slug(a.section)}_${slug(a.id)}`, zone: 'canvas', section: sid(a.section), cells: (a.cells ?? []).map((x: unknown) => String(x).slice(0, 30)), tone: a.tone ? toneOf(a.tone) : undefined, sources: [] });
        return { ok: true };
      }
      case 'link':
        this.port.apply(link(this.port.board()!, { from: iid(a.from), to: iid(a.to), label: a.label ? String(a.label).slice(0, 10) : undefined, kind: a.kind === 'evidence' || a.kind === 'sequence' ? a.kind : 'claim' }));
        return { ok: true };
      case 'verdict': {
        const target = this.port.board()!.els[iid(a.item)];
        if (!target || target.kind !== 'item') return { error: 'unknown item' };
        const status = (['confirmed', 'contradicted', 'unknown'].includes(a.status) ? a.status : 'unknown') as ItemTone;
        this.child({ ...target, tone: status, pills: [{ text: TONE_PILL[status as 'confirmed'] ?? '확인 못 함', tone: status === 'contradicted' ? 'red' : status === 'confirmed' ? 'teal' : 'amber' }] });
        const ids: string[] = Array.isArray(a.result_ids) ? a.result_ids.map(String) : [];
        const best = ids.map((id) => this.results.get(id)).find(Boolean);
        this.ensureSection('evidence', '확인 결과', 'evidence');
        const evId = `ev:${slug(a.item)}`;
        this.child({ kind: 'item', id: evId, zone: 'canvas', section: 'sec:evidence', label: TONE_PILL[status as 'confirmed'] ?? '확인 못 함', value: String(a.reason).slice(0, 50), tone: status, pills: best ? [{ text: `${TIER_KO[best.tier]} · ${best.host}`, tone: best.tier === 'official' ? 'teal' : 'gray' }] : [], url: best?.url, sources: [] });
        this.port.apply(link(this.port.board()!, { from: evId, to: target.id, kind: 'evidence' }));
        return { ok: true };
      }
      case 'note': {
        this.ensureSection('think', '이어리가 정리 중', 'notes');
        const n = Object.values(this.port.board()!.els).filter((e) => e.kind === 'item' && e.section === 'sec:think').length;
        this.child({ kind: 'item', id: `note:${n + 1}`, zone: 'canvas', section: 'sec:think', label: a.tone === 'warning' ? '주의' : '메모', value: String(a.text).slice(0, 60), tone: a.tone === 'warning' ? 'warning' : 'info', pills: [], sources: [] });
        return { ok: true };
      }
      default:
        return { error: `unknown tool ${name}` };
    }
  }

  private srcs(ids: unknown): SourceRef[] {
    if (!Array.isArray(ids)) return [];
    return ids.map(String).slice(0, 4).map((utteranceId) => ({ utteranceId, rev: 0, startMs: 0 }));
  }

  private ensureSection(id: string, title: string, layout: SectionLayout) {
    const b = this.port.board();
    if (b && !b.els[`sec:${id}`]) this.port.apply(upsertSection(b, { id, title, layout }, this.port.now()));
  }

  private child(el: Parameters<typeof upsertChild>[1]) {
    // 에이전트가 쓴 글(검색 결과 카드 제외)에서 확인되지 않은 번호를 지운다
    if (el.kind === 'item' && !el.url) el = { ...el, value: scrubPhones(el.value).text, sub: el.sub ? scrubPhones(el.sub).text : undefined };
    if (el.kind === 'row') el = { ...el, cells: el.cells.map((c) => scrubPhones(c).text) };
    const b = this.port.board();
    if (b) this.port.apply(upsertChild(b, el, this.port.now()));
  }

  /** 에이전트에게 보여 주는 보드 요약 (토큰 절약: 구역별 항목 id·값만) */
  private boardSummary() {
    const b = this.port.board();
    if (!b) return [];
    const secs = b.order.map((id) => b.els[id]).filter((e) => e?.kind === 'section');
    return secs.map((s) => ({
      id: s!.id.replace(/^sec:(ag_)?/, ''), title: s!.kind === 'section' ? s!.title : '', layout: s!.kind === 'section' ? s!.layout : '',
      items: b.order.map((id) => b.els[id]).filter((e) => (e?.kind === 'item' || e?.kind === 'row') && e.section === s!.id).slice(-5)
        .map((e) => (e!.kind === 'item' ? `${e!.id.replace(/^ag:/, '')}=${e!.value}(${e!.tone})` : e!.kind === 'row' ? `${e!.id}:${e!.cells.join('|')}` : '')),
    })).filter((s) => s.id !== 'think' || s.items.length);
  }
}

/** 서버가 만든 기본 구역: 에이전트가 이 이름을 쓰면 새로 만들지 않고 그대로 쓴다 */
const BUILTIN = new Set(['heard', 'search', 'evidence', 'think']);
const LAYOUTS = ['graph', 'table', 'timeline', 'steps', 'cards', 'evidence', 'notes'];
const TIER_KO = { official: '공식 자료', news: '뉴스', reference: '참고' } as const;
const TONE_PILL: Partial<Record<ItemTone, string>> = { confirmed: '말과 맞음', contradicted: '말과 다름', unknown: '확인 못 함' };
const TONES: ItemTone[] = ['heard', 'claimed', 'confirmed', 'contradicted', 'unknown', 'warning', 'info', 'official', 'news', 'reference'];
const toneOf = (t: unknown): ItemTone => (TONES.includes(t as ItemTone) ? (t as ItemTone) : 'info');
const slug = (s: unknown) => String(s).toLowerCase().replace(/[^a-z0-9가-힣_]+/g, '_').slice(0, 32) || 'x';
function str(description: string) { return { type: 'string', description }; }
function tone() { return { type: 'string', enum: ['claimed', 'confirmed', 'contradicted', 'unknown', 'warning', 'info'] }; }
function fn(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDef {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

/** 검색어의 핵심어가 제목·요약에 절반 이상 들어 있어야 보드에 올린다 (실측: 위키백과가 무관한 인물 문서를 돌려줌) */
const STOP = new Set(['공식', '홈페이지', '전화', '사기', '요구', '대표번호', '대표전화', '확인', '사례']);
export function relevant(h: { title: string; snippet: string; tier: string }, query: string): boolean {
  const terms = query.split(/\s+/).filter((t) => t.length >= 2 && !STOP.has(t));
  if (!terms.length) return true;
  const text = `${h.title} ${h.snippet}`.replace(/\s+/g, '');
  const hit = terms.filter((t) => text.includes(t)).length;
  // 첫 단어가 고유명(4자 이상, 예: 기관명)이면 그 이름은 반드시 들어 있어야 한다 (실측: "사칭"만 맞은 "온라인 뱅킹" 문서)
  const head = terms[0]!;
  if (head.length >= 4 && !text.includes(head)) return false;
  return h.tier === 'official' ? hit >= 1 : hit / terms.length >= 0.5;
}
