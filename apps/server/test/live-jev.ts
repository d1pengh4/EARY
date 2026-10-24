// 실제 Jev로 대본을 돌려 보는 수동 스크립트: bun apps/server/test/live-jev.ts [scenarioId]
import { join } from 'node:path';
import { createL0 } from '@eary/core';
import { loadPacks, loadYaml } from '@eary/core/src/load';
import { SCENARIOS } from '@eary/scenario';
import type { S2C } from '@eary/schema';
import { FastLlm } from '../src/fastLlm';
import { JevClient } from '../src/jev';
import { RtzrAuth } from '../src/rtzr';
import { CallSession } from '../src/session';
import { createVerifier, type MockData } from '../src/verify';

const DATA = join(import.meta.dir, '../../../data');
const packs = loadPacks(DATA);
const spans: Record<string, number[]> = {};
const session = new CallSession({
  packs, l0: createL0(packs.lexicon, Object.values(packs.domains)), jev: new JevClient(process.env.TYPESAFE_API_KEY),
  rtzr: new RtzrAuth(undefined, undefined), audioDir: '', l1: new FastLlm({}), verifier: createVerifier(loadYaml<MockData>(join(DATA, 'mock/lookups.yaml'))),
  send: (m: S2C) => { if (m.t === 'metrics') for (const s of m.spans) (spans[s.name] ??= []).push(s.ms); },
});
const sc = SCENARIOS[process.argv[2] ?? 'impersonation-01']!;
session.start('replay-fixture', undefined, true, sc.callerNumber);
let i = 0;
for (const step of sc.steps) {
  for (const u of step.utterances) {
    const id = `u${++i}`;
    session.onFinal(id, u.speaker, u.text, u.atMs, u.atMs + 1000);
    await new Promise((r) => setTimeout(r, 900));
    const st = session.state;
    const tags = st.utterances[id]?.tags.join(',') || '-';
    console.log(`${id} [${u.speaker}] risk=${st.risk.level.padEnd(12)} domain=${st.domain.padEnd(13)} tags=${tags.padEnd(16)} next=${st.suggestions[0]?.id ?? '-'}`);
  }
  console.log(`── step ${step.step} 기대 ${step.expect?.risk ?? '-'} / 실제 ${session.state.risk.level}`);
}
const p = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]!.toFixed(0);
for (const [k, xs] of Object.entries(spans)) console.log(`${k}: n=${xs.length} p50=${p(xs, 0.5)}ms p95=${p(xs, 0.95)}ms`);
console.log('situation:', session.state.situation.text);
session.dispose();
process.exit(0);
