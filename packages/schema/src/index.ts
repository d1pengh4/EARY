// 이어리 대화 상태·이벤트 계약. 서버·클라이언트·core가 모두 이 파일 하나를 따른다. (docs/ARCHITECTURE.md §5, §6, §8)
import { z } from 'zod';

export type Ms = number;
export type Speaker = 'me' | 'other';
export type Mode = 'live' | 'replay-audio' | 'replay-fixture' | 'type';
export type Domain = 'unknown' | 'impersonation' | 'billing' | 'general';

export interface SourceRef { utteranceId: string; rev: number; startMs: Ms }
export interface Span { start: number; end: number }

export type MarkTone = 'amber' | 'red' | 'blue';
export interface Mark extends Span { tone: MarkTone }

export interface Utterance {
  id: string;
  speaker: Speaker;
  speakerSource: 'channel' | 'inferred' | 'user';
  label: string;
  startMs: Ms;
  endMs: Ms;
  text: string;
  status: 'interim' | 'final' | 'edited';
  rev: number;
  lowConfidenceSpans?: Span[];
  marks: Mark[];
  tags: string[]; // 행 오른쪽 위험 태그: "비밀 유지" 등
}

export type EntityType =
  | 'org' | 'person' | 'case' | 'account' | 'amount' | 'date' | 'duration'
  | 'condition' | 'demand' | 'product';
export type Certainty = 'provisional' | 'claimed' | 'confirmed' | 'contradicted' | 'unknown';

export interface Entity {
  key: string;
  type: EntityType;
  value: string;
  attrs: Record<string, string>;
  certainty: Certainty;
  confidence: number;
  origin: ('L0' | 'D1' | 'L1' | 'L2')[];
  sources: SourceRef[];
}

export type VerificationStatus = 'pending' | 'found' | 'match' | 'mismatch' | 'unverifiable' | 'failed';
export type UnverifiableReason = 'not_found' | 'no_source';

export interface Claim {
  id: string;
  subject: string; // EntityKey
  predicate: string;
  value: string;
  sources: SourceRef[];
  verification: VerificationStatus;
  reason?: UnverifiableReason;
  evidenceIds: string[];
}

export interface Evidence {
  id: string;
  claimId?: string;
  tier: 'official' | 'lookup' | 'reference';
  title: string;
  quote?: string;
  url?: string;
  scope: string;
  query?: string;
  resultCount?: number;
  status: VerificationStatus;
  reason?: UnverifiableReason;
  caveat?: string;
  isMock: boolean;
  checkedAtMs: Ms;
  linkedUtteranceIds: string[];
}

export type SignalCategory =
  | 'impersonation' | 'secrecy' | 'isolation' | 'time_pressure' | 'unverifiable_case'
  | 'official_mismatch' | 'money_transfer' | 'credential_request' | 'remote_app';

export const ACTION_CATEGORIES: readonly SignalCategory[] = ['money_transfer', 'credential_request', 'remote_app'];

export const SIGNAL_LABEL: Record<SignalCategory, string> = {
  impersonation: '사칭 의심',
  secrecy: '비밀 유지',
  isolation: '고립 유도',
  time_pressure: '시간 압박',
  unverifiable_case: '사건 확인 불가',
  official_mismatch: '공식 안내와 다름',
  money_transfer: '송금 요구',
  credential_request: '인증정보 요구',
  remote_app: '앱 설치 요구',
};

export interface RiskSignal {
  id: string;
  category: SignalCategory;
  label: string;
  origin: ('L0' | 'D1' | 'L1' | 'verify')[];
  /** L0만 잡은 신호는 잠정. D1/L1/verify가 확인해야 단계 계산에 들어간다. */
  confirmed: boolean;
  confidence: number;
  d1Prob?: number;
  sources: SourceRef[];
  explanation: string;
  active: boolean;
}

export type RiskLevel = 'none' | 'caution' | 'accumulating' | 'final';
export interface RiskState {
  level: RiskLevel;
  activeCategories: SignalCategory[];
  finalWarning?: { reasons: string[]; shownAtMs: Ms; dismissed: boolean };
  history: { level: RiskLevel; atMs: Ms; because: string[] }[];
}

// ── 보드 (§8) ─────────────────────────────────────────────
export interface PillSpec { text: string; tone: 'amber' | 'red' | 'teal' | 'gray' }
export type CardStyle = 'provisional' | 'claimed' | 'confirmed' | 'contradicted' | 'me';

export type BoardEl =
  | { kind: 'card'; id: string; entityKey?: string; zone: string; slot?: string; label: string; value: string; pills: PillSpec[]; sub?: string; style: CardStyle; sources: SourceRef[] }
  | { kind: 'callout'; id: string; zone: string; tone: 'amber' | 'red' | 'signal' | 'info'; title: string; body: string; pills: PillSpec[]; evidenceIds?: string[]; sources: SourceRef[] }
  | { kind: 'hand'; id: string; zone: string; text: string; pointsTo?: string; sources: SourceRef[] }
  | { kind: 'banner'; id: string; zone: string; text: string; sources: SourceRef[] }
  | { kind: 'table'; id: string; zone: string; columns: string[]; rows: TableRow[]; sources: SourceRef[] }
  // ── 분석 보드(에이전트 캔버스, §8.11) 전용 ──
  | { kind: 'section'; id: string; zone: string; title: string; layout: SectionLayout; columns?: string[]; status?: 'thinking' | 'idle'; sources: SourceRef[] }
  | { kind: 'row'; id: string; zone: string; section: string; cells: string[]; header?: boolean; tone?: ItemTone; sources: SourceRef[] }
  | { kind: 'item'; id: string; zone: string; section: string; label: string; value: string; tone: ItemTone; pills: PillSpec[]; sub?: string; url?: string; entityKey?: string; sources: SourceRef[] }
  | { kind: 'chip'; id: string; zone: string; section: string; text: string; state: 'running' | 'done' | 'failed'; sources: SourceRef[] };

export interface TableRow { id: string; cells: string[]; pills?: (PillSpec | null)[]; highlight?: boolean }
export type SectionLayout = 'graph' | 'table' | 'timeline' | 'steps' | 'cards' | 'evidence' | 'notes' | 'search';
/** 항목의 의미 = 모양 (§8.2 시각 문법과 같은 규칙) */
export type ItemTone = 'heard' | 'claimed' | 'confirmed' | 'contradicted' | 'unknown' | 'warning' | 'info' | 'official' | 'news' | 'reference';

export interface BEdge { id: string; from: string; to: string; kind: 'claim' | 'evidence' | 'sequence' | 'pointer'; label?: string; path: string; labelAt?: { x: number; y: number } }
export interface Placed { id: string; x: number; y: number; w: number; h: number; rot?: number }

export interface Board {
  id: string;
  templateId: string;
  title: string;
  size: { w: number; h: number };
  els: Record<string, BoardEl>;
  placed: Record<string, Placed>;
  edges: Record<string, BEdge>;
  order: string[]; // 등장 순서 (스냅샷·접근성 읽기 순서)
  badges: Record<string, { text: '방금 추가' | '방금 갱신'; untilMs: Ms }>;
  updatedAtMs: Ms;
}

export type BoardPatch =
  | { add: { els: BoardEl[]; placed: Placed[]; edges?: BEdge[] } }
  | { update: { id: string; fields: Partial<BoardEl> } }
  | { move: { placed: Placed[] } }
  | { edges: BEdge[] }
  | { remove: { id: string } } // provisional 요소 전용 (§8.10)
  | { resize: { h: number } }
  | { badge: { id: string; text: '방금 추가' | '방금 갱신'; untilMs: Ms } };

// ── 통화 종료 리뷰 (§13, 디자인 4·6·7번) ─────────────────────
export interface Ref { utteranceId: string; atMs: Ms }
export interface ReviewMoment { atMs: Ms; utteranceId?: string; title: string; detail: string; level?: RiskLevel }
export interface ReviewOpen { title: string; how: string }
export interface CalendarDraft { title: string; startIso: string; memo: string }
export interface ReportField { label: string; value: string; refs: Ref[]; note?: string }
export interface Review {
  title: string;
  durationMs: Ms;
  endedAt: string;
  summary: { text: string; by: 'rule' | 'ai' };
  moments: ReviewMoment[];
  open: ReviewOpen[];
  calendar?: CalendarDraft;
  report?: { title: string; fields: ReportField[]; attachments: string[]; excluded: string };
  stored?: { retentionDays: number };
}

export interface Suggestion { id: string; kind: 'ask' | 'action'; text: string; why?: string; prob?: number }
export interface ChatTurn { id: string; role: 'me' | 'ai'; text: string; atMs: Ms; done: boolean }

export interface CallState {
  callId: string;
  mode: Mode;
  phase: 'idle' | 'listening' | 'ended';
  startedAt?: string;
  consentNotified: boolean;
  callerNumber?: string;
  domain: Domain;
  domainConfidence: number;
  situation: { text: string; rev: number };
  utterances: Record<string, Utterance>;
  utteranceOrder: string[];
  entities: Record<string, Entity>;
  claims: Record<string, Claim>;
  evidence: Record<string, Evidence>;
  signals: Record<string, RiskSignal>;
  risk: RiskState;
  boards: Record<string, Board>;
  boardOrder: string[];
  activeBoardId?: string;
  suggestions: Suggestion[];
  chat: ChatTurn[];
  review?: Review;
  nowMs: Ms;
}

// ── op (서버 → 클라이언트 상태 변경) §6.3 ─────────────────────
export type Op =
  | { op: 'call.reset'; state: CallState }
  | { op: 'phase.set'; phase: CallState['phase']; atMs: Ms }
  | { op: 'clock'; nowMs: Ms }
  | { op: 'utt.upsert'; u: Utterance }
  | { op: 'entity.upsert'; e: Entity }
  | { op: 'entity.remove'; key: string }
  | { op: 'claim.upsert'; c: Claim }
  | { op: 'evidence.upsert'; ev: Evidence }
  | { op: 'signal.upsert'; s: RiskSignal }
  | { op: 'risk.set'; risk: RiskState }
  | { op: 'domain.set'; domain: Domain; confidence: number }
  | { op: 'situation.set'; text: string; rev: number }
  | { op: 'board.create'; board: Board; activate: boolean }
  | { op: 'board.patch'; boardId: string; patch: BoardPatch; atMs: Ms }
  | { op: 'board.focus'; boardId: string }
  | { op: 'suggestions.set'; items: Suggestion[] }
  | { op: 'chat.turn'; turn: ChatTurn }
  | { op: 'review.set'; review: Review };

export interface LatencySpan { name: string; utteranceId?: string; ms: number }

export type S2C =
  | { t: 'welcome'; sessionId: string; callId: string; seq: number; snapshot: CallState; providers: ProviderStatus }
  | { t: 'ops'; from: number; ops: Op[] }
  | { t: 'metrics'; spans: LatencySpan[] }
  | { t: 'error'; code: string; message: string; recoverable: boolean }
  | { t: 'voice'; enrolled: boolean; seconds: number; note?: string };

export interface ProviderStatus { stt: boolean; d1: boolean; l1: boolean; l2: boolean; search?: string[] }

// ── 클라이언트 → 서버 (검증 필요해서 zod) §6.2 ─────────────────
export const C2SSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), sessionId: z.string().optional(), lastSeq: z.number().optional() }),
  z.object({ t: z.literal('call.start'), mode: z.enum(['live', 'replay-audio', 'replay-fixture', 'type']), scenarioId: z.string().optional(), consentNotified: z.boolean(), callerNumber: z.string().optional(), speed: z.number().min(0.25).max(8).optional(), audio: z.enum(['dual', 'mono']).optional() }),
  z.object({ t: z.literal('voice.enroll'), action: z.enum(['start', 'done', 'reset']) }),
  z.object({ t: z.literal('call.end') }),
  z.object({ t: z.literal('call.new'), deleteRecord: z.boolean().optional() }),
  z.object({ t: z.literal('type.inject'), speaker: z.enum(['me', 'other']), text: z.string().min(1).max(500) }),
  z.object({ t: z.literal('utterance.edit'), utteranceId: z.string(), text: z.string().min(1).max(500) }),
  z.object({ t: z.literal('utterance.speaker'), utteranceId: z.string(), speaker: z.enum(['me', 'other']) }),
  z.object({ t: z.literal('board.focus'), boardId: z.string() }),
  z.object({ t: z.literal('chat.ask'), text: z.string().min(1).max(500), preset: z.enum(['simplify', 'compare', 'evidence', 'todo', 'schedule']).optional() }),
  z.object({ t: z.literal('warning.ack'), action: z.enum(['keep_listening', 'hangup_and_check', 'open_report']) }),
]);
export type C2S = z.infer<typeof C2SSchema>;

// ── 대본 (§14.2) ─────────────────────────────────────────────
export interface ScenarioUtterance { speaker: Speaker; atMs: Ms; durMs?: number; text: string; label?: string }
export interface ScenarioStep {
  step: number;
  label: string;
  utterances: ScenarioUtterance[];
  expect?: { risk?: RiskLevel; entities?: string[]; domain?: Domain; signals?: SignalCategory[] };
}
export interface Scenario { id: string; title: string; callerNumber?: string; otherLabel?: string; steps: ScenarioStep[] }
