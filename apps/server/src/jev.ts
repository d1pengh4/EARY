// D1 1차 의사결정: TypeSafe Jev (System One). 판단만 하고 글은 쓰지 않는다. (§7.4)
import type { SignalCategory } from '@eary/schema';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const TIMEOUT_MS = 600;

type Q =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> };

export interface JevAnswers {
  model: string;
  ms: number;
  noul: Record<string, number>;
  choice: Record<string, { choice: string; confidence: number; probabilities: Record<string, number> }>;
}

export const SIGNAL_QUESTIONS: Partial<Record<SignalCategory, string>> = {
  secrecy: 'last 발화에서 상대가 통화 내용을 다른 사람에게 말하지 말라고 하거나 다른 곳에 연락하지 말라고 요구하는가? (context는 참고만)',
  time_pressure: 'last 발화에서 상대가 즉시 또는 짧은 기한 안에 행동하라고 압박하는가? (context는 참고만)',
  money_transfer: 'last 발화에서 상대가 송금이나 계좌 이체를 요구하는가? (context는 참고만)',
  credential_request: 'last 발화에서 상대가 인증번호·비밀번호 등 인증정보를 요구하는가? (context는 참고만)',
  remote_app: 'last 발화에서 상대가 앱 설치나 원격 제어를 요구하는가? (context는 참고만)',
  // 실기: 이 두 질문이 없어서 규칙이 잡은 기관 사칭·고립 신호가 Jev 경로에서 끝내 확정되지 않았다
  impersonation: 'last 발화에서 상대가 사용자 명의·계좌가 범죄나 사건에 연루됐다고 하거나, 녹취·압수·출석 같은 수사 절차를 들어 겁을 주는가? (context는 참고만)',
  isolation: 'last 발화에서 상대가 사용자를 혼자 있게 하거나, 조용한 곳으로 옮기게 하거나, 통화를 끊지 못하게 하는가? (context는 참고만)',
};
export const AUTHORITY_QUESTION = 'last 발화에서 상대가 수사기관·금융기관 등 공공기관 소속이라고 주장하는가?';

export class JevClient {
  breakerOpenUntil = 0;
  private failures = 0;
  constructor(private readonly apiKey: string | undefined) {}

  get enabled() {
    return Boolean(this.apiKey) && Date.now() > this.breakerOpenUntil;
  }

  async decide(state: unknown, questions: Record<string, Q>): Promise<JevAnswers | null> {
    if (!this.enabled) return null;
    const t0 = performance.now();
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'jev-latest', state, questions }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`jev ${res.status}`);
      const body = (await res.json()) as { model: string; answers: Record<string, { type: string; noul?: number; choice?: string; confidence?: number; probabilities?: Record<string, number> }> };
      this.failures = 0;
      const out: JevAnswers = { model: body.model, ms: performance.now() - t0, noul: {}, choice: {} };
      for (const [k, a] of Object.entries(body.answers)) {
        if (a.type === 'noul' && typeof a.noul === 'number') out.noul[k] = a.noul;
        if (a.type === 'choice' && a.choice) out.choice[k] = { choice: a.choice, confidence: a.confidence ?? 0, probabilities: a.probabilities ?? {} };
      }
      return out;
    } catch (err) {
      // 연속 3회 실패하면 30초 동안 서킷을 연다 (§15)
      if (++this.failures >= 3) { this.breakerOpenUntil = Date.now() + 30_000; this.failures = 0; }
      console.warn('[jev]', (err as Error).message);
      return null;
    }
  }
}

export const noul = (instructions: string): Q => ({ type: 'noul', instructions });
export const choice = (instructions: string, criteria: Record<string, string>): Q => ({ type: 'choice', instructions, criteria });
