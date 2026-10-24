import { describe, expect, test } from 'bun:test';
import { relevant } from '../src/agent';
import { merge, tierOf } from '../src/search';

describe('검색 관련성·등급', () => {
  test('무관한 위키백과 문서는 걸러진다 (실측)', () => {
    expect(relevant({ title: '문재인', snippet: '대한민국의 제19대 대통령', tier: 'reference' }, '국민건강보험공단 공식 대표전화')).toBe(false);
    expect(relevant({ title: '국민건강보험공단', snippet: '보건복지부 산하 준정부기관', tier: 'reference' }, '국민건강보험공단 공식 대표전화')).toBe(true);
    expect(relevant({ title: '온라인 뱅킹', snippet: '공무원 사칭 범죄가 늘고', tier: 'reference' }, '국민건강보험공단 사칭 전화 사기')).toBe(false);
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
