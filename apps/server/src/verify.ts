// 검증 어댑터. 시연용 가상 데이터는 아는 항목에만 답하고, 모르면 no_source (위험 신호에서 제외). (§10, §14.1)
import type { Tariff } from '@eary/core';
import type { SignalCategory, UnverifiableReason, VerificationStatus } from '@eary/schema';

export interface MockData {
  prosecutorList: Record<string, { name: string; dept: string; title: string }[]>;
  caseLookup: { orgs: string[]; cases: string[] };
  officialCorpus: { id: string; title: string; quote: string; applies: SignalCategory[]; orgKinds?: string[] }[];
  tariff?: Record<string, Tariff>;
}

export interface VerifyResult {
  status: VerificationStatus;
  reason?: UnverifiableReason;
  title: string;
  scope: string;
  query: string;
  resultCount?: number;
  quote?: string;
  caveat?: string;
  isMock: boolean;
  tier: 'official' | 'lookup' | 'reference';
}

/** 가상 조회도 실제처럼 약간의 지연을 둔다 (결정론적 고정값) */
const MOCK_LATENCY_MS = 350;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createVerifier(mock: MockData) {
  return {
    /** 시연용 가상 요금표 (상품명 → 요금). 모르는 상품은 undefined */
    tariff(product: string): Tariff | undefined {
      return mock.tariff?.[product];
    },

    async prosecutor(org: string, name: string): Promise<VerifyResult> {
      await delay(MOCK_LATENCY_MS);
      const list = mock.prosecutorList[org];
      const base = { title: `${org} 검사 목록`, query: name, isMock: true, tier: 'lookup' as const };
      if (!list) return { ...base, status: 'unverifiable', reason: 'no_source', scope: '이 기관의 목록은 아직 조회할 곳이 연결되지 않았어요' };
      const hit = list.filter((p) => p.name === name);
      return hit.length
        ? { ...base, status: 'found', resultCount: hit.length, scope: `확인 범위 · ${org} 공개 검사 목록`, caveat: '목록에 있어도 통화 상대가 그 사람이라는 뜻은 아니에요.' }
        : { ...base, status: 'unverifiable', reason: 'not_found', resultCount: 0, scope: `확인 범위 · ${org} 공개 검사 목록`, caveat: '목록 밖 인사일 가능성이 남아 있어, 사기로 단정하지는 않아요.' };
    },

    async caseNo(caseNo: string, org?: string): Promise<VerifyResult> {
      await delay(MOCK_LATENCY_MS);
      const base = { title: '공개 사건 조회', query: caseNo, isMock: true, tier: 'lookup' as const };
      if (org && !mock.caseLookup.orgs.includes(org)) return { ...base, status: 'unverifiable', reason: 'no_source', scope: '이 기관의 사건 조회는 아직 연결되지 않았어요' };
      const hit = mock.caseLookup.cases.includes(caseNo);
      return hit
        ? { ...base, status: 'found', resultCount: 1, scope: '확인 범위 · 공개 사건 조회' }
        : { ...base, status: 'unverifiable', reason: 'not_found', resultCount: 0, scope: '확인 범위 · 공개 사건 조회', caveat: '비공개 수사 가능성은 배제 못 해요.' };
    },

    async official(categories: SignalCategory[], orgKind?: string): Promise<VerifyResult | null> {
      await delay(MOCK_LATENCY_MS);
      // 기관 종류가 맞는 문서 중 겹치는 요구가 가장 많은 것 (실측: 건강보험공단 통화에 "수사기관은…" 문서가 붙었다)
      const doc = mock.officialCorpus
        .filter((d) => !d.orgKinds || d.orgKinds.includes(orgKind ?? ''))
        .map((d) => ({ d, n: d.applies.filter((c) => categories.includes(c)).length }))
        .filter((x) => x.n > 0)
        .sort((a, b) => b.n - a.n)[0]?.d;
      if (!doc) return null;
      return { status: 'mismatch', title: doc.title, quote: doc.quote, scope: '확인 범위 · 공식 안내 페이지 본문', query: categories.join(','), isMock: true, tier: 'official' };
    },
  };
}
export type Verifier = ReturnType<typeof createVerifier>;
