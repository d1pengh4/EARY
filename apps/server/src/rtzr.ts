// RTZR 스트리밍 STT 어댑터. 채널(나/상대)마다 WebSocket 1개. 토큰은 서버에서만 쓴다. (§7.3, §16)
const AUTH_URL = 'https://openapi.vito.ai/v1/authenticate';
const STREAM_URL = 'wss://openapi.vito.ai/v1/transcribe:streaming';
export const SAMPLE_RATE = 16000;

export interface RtzrResult {
  seq: number;
  start_at: number;
  duration: number;
  final: boolean;
  alternatives: { text: string; confidence?: number }[];
}

export class RtzrAuth {
  private token: string | null = null;
  private expireAt = 0; // epoch seconds
  private inflight: Promise<string> | null = null;
  constructor(private readonly id: string | undefined, private readonly secret: string | undefined) {}

  get enabled() {
    return Boolean(this.id && this.secret);
  }

  /** 6시간 유효 JWT. 만료 10분 전에 미리 갱신한다. */
  async get(): Promise<string> {
    if (this.token && Date.now() / 1000 < this.expireAt - 600) return this.token;
    this.inflight ??= (async () => {
      const res = await fetch(AUTH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.id!, client_secret: this.secret! }),
      });
      if (!res.ok) throw new Error(`rtzr auth ${res.status}`);
      const j = (await res.json()) as { access_token: string; expire_at: number };
      this.token = j.access_token;
      this.expireAt = j.expire_at;
      return j.access_token;
    })().finally(() => { this.inflight = null; });
    return this.inflight;
  }
}

export interface RtzrStreamEvents {
  onResult(r: RtzrResult): void;
  onClose(code: number, reason: string): void;
  onError?(err: unknown): void;
}

export class RtzrStream {
  private ws: WebSocket | null = null;
  private queue: Uint8Array[] = [];
  private open = false;
  closed = false;

  constructor(private readonly auth: RtzrAuth, private readonly ev: RtzrStreamEvents) {}

  async start() {
    const token = await this.auth.get();
    const qs = new URLSearchParams({ sample_rate: String(SAMPLE_RATE), encoding: 'LINEAR16', use_itn: 'true', use_disfluency_filter: 'false', use_profanity_filter: 'false' });
    // Bun의 WebSocket은 headers 옵션을 지원한다
    const ws = new WebSocket(`${STREAM_URL}?${qs}`, { headers: { Authorization: `Bearer ${token}` } } as unknown as string[]);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.open = true;
      for (const q of this.queue) ws.send(q);
      this.queue = [];
    };
    ws.onmessage = (e) => {
      try { this.ev.onResult(JSON.parse(String(e.data)) as RtzrResult); } catch (err) { this.ev.onError?.(err); }
    };
    ws.onerror = (e) => this.ev.onError?.(e);
    ws.onclose = (e) => { this.closed = true; this.open = false; this.ev.onClose(e.code, e.reason); };
  }

  /** PCM16LE mono 16kHz */
  push(pcm: Uint8Array) {
    if (this.closed) return;
    if (this.open && this.ws) this.ws.send(pcm);
    else this.queue.push(pcm);
  }

  end() {
    if (this.open && this.ws) this.ws.send('EOS');
  }

  close() {
    this.closed = true;
    try { this.ws?.close(); } catch { /* 이미 닫힘 */ }
  }
}
