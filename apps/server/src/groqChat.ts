// 도구 호출 클라이언트 (OpenAI 호환: Groq·Cerebras). 한도가 "모델별"이라, 429가 나면 그 모델을 쉬게 하고 체인의 다음으로 넘긴다.
// 체인 예: groq/gpt-oss-120b → groq/gpt-oss-20b → cerebras/gpt-oss-120b
export interface ChatMsg { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string }; extra_content?: unknown }
export interface ToolDef { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }

export const BASE_URL = { groq: 'https://api.groq.com/openai/v1', cerebras: 'https://api.cerebras.ai/v1', gemini: 'https://generativelanguage.googleapis.com/v1beta/openai' } as const;
export interface Endpoint { provider: keyof typeof BASE_URL; model: string; key: string }

/** env로 체인을 만든다. 키가 없는 공급사는 빠진다 */
export function chainFromEnv(env: Record<string, string | undefined>, groqModels: string, cerebrasModels: string, geminiModels = 'gemini-flash-lite-latest'): Endpoint[] {
  const list = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
  return [
    ...(env.GROQ_API_KEY ? list(groqModels).map((model) => ({ provider: 'groq' as const, model, key: env.GROQ_API_KEY! })) : []),
    ...(env.CEREBRAS_API_KEY ? list(cerebrasModels).map((model) => ({ provider: 'cerebras' as const, model, key: env.CEREBRAS_API_KEY! })) : []),
    // Gemini 무료 등급: Groq보다 느리지만(1.0~1.6s, 실측) 분당 토큰 한도가 커서 Groq가 막힐 때 받는다
    ...(env.GEMINI_API_KEY ? list(geminiModels).map((model) => ({ provider: 'gemini' as const, model, key: env.GEMINI_API_KEY! })) : []),
  ];
}

export class GroqChat {
  private paused = new Map<string, number>();
  constructor(private readonly chain: Endpoint[]) {}

  get enabled() {
    return this.chain.length > 0;
  }

  get available() {
    return this.chain.some((e) => (this.paused.get(id(e)) ?? 0) <= Date.now());
  }

  get names() {
    return this.chain.map(id);
  }

  async chat(messages: ChatMsg[], tools: ToolDef[], signal?: AbortSignal): Promise<{ msg: ChatMsg; model: string; ms: number; tokens: number } | null> {
    for (const ep of this.chain) {
      const model = ep.model;
      if ((this.paused.get(id(ep)) ?? 0) > Date.now()) continue;
      const t0 = performance.now();
      const res = await fetch(`${BASE_URL[ep.provider]}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ep.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, temperature: 0.2, messages: ep.provider === 'gemini' ? forGemini(messages) : messages, ...(tools.length ? { tools, tool_choice: 'auto', parallel_tool_calls: true } : {}), ...(model.includes('gpt-oss') ? { reasoning_effort: 'low' } : {}) }),
        signal: signal ?? AbortSignal.timeout(ep.provider === 'gemini' ? 6000 : 8000),
      });
      if (res.status === 429) {
        const reset = res.headers.get('x-ratelimit-reset-tokens') ?? res.headers.get('retry-after') ?? '20s';
        this.paused.set(id(ep), Date.now() + parseDur(reset));
        continue;
      }
      if (!res.ok) {
        // 400 tool_use_failed = 모델이 없는 도구를 불렀다 (실측: gpt-oss-20b가 'evidence' 호출). 다음 모델로
        console.warn('[agent]', model, res.status, (await res.text()).slice(0, 160));
        continue;
      }
      const j = (await res.json()) as { choices: { message: ChatMsg }[]; usage?: { total_tokens: number } };
      return { msg: j.choices[0]!.message, model: id(ep), ms: performance.now() - t0, tokens: j.usage?.total_tokens ?? 0 };
    }
    return null;
  }
}

const id = (e: Endpoint) => `${e.provider}/${e.model}`;

function parseDur(v: string): number {
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v) * 1000;
  let ms = 0;
  for (const [, n, u] of v.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) ms += Number(n) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const)[u as 'ms' | 's' | 'm' | 'h'];
  return ms || 20_000;
}

/**
 * 턴 도중 공급사가 바뀌면(예: Groq 한도 → Gemini) 이전 도구 호출 기록에 Gemini 서명(thought_signature)이 없어 400이 난다 (실측).
 * Gemini가 만든 게 아닌 도구 호출·결과는 "이번 턴에 지금까지 한 일" 요약 한 줄로 바꿔 넘긴다.
 */
export function forGemini(messages: ChatMsg[]): ChatMsg[] {
  const foreign = messages.some((m) => m.role === 'assistant' && m.tool_calls?.some((t) => !t.extra_content));
  if (!foreign) return messages;
  const out: ChatMsg[] = [];
  const done: string[] = [];
  const results = new Map(messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m.content ?? '']));
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      for (const t of m.tool_calls) done.push(`${t.function.name}(${t.function.arguments.slice(0, 160)}) → ${(results.get(t.id) ?? '').slice(0, 240)}`);
      continue;
    }
    if (m.role === 'tool') continue;
    out.push(m);
  }
  if (done.length) out.push({ role: 'user', content: `이번 턴에 이미 한 일 (다시 하지 말 것):\n${done.join('\n')}\n이어서 필요한 것만 하라.` });
  return out;
}
