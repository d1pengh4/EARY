import { withParticle } from './normalize';
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
  // 짧은 서비스 번호(3~4자리)도 "~로/~에 신고·연락" 맥락이면 번호다 (실측: 에이전트가 지어낸 "보이스피싱 신고는 1394")
  const out2 = out.replace(/(?<![\d,.])(1\d{2,3})(?=\s*(번|로|으로|에|,|\s*(전화|신고|연락|문의)))/g, (m) => {
    if (OFFICIAL_NUMBERS[m]) return m;
    removed.push(m);
    return '[번호는 기관 공식 홈페이지에서 직접 확인]';
  });
  return { text: out2.replace(/\(\s*\[번호는 기관 공식 홈페이지에서 직접 확인\]\s*\)/g, '(번호는 기관 공식 홈페이지에서 직접 확인)'), removed };
}

/** 단정 표현: 이어리는 "사기다"라고 단정하지 않는다 (실측: 에이전트 메모 "보이스피싱입니다! 즉시…") */
export const ASSERTIVE = /(사기|보이스\s?피싱|스미싱|피싱)(입니다|이다|예요|이에요|네요|가 맞|임이 확실)|확실히 사기|틀림없이|100%/;

/** 단정 문장을 "의심돼요"로 누그러뜨리고, 그래도 남으면 null */
export function soften(text: string): string | null {
  const t = text.replace(/(사기|보이스\s?피싱|스미싱|피싱)(입니다|이다|예요|이에요|네요)[!.]?/g, (_m, w: string) => `${withParticle(w, '이', '가')} 의심돼요.`).replace(/!+/g, '.');
  return ASSERTIVE.test(t) ? null : t;
}

/**
 * 확인되지 않은 신고처·센터 이름이 있으면 true. 그런 문장은 화면에 올리지 않는다.
 * 실기 (2026-10-25): 에이전트가 사건 지도 메모에 "112나 찐센터로 신고하세요"라고 없는 신고처를 지어냈다.
 */
const KNOWN_CHANNELS = /(경찰|112|금융감독원|금감원|1332|검찰|1301|118|한국인터넷진흥원|불법스팸|보이스피싱|통합신고|사이버수사|국민건강보험공단|고객)/;
export function unknownChannel(text: string): boolean {
  for (const m of text.matchAll(/([가-힣A-Za-z0-9]{1,12})\s?(신고센터|센터)/g)) {
    if (!KNOWN_CHANNELS.test(m[1]!)) return true;
  }
  return false;
}
