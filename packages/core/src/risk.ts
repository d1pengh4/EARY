// 위험 엔진: 결정론적 상태기계. LLM·Jev는 신호 후보만 내고, 단계는 여기서만 계산한다. (§9, 원칙 P2)
import { ACTION_CATEGORIES, type Domain, type Ms, type RiskLevel, type RiskSignal, type RiskState, type SignalCategory } from '@eary/schema';

const ORDER: Record<RiskLevel, number> = { none: 0, caution: 1, accumulating: 2, final: 3 };
const CASE_FAILURES: SignalCategory[] = ['unverifiable_case', 'official_mismatch'];

export interface RiskInput {
  signals: RiskSignal[];
  domain: Domain;
  /** 도메인 게이트: 이 카테고리는 행동 신호와 함께일 때만 센다 */
  gate: SignalCategory[];
}

export function computeLevel({ signals, gate }: RiskInput): { level: RiskLevel; categories: SignalCategory[]; because: string[] } {
  const live = signals.filter((s) => s.active && s.confirmed);
  const hasAction = live.some((s) => ACTION_CATEGORIES.includes(s.category));
  const counted = live.filter((s) => hasAction || !gate.includes(s.category));
  const categories = [...new Set(counted.map((s) => s.category))];
  const because = counted.map((s) => s.id);

  const actions = categories.filter((c) => ACTION_CATEGORIES.includes(c));
  const others = categories.length - actions.length;
  const caseFail = categories.some((c) => CASE_FAILURES.includes(c));

  let level: RiskLevel = 'none';
  if (categories.length >= 1) level = 'caution';
  if (categories.length >= 4 || (categories.length >= 2 && caseFail)) level = 'accumulating';
  // 서로 다른 행동 요구가 둘 이상(예: 앱 설치 + 비밀번호)이면 그것만으로 최종 (자유 실행 실측)
  if ((actions.length >= 1 && others >= 2) || actions.length >= 2) level = 'final';
  return { level, categories, because };
}

/**
 * 단계는 내려가지 않는다. 예외: 발언 고치기로 근거가 비활성화된 경우(allowDowngrade).
 */
export function nextRisk(prev: RiskState, input: RiskInput, atMs: Ms, allowDowngrade = false): RiskState {
  const { level: computed, categories, because } = computeLevel(input);
  const level = allowDowngrade || ORDER[computed] >= ORDER[prev.level] ? computed : prev.level;
  const changed = level !== prev.level;
  const next: RiskState = {
    level,
    activeCategories: categories,
    finalWarning: prev.finalWarning,
    history: changed ? [...prev.history, { level, atMs, because }] : prev.history,
  };
  if (level === 'final' && !prev.finalWarning) {
    next.finalWarning = { reasons: because, shownAtMs: atMs, dismissed: false };
  } else if (level === 'final' && prev.finalWarning) {
    // 경고가 뜬 뒤에 나온 요구도 근거에 더한다 (실기: 인증번호 요구가 근거 목록에서 빠졌다)
    const reasons = [...new Set([...prev.finalWarning.reasons, ...because])];
    if (reasons.length !== prev.finalWarning.reasons.length) next.finalWarning = { ...prev.finalWarning, reasons };
  }
  if (level !== 'final') next.finalWarning = undefined;
  return next;
}

export function sameRisk(a: RiskState, b: RiskState): boolean {
  return a.level === b.level && a.activeCategories.join() === b.activeCategories.join() && a.history.length === b.history.length && a.finalWarning?.dismissed === b.finalWarning?.dismissed;
}

export const EMPTY_RISK: RiskState = { level: 'none', activeCategories: [], history: [] };
