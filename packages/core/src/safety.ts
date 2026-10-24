// 안전장치: LLM·검색이 만든 문장에서 확인되지 않은 전화번호를 지운다.
// 실측 (2026-10-24): AI 답변이 검색 결과의 번호(010-…, 업체 블로그)를 "서울중앙지검 공식 대표번호"로 안내했다.
// 사칭 피해를 막는 서비스가 엉뚱한 번호로 전화하게 만들면 안 되므로, 미리 검증한 공식 번호만 남긴다.

/** 검증된 공식 번호 (기관 공식 안내 기준). 여기에 없는 번호는 화면에 내보내지 않는다 */
export const OFFICIAL_NUMBERS: Record<string, string> = {
  '112': '경찰청 신고',
  '1332': '금융감독원',
  '1301': '검찰청 민원',
  '1577-1000': '국민건강보험공단',
  '118': '한국인터넷진흥원 불법스팸·해킹',
};

const PHONE = /(?<!\d)(?:0\d{1,2}[-.\s)]?\d{3,4}[-.\s]?\d{4}|1\d{3}[-.\s]?\d{4}|11[28]|1332|1301)(?!\d)/g;
const norm = (s: string) => s.replace(/[.\s)]/g, '-').replace(/-+/g, '-');

export function scrubPhones(text: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  // LLM은 일반 하이픈 대신 U+2011(줄바꿈 없는 하이픈) 등을 쓴다 (실측) → 먼저 통일
  const out = text.replace(/[\u2010-\u2015\u2212\uFE63\uFF0D]/g, '-').replace(PHONE, (m) => {
    if (OFFICIAL_NUMBERS[norm(m)]) return m;
    removed.push(m);
    return '[번호는 기관 공식 홈페이지에서 직접 확인]';
  });
  // "(…)" 안에 지운 번호만 남은 괄호·이름 꾸밈 정리
  return { text: out.replace(/\(\s*\[번호는 기관 공식 홈페이지에서 직접 확인\]\s*\)/g, '(번호는 기관 공식 홈페이지에서 직접 확인)'), removed };
}
