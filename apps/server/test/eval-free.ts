// 심사·보고용 평가: 자유 실행 회귀 세트를 실제 서버(Jev·Groq 포함)에 넣어 오탐·탐지·경고 시점을 잰다.
// 사용: 서버를 켠 뒤 bun apps/server/test/eval-free.ts > docs/EVAL.md
import { applyOps, initialState } from '@eary/core';
import type { CallState, RiskLevel, S2C } from '@eary/schema';
import cases from '../../../packages/scenario/free/cases.json';

const ORDER: Record<RiskLevel, number> = { none: 0, caution: 1, accumulating: 2, final: 3 };
const LABEL: Record<RiskLevel, string> = { none: '없음', caution: '주의', accumulating: '누적', final: '최종' };
type Case = { id: string; kind: 'normal' | 'scam'; expect: { maxRisk?: RiskLevel; minRisk?: RiskLevel }; lines: ['me' | 'other', string][] };
const SIG: Record<string, string> = { impersonation: '기관 사칭', secrecy: '비밀 유지', isolation: '고립', time_pressure: '시간 압박', unverifiable_case: '사건 확인 불가', official_mismatch: '공식 안내와 다름', money_transfer: '송금 요구', credential_request: '인증정보 요구', remote_app: '앱 설치 요구' };
const GAP = Number(process.env.GAP ?? 2500);

async function run(c: Case) {
  const ws = new WebSocket('ws://localhost:8787/ws');
  let st: CallState = initialState('x');
  let sentAt = 0;
  const lat: number[] = [];
  let prev: RiskLevel = 'none';
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data as string) as S2C;
    if (m.t === 'welcome') st = m.snapshot;
    if (m.t === 'ops') { st = applyOps(st, m.ops); if (ORDER[st.risk.level] > ORDER[prev]) { lat.push(performance.now() - sentAt); prev = st.risk.level; } }
  };
  await new Promise((r) => (ws.onopen = r));
  ws.send(JSON.stringify({ t: 'hello' }));
  await Bun.sleep(300);
  ws.send(JSON.stringify({ t: 'call.start', mode: 'type', consentNotified: true }));
  await Bun.sleep(300);
  const levels: RiskLevel[] = [];
  for (const [speaker, text] of c.lines) {
    sentAt = performance.now();
    ws.send(JSON.stringify({ t: 'type.inject', speaker, text }));
    await Bun.sleep(GAP);
    levels.push(st.risk.level);
  }
  const first = levels.findIndex((l) => l !== 'none');
  const fin = levels.indexOf('final');
  const level = st.risk.level;
  const cats = [...st.risk.activeCategories];
  const ok = c.expect.maxRisk ? ORDER[level] <= ORDER[c.expect.maxRisk] : ORDER[level] >= ORDER[c.expect.minRisk!];
  ws.send(JSON.stringify({ t: 'call.new' }));
  await Bun.sleep(200);
  ws.close();
  return { c, level, ok, first, fin, cats, lat };
}

const rows = [];
for (const c of cases as Case[]) rows.push(await run(c));
const normal = rows.filter((r) => r.c.kind === 'normal');
const scam = rows.filter((r) => r.c.kind === 'scam');
const fp = normal.filter((r) => r.level !== 'none').length;
const detected = scam.filter((r) => r.level !== 'none').length;
const finals = scam.filter((r) => r.level === 'final').length;
const allLat = rows.flatMap((r) => r.lat).sort((a, b) => a - b);
const pct = (p: number) => (allLat.length ? allLat[Math.min(allLat.length - 1, Math.floor(allLat.length * p))]! : NaN);

console.log(`# 자유 실행 평가 (실제 Jev·Groq 경로)\n`);
console.log(`- 측정일: ${new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })} · 대화 ${rows.length}편 (정상 ${normal.length}, 사기 ${scam.length}) · 문장 간격 ${GAP}ms · 글 입력(STT 제외)`);
console.log(`- 정상 통화 오탐(주의 이상): **${fp}/${normal.length}**`);
console.log(`- 사기 탐지(주의 이상): **${detected}/${scam.length}** · 최종 경고까지: **${finals}/${scam.length}**`);
console.log(`- 문장 입력 → 위험 단계 반영: 중앙값 **${Math.round(pct(0.5))}ms**, p95 ${Math.round(pct(0.95))}ms (단계가 오른 ${allLat.length}회)\n`);
console.log('| 대화 | 종류 | 최종 단계 | 기대 | 첫 경고(몇 번째 문장) | 최종 경고(몇 번째 문장) | 잡힌 신호 |');
console.log('|---|---|---|---|---|---|---|');
for (const r of rows) {
  const exp = r.c.expect.maxRisk ? `${LABEL[r.c.expect.maxRisk]} 이하` : `${LABEL[r.c.expect.minRisk!]} 이상`;
  console.log(`| ${r.c.id} | ${r.c.kind === 'normal' ? '정상' : '사기'} | ${LABEL[r.level]}${r.ok ? '' : ' ✗'} | ${exp} | ${r.first < 0 ? '-' : `${r.first + 1}/${r.c.lines.length}`} | ${r.fin < 0 ? '-' : `${r.fin + 1}/${r.c.lines.length}`} | ${r.cats.map((x) => SIG[x] ?? x).join(', ') || '-'} |`);
}
process.exit(0);
