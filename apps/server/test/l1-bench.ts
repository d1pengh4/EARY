// L1 모델 벤치 (§19 Q1): 대본·실측 STT 문장으로 지연·재현율·인용 유효율·JSON 오류를 잰다.
// bun apps/server/test/l1-bench.ts
import { FastLlm, type L1Entity } from '../src/fastLlm';

const CASES: { ctx: string; last: string; expect: [string, RegExp][] }[] = [
  { ctx: '', last: '상대: 서울중앙지검 소속 홍길동 검사입니다 본인 명의 계좌가 범주에 연루되어 연락드렸습니다', expect: [['org', /서울중앙지검/], ['person', /홍길동/], ['account', /계좌/]] },
  { ctx: '나: 사건번호가 어떻게 되나요', last: '상대: 2026 현제 4만 8271호입니다 가족에게도 말씀하지 마세요', expect: [['case', /2026/]] },
  { ctx: '', last: '상대: 계좌가 동결되기 전에 안전 계좌로 지금 바로 이체하셔야 합니다', expect: [['demand', /이체|안전/]] },
  { ctx: '', last: '상대: 문자로 가는 인증번호도 바로 불러주세요', expect: [['demand', /인증번호/]] },
  { ctx: '', last: '상담원: 두 상품을 결합하시면 월 12만원 정도 나옵니다', expect: [['amount', /12만|120,?000/]] },
  { ctx: '나: 약정이 있나요 설치는 언제쯤 되나요', last: '상담원: 36개월 약정이고 설치는 다음 주 중에 가능합니다 오늘 가입하시면 할인 혜택이 있어요', expect: [['duration', /36/], ['date', /다음 ?주/], ['condition', /할인/]] },
  // 대본 밖 (자유 실행): 처음 보는 기관·조건
  { ctx: '', last: '상대: 국민건강보험공단 환급 담당 김민수 주임입니다 미환급금 23만 4천원이 있어서 연락드렸어요', expect: [['org', /건강보험/], ['person', /김민수/], ['amount', /23만|234,?000/]] },
  { ctx: '', last: '상대: 내일 오후 3시까지 서류를 보내주셔야 예약이 확정됩니다', expect: [['date', /내일|3시/], ['condition', /서류/]] },
];

const CANDIDATES: { model: string; extra?: Record<string, unknown>; label: string }[] = [
  { model: 'openai/gpt-oss-20b', extra: { reasoning_effort: 'low' }, label: 'gpt-oss-20b (low)' },
  { model: 'openai/gpt-oss-120b', extra: { reasoning_effort: 'low' }, label: 'gpt-oss-120b (low)' },
  { model: 'qwen/qwen3.8-27b', extra: {}, label: 'qwen3.8-27b' },
  { model: 'qwen/qwen3.8-27b', extra: { reasoning_effort: 'none' }, label: 'qwen3.8-27b (no think)' },
];
const ROUNDS = 2;
const GAP_MS = Number(process.env.BENCH_GAP_MS ?? 0); // 무료 등급 분당 8k 토큰 한도를 피하려면 6500
const only = process.argv.slice(2);
const pct = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] ?? NaN;

for (const c of CANDIDATES.filter((x) => !only.length || only.some((o) => x.label.includes(o)))) {
  const l1 = new FastLlm({ ...process.env, L1_PROVIDER: 'groq' }, { model: c.model, extra: c.extra });
  const first: number[] = [];
  const total: number[] = [];
  let hit = 0, want = 0, ents = 0, validQuote = 0, errors = 0, empty = 0;
  let lastErr = '';
  for (let r = 0; r < ROUNDS; r++) {
    for (const k of CASES) {
      if (GAP_MS) await Bun.sleep(GAP_MS);
      const got: L1Entity[] = [];
      try {
        const res = await l1.extract(k.ctx, k.last, (e) => got.push(e), () => {});
        if (res) { total.push(res.totalMs); if (res.firstMs !== undefined) first.push(res.firstMs); }
      } catch (e) { errors++; lastErr = (e as Error).message; continue; }
      if (!got.length) empty++;
      const text = k.last.slice(k.last.indexOf(':') + 1).replace(/\s+/g, '');
      for (const e of got) { ents++; if (e.quote && text.includes(e.quote.replace(/\s+/g, ''))) validQuote++; }
      for (const [type, re] of k.expect) {
        want++;
        if (got.some((e) => (e.type === type || (type === 'demand' && e.type === 'condition') || (type === 'condition' && e.type === 'demand')) && re.test(`${e.value} ${e.name ?? ''} ${e.quote ?? ''}`))) hit++;
      }
    }
  }
  console.log(`${c.label.padEnd(24)} 첫 엔티티 p50 ${pct(first, 0.5).toFixed(0).padStart(5)}ms p95 ${pct(first, 0.95).toFixed(0).padStart(5)}ms | 전체 p50 ${pct(total, 0.5).toFixed(0).padStart(5)}ms | 재현율 ${((hit / want) * 100).toFixed(0)}% | 인용 유효 ${ents ? ((validQuote / ents) * 100).toFixed(0) : '-'}% | 빈 응답 ${empty} | 오류 ${errors}${lastErr ? ` (${lastErr.slice(0, 90)})` : ''}`);
}
process.exit(0);
