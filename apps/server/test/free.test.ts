// 자유 실행 회귀 세트 (§14.2): 대본 밖 대화. 크래시 0, 정상 대화 경고 0, 사기는 주의 이상. L0만으로(키 없이) 돌린다.
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createL0 } from '@eary/core';
import { loadPacks, loadYaml } from '@eary/core/src/load';
import type { RiskLevel } from '@eary/schema';
import cases from '../../../packages/scenario/free/cases.json';
import { FastLlm } from '../src/fastLlm';
import { JevClient } from '../src/jev';
import { RtzrAuth } from '../src/rtzr';
import { CallSession } from '../src/session';
import { createVerifier, type MockData } from '../src/verify';

const DATA = join(import.meta.dir, '../../../data');
const packs = loadPacks(DATA);
const l0 = createL0(packs.lexicon, Object.values(packs.domains));
const verifier = createVerifier(loadYaml<MockData>(join(DATA, 'mock/lookups.yaml')));
const ORDER: Record<RiskLevel, number> = { none: 0, caution: 1, accumulating: 2, final: 3 };

describe('자유 실행 회귀 세트', () => {
  for (const c of cases as { id: string; kind: string; expect: { maxRisk?: RiskLevel; minRisk?: RiskLevel }; lines: ['me' | 'other', string][] }[]) {
    test(`${c.kind} · ${c.id}`, async () => {
      const s = new CallSession({ packs, l0, jev: new JevClient(undefined), l1: new FastLlm({}), verifier, rtzr: new RtzrAuth(undefined, undefined), audioDir: '', send: () => {} });
      s.start('type');
      c.lines.forEach(([sp, text], i) => s.onFinal(`t${i}`, sp, text, i * 3000, i * 3000 + 2000));
      await new Promise((r) => setTimeout(r, 450));
      s.handle({ t: 'call.end' });
      const lv = s.state.risk.level;
      if (c.expect.maxRisk) expect(`${c.id}:${lv}`).toBe(`${c.id}:${ORDER[lv] <= ORDER[c.expect.maxRisk] ? lv : c.expect.maxRisk + '이하여야 함'}`);
      if (c.expect.minRisk) expect(`${c.id}:${ORDER[lv] >= ORDER[c.expect.minRisk] ? 'ok' : lv}`).toBe(`${c.id}:ok`);
      expect(s.state.review).toBeDefined();
      console.log(`  ${c.id.padEnd(16)} ${lv.padEnd(12)} ${s.state.risk.activeCategories.join(',')}`);
      s.dispose();
    });
  }
});
