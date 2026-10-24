import { describe, expect, test } from 'bun:test';
import { convertFigure, normalizeData, relevant, sanitizeFigure } from '../src/agent';
import { merge, tierOf } from '../src/search';

describe('검색 관련성·등급', () => {
  test('무관한 위키백과 문서는 걸러진다 (실측)', () => {
    expect(relevant({ title: '문재인', snippet: '대한민국의 제19대 대통령', tier: 'reference' }, '국민건강보험공단 공식 대표전화')).toBe(false);
    expect(relevant({ title: '국민건강보험공단', snippet: '보건복지부 산하 준정부기관', tier: 'reference' }, '국민건강보험공단 공식 대표전화')).toBe(true);
    expect(relevant({ title: '온라인 뱅킹', snippet: '공무원 사칭 범죄가 늘고', tier: 'reference' }, '국민건강보험공단 사칭 전화 사기')).toBe(false);
    // 공식 도메인이라도 검색어가 하나만 맞으면 제외 (실기 회귀)
    expect(relevant({ title: '(석간) 서울브랜드굿즈 공모', snippet: '재단은 상품화 공모를', tier: 'official' }, '인터넷 휴대폰 결합 요금 위약금')).toBe(false);
    expect(relevant({ title: '약정기간과 위약금 확인', snippet: '인터넷 결합 상품 해지 시 위약금', tier: 'official' }, '인터넷 휴대폰 결합 요금 위약금')).toBe(true);
  });
  test('공식 도메인 등급', () => {
    expect(tierOf('nhis.or.kr', 'naver')).toBe('official');
    expect(tierOf('www.spo.go.kr', 'kakao')).toBe('official');
    expect(tierOf('news.kbs.co.kr', 'naver')).toBe('news');
    expect(tierOf('blog.naver.com', 'naver')).toBe('reference');
  });
  test('같은 URL은 합치고 공식 자료가 먼저', () => {
    const m = merge([
      { title: '블로그 후기', url: 'https://blog.example.com/a', host: 'blog.example.com', snippet: '건강보험 환급 사기', provider: 'naver', tier: 'reference' },
      { title: '건강보험 환급 안내', url: 'https://www.nhis.or.kr/x?a=1', host: 'nhis.or.kr', snippet: '환급 사기 주의', provider: 'naver', tier: 'official' },
      { title: '건강보험 환급 안내', url: 'https://nhis.or.kr/x', host: 'nhis.or.kr', snippet: '환급 사기 주의', provider: 'kakao', tier: 'official' },
    ], '건강보험 환급 사기');
    expect(m).toHaveLength(2);
    expect(m[0]!.host).toBe('nhis.or.kr');
    expect(m[0]!.providers).toEqual(['naver', 'kakao']);
  });
});

import { forGemini } from '../src/groqChat';
describe('공급사 전환', () => {
  test('Groq 도구 호출 기록은 Gemini에 요약으로 넘긴다 (thought_signature 400 회귀)', () => {
    const msgs = forGemini([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"q"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"results":[]}' },
    ]);
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'user']);
    expect(msgs[2]!.content).toContain('web_search');
    expect(msgs.some((m) => m.tool_calls)).toBe(false);
  });
  test('Gemini 자신의 기록(서명 있음)은 그대로', () => {
    const own = [{ role: 'assistant' as const, content: '', tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'row', arguments: '{}' }, extra_content: { google: { thought_signature: 'x' } } }] }];
    expect(forGemini(own)).toBe(own);
  });
});

describe('에이전트 draw 검증', () => {
  test('형식이 맞는 관계도만 통과, 없는 노드를 가리키는 선은 버린다', () => {
    const f = sanitizeFigure('graph', 'ag:g', '관계', { nodes: [{ id: 'a', label: '홍길동', tone: 'claim' }, { id: 'b', label: '안전계좌', tone: 'danger' }], edges: [{ from: 'a', to: 'b', label: '이체 요구', style: 'money' }, { from: 'a', to: 'zzz' }] });
    expect(f?.kind === 'graph' && f.edges.length).toBe(1);
    expect(sanitizeFigure('graph', 'ag:x', 't', { nodes: [{ id: 'a', label: 'x' }] })).toBeNull();
    expect(sanitizeFigure('unknown', 'ag:x', 't', {})).toBeNull();
  });
  test('그림 글에도 단정 금지·번호 차단', () => {
    const q = sanitizeFigure('quote', 'ag:q', '결정적', { quote: '보이스피싱입니다! 1394로 신고하세요', speaker: '이어리', tone: 'danger' });
    expect(q?.kind === 'quote' && q.quote).not.toContain('1394');
    expect(q?.kind === 'quote' && q.quote).toContain('의심돼요');
  });
});

describe('draw 너그러운 형식·자동 변환 (실기 회귀)', () => {
  test('graph가 items로 와도 노드로 받고 순서대로 잇는다', () => {
    const f = sanitizeFigure('graph', 'ag:g', '흐름', { items: [{ label: '기관 사칭', tone: 'warn' }, { label: '비밀 유지 강요', tone: 'warn' }, { label: '금전 요구', tone: 'danger' }] });
    expect(f?.kind === 'graph' && [f.nodes.length, f.edges.length]).toEqual([3, 2]);
  });
  test('이미 있는 체크리스트는 순서도로 바꿔 그린다', () => {
    const c = convertFigure('checklist', { items: [{ text: '끊기' }, { text: '대표번호로 확인' }] }, ['flow', 'graph']);
    expect(c?.kind).toBe('flow');
    expect(sanitizeFigure(c!.kind, 'ag:f', '할 일 순서', c!.data)?.kind).toBe('flow');
  });
});

test('종류 이름을 키로 쓴 데이터도 받는다 (실기: {"checklist":[...]})', () => {
  const d = normalizeData('checklist', { checklist: [{ text: '끊기', done: false }] });
  expect(sanitizeFigure('checklist', 'ag:c', '할 일', d)?.kind).toBe('checklist');
  expect(normalizeData('flow', '[{"label":"a","state":"now"}]').steps.length).toBe(1);
});
