// L1 Fast LLM (Groq / Cerebras, OpenAI 호환). 글로 값을 뽑아야 하는 추출만 맡는다. 엔티티 1개가 닫힐 때마다 흘려 보낸다. (§7.5)
import { JsonArrayStreamer } from '@eary/core';

const PROVIDERS = {
  groq: { baseURL: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY' },
  cerebras: { baseURL: 'https://api.cerebras.ai/v1', keyEnv: 'CEREBRAS_API_KEY' },
  gemini: { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GEMINI_API_KEY' },
} as const;

// 2026-10-24 벤치 결과 (docs/adr/l1-model.md). Cerebras 기본값은 키 확보 후 같은 벤치로 확정
const DEFAULT_MODEL = { groq: 'qwen/qwen3.8-27b', cerebras: 'gpt-oss-120b', gemini: 'gemini-flash-lite-latest' } as const;
const DEFAULT_EXTRA: Record<string, Record<string, unknown>> = {
  'openai/gpt-oss-20b': { reasoning_effort: 'low' },
  'openai/gpt-oss-120b': { reasoning_effort: 'low' },
};

export interface L1Entity { type: string; value: string; quote: string; name?: string; certainty?: 'claimed' | 'confirmed' }
export interface L1Relation { from: string; to: string; label: string; quote: string }

const SYSTEM = `너는 한국어 통화 기록에서 정보를 뽑는 추출기다. 반드시 JSON 객체 하나만 출력한다.
키 순서: {"entities":[...],"relations":[...]}
entities 원소: {"type":"org|person|case|account|amount|date|duration|condition|demand|product","value":"정규화한 값","name":"사람 이름(person일 때)","quote":"원문에서 그대로 잘라 온 근거 구절"}
relations 원소: {"from":"엔티티 value","to":"엔티티 value","label":"소속 주장|담당 주장|연루 주장 등","quote":"원문 구절"}
규칙: 마지막 발화에 새로 나온 것만. quote는 원문에 정확히 있는 문자열. 추측 금지. 없으면 빈 배열.`;

/** 세션이 쓰는 L1 계약. FastLlm 하나든 L1Chain이든 같다 */
export interface L1 {
  readonly enabled: boolean;
  readonly available: boolean;
  extract: FastLlm['extract'];
}

export class FastLlm implements L1 {
  private readonly provider: keyof typeof PROVIDERS;
  private readonly key: string | undefined;
  readonly model: string;
  private readonly extra: Record<string, unknown>;
  private jsonMode = true;

  constructor(env: Record<string, string | undefined>, opts: { model?: string; extra?: Record<string, unknown> } = {}) {
    this.provider = (env.L1_PROVIDER as keyof typeof PROVIDERS) in PROVIDERS ? (env.L1_PROVIDER as keyof typeof PROVIDERS) : 'groq';
    this.key = env[PROVIDERS[this.provider].keyEnv];
    // 기본 모델은 벤치(docs/adr/l1-model.md) 결과로 정한다. 2026-10-24 Groq 목록에서 llama-3.3-70b는 내려갔다
    this.model = opts.model ?? (env.L1_MODEL || DEFAULT_MODEL[this.provider]);
    this.extra = opts.extra ?? DEFAULT_EXTRA[this.model] ?? {};
  }

  /** 429를 받으면 Groq가 알려 준 초기화 시각까지 쉰다 (무료 등급: 모델별 분당 8k 토큰) */
  private pausedUntil = 0;

  get enabled() {
    return Boolean(this.key);
  }

  get label() {
    return `${this.provider}/${this.model}`;
  }

  get available() {
    return this.enabled && Date.now() >= this.pausedUntil;
  }

  async extract(context: string, last: string, onEntity: (e: L1Entity) => void, onRelation: (r: L1Relation) => void, signal?: AbortSignal): Promise<{ firstMs?: number; totalMs: number } | null> {
    if (!this.key || !this.available) return null;
    const t0 = performance.now();
    let firstMs: number | undefined;
    const streamer = new JsonArrayStreamer((field, item) => {
      firstMs ??= performance.now() - t0;
      if (field === 'entities') onEntity(item as L1Entity);
      if (field === 'relations') onRelation(item as L1Relation);
    });
    const call = (json: boolean) => fetch(`${PROVIDERS[this.provider].baseURL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model, stream: true, temperature: 0, ...this.extra,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `이전 발화:\n${context}\n\n마지막 발화:\n${last}` }],
      }),
      signal: signal ?? AbortSignal.timeout(4000),
    });
    let res = await call(this.jsonMode);
    if (res.status === 400 && this.jsonMode) {
      // 일부 모델은 스트리밍 + JSON 모드를 같이 못 쓴다 → 프롬프트만으로 JSON 강제
      const body = await res.text();
      if (/json|response_format|stream/i.test(body)) { this.jsonMode = false; res = await call(false); }
      else throw new Error(`l1 400 ${body.slice(0, 200)}`);
    }
    if (res.status === 429) {
      const reset = parseDuration(res.headers.get('x-ratelimit-reset-tokens') ?? res.headers.get('retry-after') ?? '10s');
      this.pausedUntil = Date.now() + reset;
      throw new Error(`l1 429: ${Math.round(reset / 1000)}초 쉬고 다시 시도`);
    }
    if (!res.ok || !res.body) throw new Error(`l1 ${res.status} ${(await res.text()).slice(0, 200)}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let sse = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      sse += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = sse.indexOf('\n')) >= 0) {
        const line = sse.slice(0, nl).trim();
        sse = sse.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (delta) streamer.push(delta);
        } catch { /* keep-alive 등 무시 */ }
      }
    }
    return { firstMs, totalMs: performance.now() - t0 };
  }
}

/** "48.54s" | "1m2.4s" | "12" → ms */
function parseDuration(v: string): number {
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v) * 1000;
  let ms = 0;
  for (const [, n, u] of v.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) ms += Number(n) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const)[u as 'ms' | 's' | 'm' | 'h'];
  return ms || 10_000;
}

/** L1 체인: 첫 번째가 한도(429)로 쉬는 동안 다음 공급사를 쓴다 (예: Groq qwen → Cerebras) */
export class L1Chain implements L1 {
  constructor(private readonly items: FastLlm[]) {}
  get enabled() { return this.items.some((x) => x.enabled); }
  get available() { return this.items.some((x) => x.available); }
  get names() { return this.items.filter((x) => x.enabled).map((x) => x.label); }
  extract(...args: Parameters<FastLlm['extract']>) {
    const next = this.items.find((x) => x.available);
    return next ? next.extract(...args) : Promise.resolve(null);
  }
}
