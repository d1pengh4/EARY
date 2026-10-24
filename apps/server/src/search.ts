// 다중 웹 검색: 키가 있는 공급사를 동시에 부르고, 도착하는 대로 흘려 보낸 뒤 합쳐서 순위를 매긴다. (§10, §8.11)
// 공식 자료(정부·공공기관 도메인)가 1순위, 뉴스는 참고, 그 외는 참고. 검색 결과는 통화 상대의 신원을 증명하지 않는다.

export interface SearchHit {
  title: string;
  url: string;
  host: string;
  snippet: string;
  provider: string;
  tier: 'official' | 'news' | 'reference';
}
export interface MergedHit extends SearchHit { providers: string[]; score: number }

type Provider = { name: string; enabled: boolean; run: (q: string, signal: AbortSignal) => Promise<SearchHit[]> };

const UA = 'EARY/0.1 (hackathon demo; contact: local)';
const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&(amp|quot|lt|gt|nbsp)(?!;)/g, (_, e) => ({ amp: '&', quot: '"', lt: '<', gt: '>', nbsp: ' ' })[e as 'amp']).replace(/\s+/g, ' ').trim();

const OFFICIAL_HOSTS = [
  'nhis.or.kr', 'fss.or.kr', 'kftc.or.kr', 'kisa.or.kr', 'spo.go.kr', 'police.go.kr', 'gov.kr', 'korea.kr', 'nts.go.kr', 'epeople.go.kr',
  'counterscam112.go.kr', 'kca.go.kr', 'ftc.go.kr', 'msit.go.kr', 'nps.or.kr', 'hira.or.kr', 'kosaf.go.kr', 'scourt.go.kr', 'kcc.go.kr',
];
const NEWS_HINT = /news|press|ytn|yna\.co\.kr|kbs|mbc|sbs|jtbc|chosun|joongang|donga|hani|khan|mk\.co\.kr|hankyung|edaily|newsis|news1/;

export function tierOf(host: string, provider: string): SearchHit['tier'] {
  if (/\.go\.kr$|\.gov$|\.mil\.kr$/.test(host) || OFFICIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return 'official';
  if (provider.endsWith(':news') || NEWS_HINT.test(host)) return 'news';
  return 'reference';
}

function hit(provider: string, title: string, url: string, snippet: string): SearchHit | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return { title: strip(title), url, host, snippet: strip(snippet).slice(0, 300), provider, tier: tierOf(host, provider) };
  } catch {
    return null;
  }
}
const clean = (xs: (SearchHit | null)[]) => xs.filter((x): x is SearchHit => !!x);

async function json(url: string, init: RequestInit & { signal: AbortSignal }) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
  return res.json() as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export function createProviders(env: Record<string, string | undefined>): Provider[] {
  const q = encodeURIComponent;
  return [
    {
      name: 'naver', enabled: Boolean(env.NAVER_CLIENT_ID && env.NAVER_CLIENT_SECRET),
      run: async (s, signal) => {
        const h = { 'X-Naver-Client-Id': env.NAVER_CLIENT_ID!, 'X-Naver-Client-Secret': env.NAVER_CLIENT_SECRET! };
        const [web, news] = await Promise.allSettled([
          json(`https://openapi.naver.com/v1/search/webkr.json?display=5&query=${q(s)}`, { headers: h, signal }),
          json(`https://openapi.naver.com/v1/search/news.json?display=3&sort=sim&query=${q(s)}`, { headers: h, signal }),
        ]);
        return clean([
          ...(web.status === 'fulfilled' ? web.value.items ?? [] : []).map((i: any) => hit('naver', i.title, i.link, i.description)),
          ...(news.status === 'fulfilled' ? news.value.items ?? [] : []).map((i: any) => hit('naver:news', i.title, i.originallink || i.link, i.description)),
        ]);
      },
    },
    {
      name: 'kakao', enabled: Boolean(env.KAKAO_REST_API_KEY),
      run: async (s, signal) => {
        const j = await json(`https://dapi.kakao.com/v2/search/web?size=5&query=${q(s)}`, { headers: { Authorization: `KakaoAK ${env.KAKAO_REST_API_KEY}` }, signal });
        return clean((j.documents ?? []).map((d: any) => hit('kakao', d.title, d.url, d.contents)));
      },
    },
    {
      name: 'tavily', enabled: Boolean(env.TAVILY_API_KEY),
      run: async (s, signal) => {
        const j = await json('https://api.tavily.com/search', { method: 'POST', headers: { Authorization: `Bearer ${env.TAVILY_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: s, max_results: 5, search_depth: 'basic' }), signal });
        return clean((j.results ?? []).map((r: any) => hit('tavily', r.title, r.url, r.content)));
      },
    },
    {
      name: 'exa', enabled: Boolean(env.EXA_API_KEY),
      run: async (s, signal) => {
        const j = await json('https://api.exa.ai/search', { method: 'POST', headers: { 'x-api-key': env.EXA_API_KEY!, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: s, numResults: 5, contents: { text: { maxCharacters: 400 } } }), signal });
        return clean((j.results ?? []).map((r: any) => hit('exa', r.title ?? r.url, r.url, r.text ?? '')));
      },
    },
    {
      name: 'brave', enabled: Boolean(env.BRAVE_API_KEY),
      run: async (s, signal) => {
        const j = await json(`https://api.search.brave.com/res/v1/web/search?count=5&country=KR&search_lang=ko&q=${q(s)}`, { headers: { 'X-Subscription-Token': env.BRAVE_API_KEY!, Accept: 'application/json' }, signal });
        return clean((j.web?.results ?? []).map((r: any) => hit('brave', r.title, r.url, r.description)));
      },
    },
    {
      name: 'serper', enabled: Boolean(env.SERPER_API_KEY),
      run: async (s, signal) => {
        const j = await json('https://google.serper.dev/search', { method: 'POST', headers: { 'X-API-KEY': env.SERPER_API_KEY!, 'Content-Type': 'application/json' }, body: JSON.stringify({ q: s, gl: 'kr', hl: 'ko', num: 5 }), signal });
        return clean((j.organic ?? []).map((r: any) => hit('serper', r.title, r.link, r.snippet)));
      },
    },
    {
      name: 'serpapi', enabled: Boolean(env.SERPAPI_API_KEY),
      run: async (s, signal) => {
        const j = await json(`https://serpapi.com/search.json?engine=google&hl=ko&gl=kr&num=5&q=${q(s)}&api_key=${env.SERPAPI_API_KEY}`, { signal });
        return clean((j.organic_results ?? []).map((r: any) => hit('serpapi', r.title, r.link, r.snippet ?? '')));
      },
    },
    {
      name: 'google', enabled: Boolean(env.GOOGLE_CSE_KEY && env.GOOGLE_CSE_CX),
      run: async (s, signal) => {
        const j = await json(`https://www.googleapis.com/customsearch/v1?num=5&lr=lang_ko&key=${env.GOOGLE_CSE_KEY}&cx=${env.GOOGLE_CSE_CX}&q=${q(s)}`, { signal });
        return clean((j.items ?? []).map((r: any) => hit('google', r.title, r.link, r.snippet)));
      },
    },
    {
      // 키 없이 동작. 정의·배경 설명용 (참고 등급)
      // 다른 공급사가 하나라도 있으면 끈다 (실측: 무관한 문서가 잘 섞임). SEARCH_WIKIPEDIA=1이면 강제로 켬
      name: 'wikipedia', enabled: env.SEARCH_WIKIPEDIA === '1' || !['NAVER_CLIENT_ID', 'KAKAO_REST_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY', 'BRAVE_API_KEY', 'SERPER_API_KEY', 'SERPAPI_API_KEY', 'GOOGLE_CSE_KEY'].some((k) => env[k]),
      run: async (s, signal) => {
        const j = await json(`https://ko.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=3&srsearch=${q(s)}`, { headers: { 'User-Agent': UA }, signal });
        return clean((j.query?.search ?? []).map((r: any) => hit('wikipedia', r.title, `https://ko.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`, r.snippet)));
      },
    },
  ];
}

export interface SearchRun { query: string; merged: MergedHit[]; perProvider: Record<string, { ms: number; n: number; error?: string }>; ms: number }

export class WebSearch {
  constructor(private readonly providers: Provider[], private readonly timeoutMs = 2500) {}

  get enabledNames() {
    return this.providers.filter((p) => p.enabled).map((p) => p.name);
  }

  /**
   * 모든 공급사에 동시에 질의. 도착할 때마다 onPartial로 합친 결과를 흘린다.
   * earlyMs가 지나고 결과가 하나라도 있으면 먼저 돌려준다(에이전트가 기다리지 않게). 늦은 공급사 결과는 onPartial로 계속 온다.
   * 실측: 카카오 148ms, SerpAPI 702ms, Tavily 2.5s+ → 가장 느린 공급사를 기다리면 화면이 늦어진다.
   */
  async search(query: string, onPartial?: (merged: MergedHit[], from: string) => void, earlyMs = 1200): Promise<SearchRun> {
    const t0 = performance.now();
    const all: SearchHit[] = [];
    const perProvider: SearchRun['perProvider'] = {};
    const jobs = this.providers.filter((p) => p.enabled).map(async (p) => {
      const t = performance.now();
      try {
        const hits = await p.run(query, AbortSignal.timeout(p.name === 'tavily' ? Math.max(this.timeoutMs, 4000) : this.timeoutMs));
        perProvider[p.name] = { ms: performance.now() - t, n: hits.length };
        all.push(...hits);
        onPartial?.(merge(all, query), p.name);
      } catch (e) {
        perProvider[p.name] = { ms: performance.now() - t, n: 0, error: (e as Error).message.slice(0, 120) };
      }
    });
    const allDone = Promise.all(jobs);
    const early = new Promise<void>((resolve) => {
      const tick = () => (all.length && performance.now() - t0 >= earlyMs ? resolve() : setTimeout(tick, 50));
      setTimeout(tick, earlyMs);
    });
    await Promise.race([allDone, early]);
    return { query, merged: merge(all, query), perProvider: { ...perProvider }, ms: performance.now() - t0 };
  }
}

const TIER_W = { official: 3, news: 1.5, reference: 1 } as const;
// 위키백과는 정의·배경용. 사실 확인 검색에서는 엉뚱한 문서가 1위로 오르기 쉬워 가중치를 낮춘다 (실측: "보이스피싱 검찰 사칭" → 정치인 문서)
const PROVIDER_W: Record<string, number> = { wikipedia: -1 };

export function merge(hits: SearchHit[], query: string): MergedHit[] {
  const byUrl = new Map<string, MergedHit>();
  const terms = query.split(/\s+/).filter((t) => t.length >= 2);
  for (const h of hits) {
    const key = h.url.replace(/[?#].*$/, '').replace(/\/$/, '').replace(/^https?:\/\/(www\.)?/, '');
    const cur = byUrl.get(key);
    if (cur) { if (!cur.providers.includes(h.provider)) cur.providers.push(h.provider); if (h.snippet.length > cur.snippet.length) cur.snippet = h.snippet; continue; }
    byUrl.set(key, { ...h, providers: [h.provider], score: 0 });
  }
  for (const m of byUrl.values()) {
    const text = `${m.title} ${m.snippet}`;
    const overlap = terms.filter((t) => text.includes(t)).length / Math.max(1, terms.length);
    m.score = TIER_W[m.tier] + m.providers.length * 0.5 + overlap + Math.min(0, ...m.providers.map((p) => PROVIDER_W[p] ?? 0));
  }
  return [...byUrl.values()].sort((a, b) => b.score - a.score);
}

/** 페이지 본문에서 질의어가 들어 있는 문장만 뽑는다 (에이전트 read_page 도구) */
export async function readPage(url: string, focus: string, maxChars = 1200): Promise<{ title: string; text: string } | { error: string }> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(2500), redirect: 'follow' });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const html = (await res.text()).slice(0, 1_500_000);
    const title = strip(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? url);
    const body = strip(html.replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' '));
    const terms = focus.split(/\s+/).filter((t) => t.length >= 2);
    const sentences = body.split(/(?<=[.!?。]|다\.)\s+/).filter((s) => s.length > 15 && s.length < 400);
    const ranked = sentences.map((s, i) => ({ s, i, n: terms.filter((t) => s.includes(t)).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n || a.i - b.i);
    let text = '';
    for (const r of ranked) { if (text.length + r.s.length > maxChars) break; text += `${r.s}\n`; }
    return { title, text: text || body.slice(0, maxChars) };
  } catch (e) {
    return { error: (e as Error).message.slice(0, 120) };
  }
}
