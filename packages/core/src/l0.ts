// L0 즉시 규칙: 고유명 사전 + 정규식. 발화당 1ms 미만, interim마다 돈다. (§7, §8.10, §9.1)
import type { EntityType, Mark, SignalCategory } from '@eary/schema';
import { compact, entityKey, parseKoreanWon, toOriginal, type Compact } from './normalize';
import type { DomainPack, Lexicon } from './packs';

export interface L0Entity {
  key: string;
  type: EntityType;
  value: string;
  attrs: Record<string, string>;
  confidence: number;
  span: { start: number; end: number };
  /** 이 엔티티가 가리키는 도메인 (템플릿 추측용) */
  hint?: DomainPack['id'];
}

export interface L0Signal {
  category: SignalCategory;
  strength: number;
  span: { start: number; end: number };
}

export interface L0Result {
  entities: L0Entity[];
  signals: L0Signal[];
  marks: Mark[];
  /** 엔티티 단서로 본 도메인 추측 */
  domainGuess?: DomainPack['id'];
}

interface CompiledPack {
  pack: DomainPack;
  orgs: { canon: string; kind: string; needles: string[] }[];
  products: string[];
  re: Partial<Record<keyof DomainPack['patterns'], RegExp>>;
}

export interface L0Engine {
  scan(text: string): L0Result;
}

export function createL0(lexicon: Lexicon, packs: DomainPack[]): L0Engine {
  const signalRes = lexicon.signals.map((e) => ({
    category: e.category,
    strength: e.strength,
    re: new RegExp(e.patterns.map((p) => `(?:${p})`).join('|'), 'g'),
  }));
  const compiled: CompiledPack[] = packs.map((pack) => ({
    pack,
    orgs: pack.gazetteer.org.map((o) => ({ canon: o.canon, kind: o.kind, needles: [o.canon, ...o.aliases].map((n) => n.replace(/\s+/g, '')).sort((a, b) => b.length - a.length) })),
    products: pack.gazetteer.product ?? [],
    re: Object.fromEntries(Object.entries(pack.patterns).map(([k, v]) => [k, new RegExp(v as string, 'g')])),
  }));

  return {
    scan(text: string): L0Result {
      const c = compact(text);
      const entities: L0Entity[] = [];
      const signals: L0Signal[] = [];
      const seen = new Set<string>();
      const push = (e: L0Entity) => {
        if (seen.has(e.key)) return;
        seen.add(e.key);
        entities.push(e);
      };

      for (const cp of compiled) {
        const hint = cp.pack.id;
        for (const org of cp.orgs) {
          let found = false;
          for (const needle of org.needles) {
            const i = c.s.indexOf(needle);
            if (i < 0) continue;
            push({ key: entityKey('org', org.canon), type: 'org', value: org.canon, attrs: { kind: org.kind }, confidence: 0.95, span: toOriginal(c, i, i + needle.length), hint });
            found = true;
            break;
          }
          // STT 한 글자 오인식 허용 ("서울중앙직검" → 서울중앙지검). 5자 이상 이름만, 신뢰도는 낮춰서 확인을 거치게 한다
          if (!found) {
            for (const needle of org.needles) {
              if (needle.length < 5) continue;
              const i = fuzzyIndex(c.s, needle);
              if (i < 0) continue;
              push({ key: entityKey('org', org.canon), type: 'org', value: org.canon, attrs: { kind: org.kind, fuzzy: 'true' }, confidence: 0.85, span: toOriginal(c, i, i + needle.length), hint });
              break;
            }
          }
        }
        for (const p of cp.products) {
          const i = c.s.indexOf(p);
          if (i >= 0) push({ key: entityKey('product', p), type: 'product', value: p, attrs: {}, confidence: 0.7, span: toOriginal(c, i, i + p.length), hint });
        }
        eachMatch(cp.re.person, c, (m, span) => {
          // 띄어쓰기를 지운 텍스트라 "소속홍길동검사"처럼 앞말이 붙는다 → 한국 이름 길이(3자)로 자른다.
          const raw = m[1]!;
          const name = raw.length > 3 ? raw.slice(-3) : raw;
          const title = m[2]!;
          if (NOT_NAMES.has(name) || NOT_NAMES.has(name.slice(-2))) return;
          push({ key: entityKey('person', name), type: 'person', value: `${name} ${title}`, attrs: { name, title }, confidence: 0.8, span, hint });
        });
        eachMatch(cp.re.case, c, (m, span) => {
          // "4만 8271" → 48271, 오인식된 사건 구분자(현제·형재)는 형제로 되돌린다
          const serial = m[3] ? String(Number(m[3]) * 10_000 + Number(m[4])) : m[4]!;
          const kind = CASE_KIND_FIX[m[2]!] ?? m[2]!;
          const fixed = Boolean(m[3]) || kind !== m[2];
          push({ key: entityKey('case', `${m[1]}${kind}${serial}`), type: 'case', value: `${m[1]}${kind}${serial}호`, attrs: fixed ? { stt_fixed: 'true' } : {}, confidence: fixed ? 0.9 : 0.95, span, hint });
        });
        eachMatch(cp.re.account_me, c, (_m, span) => {
          push({ key: 'account:me', type: 'account', value: '내 명의 계좌', attrs: { owner: 'me' }, confidence: 0.9, span, hint });
        });
        eachMatch(cp.re.amount, c, (m, span) => {
          const won = parseKoreanWon(m[1]!);
          if (!Number.isFinite(won) || won < 100) return;
          const estimate = Boolean(m[2]);
          push({ key: `amount:${won}`, type: 'amount', value: text.slice(span.start, span.end), attrs: { won: String(won), ...(estimate ? { estimate: 'true' } : {}) }, confidence: 0.95, span, hint });
        });
        eachMatch(cp.re.duration, c, (m, span) => {
          push({ key: `duration:${m[1]}개월`, type: 'duration', value: `${m[1]}개월`, attrs: { months: m[1]! }, confidence: 0.95, span, hint });
        });
        eachMatch(cp.re.date, c, (_m, span) => {
          const raw = text.slice(span.start, span.end);
          push({ key: entityKey('date', raw), type: 'date', value: raw, attrs: {}, confidence: 0.9, span, hint });
        });
      }

      for (const sr of signalRes) {
        sr.re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = sr.re.exec(c.s))) {
          if (m[0].length === 0) { sr.re.lastIndex++; continue; }
          signals.push({ category: sr.category, strength: sr.strength, span: toOriginal(c, m.index, m.index + m[0].length) });
        }
      }

      const marks: Mark[] = [
        ...entities.filter((e) => e.type !== 'product').map((e) => ({ ...e.span, tone: 'amber' as const })),
        ...signals.map((s) => ({ ...s.span, tone: 'red' as const })),
      ];

      const votes: Partial<Record<DomainPack['id'], number>> = {};
      for (const e of entities) {
        // general은 다른 도메인이 없을 때의 기본값이라 투표하지 않는다 (실측: 금액 패턴이 요금·일반 팩에 모두 있어 동점 → 일반이 이김)
        if (!e.hint || e.hint === 'general') continue;
        const w = e.type === 'org' || e.type === 'person' || e.type === 'case' ? 2 : 1;
        votes[e.hint] = (votes[e.hint] ?? 0) + w;
      }
      const domainGuess = (Object.entries(votes) as [DomainPack['id'], number][]).sort((a, b) => b[1] - a[1])[0]?.[0];

      return { entities, signals, marks: mergeMarks(marks), domainGuess };
    },
  };
}

/** 같은 길이 창에서 글자 1개만 다른 첫 위치 (해밍 거리 ≤ 1) */
function fuzzyIndex(hay: string, needle: string): number {
  const n = needle.length;
  for (let i = 0; i + n <= hay.length; i++) {
    let diff = 0;
    for (let k = 0; k < n && diff <= 1; k++) if (hay[i + k] !== needle[k]) diff++;
    if (diff <= 1) return i;
  }
  return -1;
}

const CASE_KIND_FIX: Record<string, string> = { 현제: '형제', 형재: '형제', 혁제: '형제' };

const NOT_NAMES = new Set(['부장', '담당', '지검', '소속', '수사', '검찰', '본부', '저는', '제가']);

function eachMatch(re: RegExp | undefined, c: Compact, fn: (m: RegExpExecArray, span: { start: number; end: number }) => void) {
  if (!re) return;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(c.s))) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    fn(m, toOriginal(c, m.index, m.index + m[0].length));
  }
}

/** 겹치는 형광펜은 red가 이긴다 */
function mergeMarks(marks: Mark[]): Mark[] {
  const sorted = [...marks].sort((a, b) => a.start - b.start || (a.tone === 'red' ? -1 : 1));
  const out: Mark[] = [];
  for (const m of sorted) {
    const last = out[out.length - 1];
    if (last && m.start < last.end) {
      if (m.tone === 'red' && last.tone !== 'red') { last.end = Math.max(last.end, m.end); last.tone = 'red'; }
      else last.end = Math.max(last.end, m.end);
      continue;
    }
    out.push({ ...m });
  }
  return out;
}
