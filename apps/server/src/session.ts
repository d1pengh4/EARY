// 통화 세션 = 서버가 원본 상태를 갖는 이벤트 로그 + 파이프라인 오케스트레이터. (§6, §7, §8.10, §9)
// 규칙: 시나리오 이름으로 분기하지 않는다. 모든 판단은 상태와 도메인 팩으로만 한다. (§14)
import {
  applyOp, buildRuleFigures, familyClaim, unknownChannel, gridCell, route, soften, warningHeadline, guessSpeaker, learn, scrubPhones, voiceFeatures, type SpeakerModel, type VoiceFeat, buildBillingBoard, buildReview, withParticle, createBoard, createCanvas, link, upsertChild, upsertSection, entityKey, initialState, nextRisk, sameRisk, syncCallout, syncEntity,
  type BoardTemplate, type DomainPack, type L0Engine, type Packs,
} from '@eary/core';
import {
  ACTION_CATEGORIES, SIGNAL_LABEL,
  type BoardEl, type C2S, type CallState, type Domain, type Entity, type LatencySpan, type Mode, type Op,
  type BoardPatch, type Figure, type ProviderStatus, type RiskSignal, type S2C, type Scenario, type SignalCategory, type SourceRef, type Speaker, type Suggestion, type Utterance,
} from '@eary/schema';
import { SCENARIOS } from '@eary/scenario';
import { BoardAgent, type AgentContext } from './agent';
import type { L1 } from './fastLlm';
import type { GroqChat } from './groqChat';
import type { CallRecords } from './records';
import type { WebSearch } from './search';
import { playScenario } from './fixtureStt';
import { RtzrStream, SAMPLE_RATE, type RtzrAuth, type RtzrResult } from './rtzr';
import { join } from 'node:path';
import { AUTHORITY_QUESTION, choice, noul, SIGNAL_QUESTIONS, type JevAnswers, type JevClient } from './jev';
import type { Verifier, VerifyResult } from './verify';

const PROVISIONAL_TTL_MS = 1500;
const PROSECUTION_TITLES = new Set(['검사', '수사관', '검찰수사관', '형사', '조사관']);
const BATCH_MS = 16;
const CANVAS_ID = 'board:canvas';
const GENERIC_ORGS = new Set(['검찰청', '검찰', '경찰청', '경찰', '경찰서', '법원', '은행', '금융기관', '공공기관', '정부']);
const CASE_MAP = 'board:impersonation.entityMap';
const clockOf = (ms: number) => { const t = Math.floor(ms / 1000); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')} 발언`; };
const KIND_KO: Record<string, string> = { org: '기관', person: '인물', case: '사건', account: '나', amount: '금액', date: '일정', duration: '기간', condition: '조건', demand: '요구', product: '상품' };
const GROWING_TYPES = new Set<Entity['type']>(['case', 'amount', 'duration', 'date']);
const FORMATTED_TYPES = GROWING_TYPES;

export interface Deps {
  packs: Packs;
  l0: L0Engine;
  jev: JevClient;
  l1: L1;
  verifier: Verifier;
  rtzr: RtzrAuth;
  audioDir: string;
  agentChat?: GroqChat;
  records?: CallRecords;
  web?: WebSearch;
  log?: (line: string) => void;
  send: (msg: S2C) => void;
}

const CHANNELS: Speaker[] = ['me', 'other']; // 바이너리 프레임 첫 바이트: 0 = 나(마이크), 1 = 상대(탭/시스템 오디오), 2 = 목소리 등록
const ENROLL_CH = 2;
const MONO_KEEP_BYTES = 16000 * 2 * 60 * 3; // 마이크 하나 모드 원음은 최근 3분만 메모리에 (화자 판단용, 저장하지 않음)
const CHUNK_BYTES = (SAMPLE_RATE * 2) / 10; // 100ms

const LOG_KEEP = 5000;

export class CallSession {
  readonly id = crypto.randomUUID();
  state: CallState;
  private seq = 0;
  /** 재연결 때 빠진 op을 다시 보내기 위한 최근 기록 (§6.3) */
  private log: { seq: number; op: Op }[] = [];
  private pending: Op[] = [];
  private pendingFrom = 1;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private startedEpoch = Date.now();
  private stopPlayback: (() => void) | null = null;
  private expiry = new Map<string, ReturnType<typeof setTimeout>>();
  private verified = new Set<string>();
  private otherLabel = '상대';
  /** 상대가 "○○ 씨"로 부른 사람 = 전화를 받은 나 */
  private addressee = '';
  private typeCount = 0;
  private l1Abort: AbortController | null = null;
  /** D1이 "공공기관 자칭"으로 본 발화. L1이 나중에 만든 기관에도 표시를 붙인다 */
  private authorityUtts = new Set<string>();
  private streams: Partial<Record<Speaker, RtzrStream>> = {};
  private streamOffset: Partial<Record<Speaker, number>> = {};
  private segment: Record<Speaker, number> = { me: 0, other: 0 };

  private agent: BoardAgent | null = null;
  // ── 마이크 하나(스피커폰) 화자 구분 (BACKLOG #8) ──
  private mono = false;
  private monoChunks: Uint8Array[] = [];
  private monoBytes = 0;
  /** 버린 앞부분 바이트 수, 현재 STT 스트림이 시작된 위치(통화 처음부터 바이트) — 스트림이 끊겨 다시 열리면 RTZR 시각이 0부터 다시 센다 */
  private monoDropped = 0;
  private monoStreamBase = 0;
  private enrollChunks: Uint8Array[] = [];
  private speakerModel: SpeakerModel = {};
  private uttFeat = new Map<string, VoiceFeat>();
  private autoSearched = new Set<string>();

  constructor(private readonly d: Deps) {
    this.state = initialState(crypto.randomUUID());
  }

  /** 새 연결(새로고침·재연결)에 세션을 다시 붙인다 */
  attach(send: Deps['send']) {
    (this.d as { send: Deps['send'] }).send = send;
  }

  /** lastSeq 이후의 op을 다시 보낸다. 기록 범위를 벗어나면 스냅샷 */
  resume(lastSeq: number) {
    this.dropPending();
    const first = this.log[0]?.seq ?? this.seq + 1;
    if (lastSeq >= this.seq) { this.d.send({ t: 'ops', from: this.seq + 1, ops: [] }); return; }
    if (lastSeq + 1 < first) { this.d.send(this.welcome()); return; }
    const ops = this.log.filter((x) => x.seq > lastSeq).map((x) => x.op);
    this.d.send({ t: 'welcome', sessionId: this.id, callId: this.state.callId, seq: lastSeq, snapshot: undefined as unknown as CallState, providers: this.providers() });
    this.d.send({ t: 'ops', from: lastSeq + 1, ops });
  }

  // ── 분석 보드(에이전트 캔버스, §8.11) ─────────────────────────
  private get canvasOn() {
    return Boolean(this.d.agentChat?.enabled || (this.d.web && this.d.web.enabledNames.length));
  }

  private canvas() {
    return this.state.boards[CANVAS_ID];
  }

  private canvasApply(patches: BoardPatch[]) {
    for (const patch of patches) {
      this.emit({ op: 'board.patch', boardId: CANVAS_ID, patch, atMs: this.now() });
      // 에이전트 메모(메모·주의)는 사건 지도에도 손글씨로 올린다
      if ('add' in patch) for (const el of patch.add.els) if (el.kind === 'item' && el.section === 'sec:think' && (el.label === '메모' || el.label === '주의')) this.caseMapAgentNote(el.value);
    }
  }

  private ensureCanvas() {
    if (!this.canvasOn || this.canvas()) return;
    // 분석 로그는 두 번째 탭. 기본 탭은 디자인된 사건 지도·요금 비교 같은 템플릿 보드
    this.emit({ op: 'board.create', board: { ...createCanvas(CANVAS_ID, this.now()), title: '분석 로그' }, activate: !this.state.boardOrder.length });
    this.canvasApply(upsertSection(this.canvas()!, { id: 'heard', title: '들은 정보', layout: 'cards' }, this.now()));
    if (this.d.agentChat && this.d.web) {
      this.agent = new BoardAgent(this.d.agentChat, this.d.web, {
        board: () => this.canvas(),
        figure: (f) => this.addAgentFigure(f),
        figureKinds: () => this.state.figureOrder.map((id) => this.state.figures[id]?.kind ?? ''),
        apply: (ps) => this.canvasApply(ps),
        context: () => this.agentContext(),
        now: () => this.now(),
        log: (l) => this.d.log?.(l),
      });
    }
  }

  private agentContext(): AgentContext {
    return {
      transcript: this.state.utteranceOrder.slice(-10).map((id) => this.state.utterances[id]!).filter((u) => u.status !== 'interim').map((u) => ({ id: u.id, who: u.label, text: u.text })),
      heard: Object.values(this.state.entities).filter((e) => e.certainty !== 'provisional').map((e) => ({ id: `heard:${e.key}`, type: e.type, value: e.value, status: e.attrs.status ?? e.certainty })),
      signals: this.state.risk.activeCategories.map((c) => SIGNAL_LABEL[c]),
      risk: this.state.risk.level,
      domain: this.state.domain,
    };
  }

  /** 들은 정보는 LLM을 기다리지 않고 바로 카드로 (§8.10 고속 경로를 분석 보드에도) */
  private canvasEntity(e: Entity, removed = false) {
    const b = this.canvas();
    if (!b) return;
    const id = `heard:${e.key}`;
    if (removed) { if (b.els[id]) this.canvasApply([{ remove: { id } }]); return; }
    if (e.type === 'demand' || e.type === 'condition') { if (e.certainty === 'provisional') return; }
    const pills = [
      ...(e.certainty === 'provisional' ? [{ text: '듣는 중', tone: 'gray' as const }] : []),
      ...(e.attrs.status ? [{ text: e.attrs.status, tone: (e.attrs.statusTone as 'amber') ?? 'amber' }] : []),
      ...(e.attrs.estimate === 'true' ? [{ text: '예상 비용', tone: 'amber' as const }] : []),
    ];
    const tone = e.certainty === 'provisional' ? 'heard' : e.attrs.owner === 'me' ? 'confirmed' : e.certainty === 'contradicted' ? 'contradicted' : 'claimed';
    this.canvasApply(upsertChild(b, { kind: 'item', id, zone: 'canvas', section: 'sec:heard', label: e.type === 'account' && e.attrs.owner !== 'me' ? '계좌' : KIND_KO[e.type] ?? e.type, value: e.type === 'person' && e.certainty !== 'confirmed' ? `${e.value} (자칭)` : e.value, tone, pills, entityKey: e.key, sources: e.sources }, this.now()));
  }

  /** 서버가 스스로 하는 검색: 새 기관·행동 요구가 나오면 바로 (에이전트를 기다리지 않음) */
  private autoSearch() {
    if (!this.agent || !this.d.web?.enabledNames.length) return;
    const ents = Object.values(this.state.entities).filter((e) => e.certainty !== 'provisional');
    const org = ents.find((e) => e.type === 'org');
    const jobs: [string, string][] = [];
    if (org) {
      jobs.push([`${org.value} 공식 홈페이지 대표번호`, '기관 확인']);
      if (this.state.domain === 'impersonation' || org.attrs.authority === 'true' || ['prosecution', 'police', 'regulator'].includes(org.attrs.kind ?? '')) jobs.push([`${org.value} 사칭 전화 사기`, '사칭 사례']);
    }
    for (const c of this.state.risk.activeCategories.filter((x) => ACTION_CATEGORIES.includes(x))) jobs.push([`${org?.value ?? '공공기관'} 전화 ${SIGNAL_LABEL[c]} 사기`, '요구 확인']);
    for (const [q, why] of jobs) {
      if (this.autoSearched.has(q)) continue;
      this.autoSearched.add(q);
      const callId = this.state.callId;
      void this.agent.search(q, why).then(() => { if (this.state.callId === callId) this.agent?.trigger(`검색 결과 도착: ${q}`); });
    }
  }


  providers(): ProviderStatus {
    return { stt: this.d.rtzr.enabled, d1: this.d.jev.enabled, l1: this.d.l1.enabled, l2: Boolean(this.d.agentChat?.enabled), search: this.d.web?.enabledNames ?? [] };
  }

  /** 아직 안 보낸 op은 스냅샷·재전송 기록에 이미 들어 있다 → 따로 보내지 않는다 (새로고침 때 순서 꼬임 방지) */
  private dropPending() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pending = [];
  }

  welcome(): S2C {
    this.dropPending();
    return { t: 'welcome', sessionId: this.id, callId: this.state.callId, seq: this.seq, snapshot: this.state, providers: this.providers() };
  }

  // ── op 기록 · 전송 ────────────────────────────────────────
  private now(): number {
    return Date.now() - this.startedEpoch;
  }

  private emit(...ops: Op[]) {
    for (const op of ops) {
      this.state = applyOp(this.state, op);
      if (this.pending.length === 0) this.pendingFrom = this.seq + 1;
      this.seq++;
      this.pending.push(op);
      this.log.push({ seq: this.seq, op });
    }
    // 같은 프레임(16ms) 안의 op은 한 메시지로 묶는다 (§3-6)
    this.flushTimer ??= setTimeout(() => this.flush(), BATCH_MS);
  }

  private flush() {
    if (this.log.length > LOG_KEEP) this.log.splice(0, this.log.length - LOG_KEEP);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.pending.length) return;
    const ops = this.pending;
    this.pending = [];
    this.d.send({ t: 'ops', from: this.pendingFrom, ops });
  }

  private metric(...spans: LatencySpan[]) {
    this.d.send({ t: 'metrics', spans });
  }

  // ── 클라이언트 메시지 ───────────────────────────────────────
  handle(msg: C2S) {
    switch (msg.t) {
      case 'hello':
        if (msg.lastSeq !== undefined && msg.sessionId === this.id) this.resume(msg.lastSeq);
        else this.d.send(this.welcome());
        break;
      case 'call.start':
        this.mono = msg.mode === 'live' && msg.audio === 'mono';
        this.monoChunks = []; this.monoBytes = 0; this.monoDropped = 0; this.monoStreamBase = 0; this.uttFeat.clear();
        this.audioMeter = {};
        this.start(msg.mode, msg.scenarioId, msg.consentNotified, msg.callerNumber, msg.speed);
        break;
      case 'voice.enroll':
        if (msg.action === 'start' || msg.action === 'reset') { this.enrollChunks = []; if (msg.action === 'reset') this.speakerModel = {}; }
        if (msg.action === 'done') this.finishEnroll();
        break;
      case 'call.end':
        this.end();
        break;
      case 'call.new':
        // "기록 지우고 새 통화": 저장된 기록도 실제로 지운다
        if (msg.deleteRecord) this.d.records?.delete(this.state.callId);
        this.stopPlayback?.();
        this.closeStreams();
        this.agent?.stop();
        this.agent = null;
        this.emit({ op: 'call.reset', state: initialState(crypto.randomUUID()) });
        break;
      case 'type.inject': {
        if (this.state.phase !== 'listening') this.start('type', undefined, true);
        const id = `t${++this.typeCount}`;
        const at = this.now();
        this.onFinal(id, msg.speaker, msg.text, at, at);
        break;
      }
      case 'utterance.edit':
        this.onEdit(msg.utteranceId, msg.text);
        break;
      case 'utterance.speaker': {
        // 화자가 바뀌면 그 발화를 다시 판단한다 (위험 신호는 상대 발화에서만 나온다)
        const u = this.state.utterances[msg.utteranceId];
        if (u && u.speaker !== msg.speaker) {
          // 마이크 하나 모드: 고친 결과로 화자 모델을 보정한다 (이게 "학습")
          const f = this.uttFeat.get(u.id);
          if (f) this.speakerModel = learn(this.speakerModel, msg.speaker, f);
          this.rerun(u.id, u.text, msg.speaker, 'user');
        }
        break;
      }
      case 'board.focus':
        this.emit({ op: 'board.focus', boardId: msg.boardId });
        break;
      case 'chat.ask':
        this.onAsk(msg.text, msg.preset);
        break;
      case 'warning.ack': {
        const r = this.state.risk;
        if (r.finalWarning && msg.action === 'keep_listening') this.emit({ op: 'risk.set', risk: { ...r, finalWarning: { ...r.finalWarning, dismissed: true } } });
        break;
      }
    }
  }

  start(mode: Mode, scenarioId?: string, consent = true, callerNumber?: string, speed = 1) {
    this.stopPlayback?.();
    this.closeStreams();
    for (const t of this.expiry.values()) clearTimeout(t);
    this.expiry.clear();
    this.verified.clear();
    this.autoSearched.clear();
    this.agent?.stop();
    this.agent = null;
    this.typeCount = 0;
    this.startedEpoch = Date.now();
    const sc: Scenario | undefined = scenarioId ? SCENARIOS[scenarioId] : undefined;
    this.otherLabel = sc?.otherLabel ?? '상대';
    const fresh = initialState(crypto.randomUUID(), mode);
    fresh.phase = 'listening';
    fresh.startedAt = new Date(this.startedEpoch).toISOString();
    fresh.consentNotified = consent;
    fresh.callerNumber = callerNumber ?? sc?.callerNumber;
    fresh.situation = { text: '통화 내용을 듣는 중', rev: 1 };
    this.emit({ op: 'call.reset', state: fresh });
    if (mode === 'replay-audio' && sc) void this.playAudio(sc.id, speed);
    if (mode === 'live') this.segment = { me: 0, other: 0 };
    if (mode === 'replay-fixture' && sc) {
      this.stopPlayback = playScenario(sc, {
        interim: (id, sp, text, startMs) => this.onInterim(id, sp, text, startMs),
        final: (id, sp, text, startMs, endMs) => this.onFinal(id, sp, text, startMs, endMs),
        done: () => {},
      }, speed);
    }
  }

  end() {
    if (this.state.phase !== 'listening') return;
    this.stopPlayback?.();
    this.stopPlayback = null;
    for (const st of Object.values(this.streams)) st?.end();
    this.agent?.stop();
    const endedAt = this.now();
    this.emit({ op: 'phase.set', phase: 'ended', atMs: endedAt }, { op: 'situation.set', text: this.situationText('ended'), rev: this.state.situation.rev + 1 });
    // 리뷰는 규칙으로 즉시. 요약 문장만 LLM으로 다듬어 나중에 바꾼다 (한도에 걸려도 리뷰는 항상 나온다)
    const review = buildReview(this.state, endedAt);
    this.emit({ op: 'review.set', review: { ...review, stored: this.d.records ? { retentionDays: this.d.records.retention } : undefined } });
    this.d.records?.save(this.state);
    void this.polishSummary(review);
  }

  private async polishSummary(review: NonNullable<CallState['review']>) {
    const chat = this.d.agentChat;
    if (!chat?.available) return;
    const callId = this.state.callId;
    const lines = this.state.utteranceOrder.map((id) => this.state.utterances[id]!).filter((u) => u.status !== 'interim').map((u) => `${u.label}: ${u.text}`).slice(-24).join('\n');
    const facts = { 위험_단계: this.state.risk.level, 신호: this.state.risk.activeCategories.map((c) => SIGNAL_LABEL[c]), 확인_결과: Object.values(this.state.evidence).map((e) => `${e.title}: ${e.status}`), 규칙_요약: review.summary.text };
    const r = await chat.chat([
      { role: 'system', content: '통화 기록을 2~3문장 한국어로 요약한다. 사실만, 단정하지 않는다("사기다" 금지, "확인되지 않았다"는 가능). 상대가 밝힌 신원, 주요 요구, 확인 결과 순서. 120자 안팎. 요약문만 출력.' },
      { role: 'user', content: `${JSON.stringify(facts)}\n\n${lines}` },
    ], []).catch(() => null);
    const text = r?.msg.content?.trim();
    if (!text || this.state.callId !== callId || !this.state.review) return;
    // 단정 표현이 섞이면 버리고 규칙 요약을 유지
    if (/사기입니다|사기다|확실히 사기|범죄자/.test(text)) return;
    this.emit({ op: 'review.set', review: { ...this.state.review, summary: { text: text.slice(0, 300), by: 'ai' } } });
    this.d.records?.save(this.state);
  }

  // ── 음성 → RTZR (§7.3) ───────────────────────────────────
  /** live 모드: 브라우저가 보낸 PCM16 프레임 */
  audio(frame: Uint8Array) {
    if (frame[0] === ENROLL_CH) { this.enrollChunks.push(frame.slice(1)); return; }
    if (this.state.phase !== 'listening' || (this.state.mode !== 'live' && this.state.mode !== 'replay-audio')) return;
    if (this.mono) {
      // 마이크 하나: 스트림 하나로 보내고, 확정 자막 구간의 원음으로 화자를 판단한다
      const pcm = frame.slice(1);
      // 스트림을 먼저 (다시 열리면 이 조각이 새 스트림의 0초) → 그다음 원음 보관
      this.stream('me').push(pcm);
      this.monoChunks.push(pcm); this.monoBytes += pcm.length;
      while (this.monoBytes > MONO_KEEP_BYTES && this.monoChunks.length > 1) { const c = this.monoChunks.shift()!; this.monoBytes -= c.length; this.monoDropped += c.length; }
      return;
    }
    const speaker = CHANNELS[frame[0]!];
    if (!speaker) return;
    this.meterAudio(speaker, frame.length - 1);
    this.stream(speaker).push(frame.subarray(1));
  }

  /** 채널별 수신량 점검: 16kHz PCM16 = 초당 32,000바이트. 크게 넘으면 같은 마이크가 두 번 연결된 것 (실기: 내 말이 반복돼 인식) */
  private audioMeter: Partial<Record<Speaker, { t0: number; bytes: number; warned?: boolean }>> = {};
  private meterAudio(sp: Speaker, n: number) {
    const now = performance.now();
    const m = (this.audioMeter[sp] ??= { t0: now, bytes: 0 });
    m.bytes += n;
    const sec = (now - m.t0) / 1000;
    if (sec < 5) return;
    const rate = m.bytes / sec;
    this.d.log?.(`audio ${sp} ${(rate / 1000).toFixed(1)}KB/s (정상 32.0)`);
    if (rate > 44_000 && !m.warned) {
      m.warned = true;
      console.warn('[audio]', sp, '수신량이 정상의', (rate / 32_000).toFixed(1), '배 — 마이크·탭이 두 번 연결됐을 수 있음');
      this.d.send({ t: 'error', code: 'audio_duplicate', message: `${sp === 'me' ? '마이크' : '탭'} 소리가 두 번 들어오고 있어요. 통화를 끝내고 새로고침한 뒤 다시 시작해 주세요.`, recoverable: true });
    }
    this.audioMeter[sp] = { t0: now, bytes: 0, warned: m.warned };
  }

  private finishEnroll() {
    const pcm = concatPcm(this.enrollChunks);
    this.enrollChunks = [];
    const f = voiceFeatures(pcm);
    const seconds = pcm.length / 16000;
    if (f.voiced < 150) { this.d.send({ t: 'voice', enrolled: Boolean(this.speakerModel.me), seconds, note: '목소리가 충분히 들리지 않았어요. 조용한 곳에서 다시 읽어 주세요.' }); return; }
    this.speakerModel = learn({ other: this.speakerModel.other }, 'me', f);
    this.d.send({ t: 'voice', enrolled: true, seconds, note: `등록했어요 (${seconds.toFixed(1)}초)` });
  }

  /** RTZR 구간(ms) → 그 구간 원음 → 화자 추정 */
  private monoSpeaker(id: string, startAt: number, duration: number, text: string): { speaker: Speaker; confidence: number } {
    const all = concatPcm(this.monoChunks);
    // 보관 버퍼 기준 샘플 위치 = 스트림 시작 위치 + RTZR 시각 − 버린 앞부분
    const base = (this.monoStreamBase - this.monoDropped) / 2;
    const from = Math.max(0, Math.floor(base + (startAt / 1000) * 16000));
    const to = Math.min(all.length, Math.ceil(base + ((startAt + duration) / 1000) * 16000));
    const f = voiceFeatures(all.subarray(from, to));
    this.uttFeat.set(id, f);
    const g = guessSpeaker(f, this.speakerModel);
    this.d.log?.(`speaker ${id} → ${g.speaker} p(me)=${g.pMe.toFixed(2)} conf=${g.confidence.toFixed(2)} | ${g.why.join(' · ')} | ${text.slice(0, 20)}`);
    return { speaker: g.speaker, confidence: g.confidence };
  }

  /** 소리로 확신이 낮으면 말의 내용으로 다시 본다 (D1). 다르면 그 발화를 다시 판단 */
  private async textSpeaker(id: string) {
    const u = this.state.utterances[id];
    if (!u || !this.d.jev.enabled) return;
    const ctx = this.state.utteranceOrder.filter((x) => x !== id).slice(-3).map((x) => this.state.utterances[x]!).map((x) => ({ speaker: x.label, text: x.text }));
    const a = await this.d.jev.decide({ context: ctx, last: { text: u.text } }, { speaker: choice('last 발화를 한 사람은? 전화를 받은 사용자인가, 전화를 건 상대(기관·상담원 등)인가?', { me: '전화를 받은 사용자', other: '전화를 건 상대' }) });
    const c = a?.choice.speaker;
    const cur = this.state.utterances[id];
    if (!c || !cur || cur.speakerSource === 'user' || c.confidence < 0.7 || c.choice === cur.speaker) return;
    this.rerun(id, cur.text, c.choice as Speaker, 'inferred');
  }

  private stream(speaker: Speaker): RtzrStream {
    const cur = this.streams[speaker];
    if (cur && !cur.closed) return cur;
    const callId = this.state.callId;
    this.streamOffset[speaker] = this.now();
    if (speaker === 'me') this.monoStreamBase = this.monoDropped + this.monoBytes;
    const st = new RtzrStream(this.d.rtzr, {
      onResult: (r) => this.state.callId === callId && this.onRtzr(speaker, r),
      onClose: (code, reason) => { if (code !== 1000) console.warn('[rtzr]', speaker, code, reason); },
      onError: (e) => console.warn('[rtzr]', speaker, (e as Error)?.message ?? e),
    });
    this.streams[speaker] = st;
    void st.start().catch((e) => {
      console.warn('[rtzr] start', (e as Error).message);
      this.d.send({ t: 'error', code: 'stt_unavailable', message: '자막 연결에 실패했어요', recoverable: true });
    });
    return st;
  }

  private onRtzr(speaker: Speaker, r: RtzrResult) {
    const text = (r.alternatives[0]?.text ?? '').trim();
    const id = `${speaker === 'me' ? 'm' : 'o'}${this.segment[speaker] + 1}`;
    const startMs = (this.streamOffset[speaker] ?? 0) + r.start_at;
    if (!text) { if (r.final) this.segment[speaker]++; return; }
    if (r.final) {
      this.segment[speaker]++;
      if (this.mono) {
        const g = this.monoSpeaker(id, r.start_at, r.duration, text);
        this.onFinal(id, g.speaker, text, startMs, startMs + r.duration, 0, 'final', 'inferred');
        if (g.confidence < 0.5) void this.textSpeaker(id);
      } else this.onFinal(id, speaker, text, startMs, startMs + r.duration);
    } else {
      // 마이크 하나 모드의 중간 자막은 화자를 아직 모른다 → "상대"로 두면 위험 표시가 먼저 뜰 수 있어 "나"로 둔다 (위험 신호는 final에서만)
      this.onInterim(id, speaker, text, startMs);
    }
  }

  /** replay-audio: 대본 오디오 2채널을 실시간 속도로 RTZR에 흘린다. 진짜 STT를 거치는 시연 기본 모드 (§14) */
  private async playAudio(id: string, speed: number) {
    const callId = this.state.callId;
    const tracks = await Promise.all(CHANNELS.map(async (sp) => new Uint8Array(await Bun.file(join(this.d.audioDir, `${id}.${sp}.pcm`)).arrayBuffer())));
    const len = Math.max(...tracks.map((t) => t.length));
    let stopped = false;
    this.stopPlayback = () => { stopped = true; };
    const t0 = performance.now();
    const step = 100 / speed;
    for (let i = 0, k = 0; i < len; i += CHUNK_BYTES, k++) {
      if (stopped || this.state.callId !== callId) return;
      CHANNELS.forEach((sp, ch) => {
        const chunk = tracks[ch]!.subarray(i, i + CHUNK_BYTES);
        if (chunk.length) this.stream(sp).push(chunk);
      });
      // 누적 오차 없이 실시간 속도 유지
      const wait = t0 + (k + 1) * step - performance.now();
      if (wait > 0) await Bun.sleep(wait);
    }
    for (const sp of CHANNELS) this.streams[sp]?.end();
  }

  private closeStreams() {
    for (const st of Object.values(this.streams)) st?.close();
    this.streams = {};
    this.segment = { me: 0, other: 0 };
  }

  // ── STT 이벤트 ─────────────────────────────────────────────
  private label(sp: Speaker) {
    return sp === 'me' ? '나' : this.otherLabel;
  }

  onInterim(id: string, speaker: Speaker, text: string, startMs: number) {
    const t0 = performance.now();
    const prev = this.state.utterances[id];
    const r = this.d.l0.scan(text);
    this.emit({ op: 'utt.upsert', u: { id, speaker, speakerSource: 'channel', label: this.label(speaker), startMs, endMs: this.now(), text, status: 'interim', rev: prev?.rev ?? 0, marks: r.marks, tags: [] } });
    this.ensureBoard(r.domainGuess);
    // ① 잠정 카드: 말하는 도중에 슬롯을 채운다 (§8.10)
    for (const e of r.entities) {
      if (this.state.entities[e.key]) continue;
      // 숫자형 값이 interim 끝에 걸쳐 있으면 아직 말하는 중 → 자란 뒤에 그린다 ("2026형제4827…" 방지, §8.10 정확도 5)
      if (GROWING_TYPES.has(e.type) && e.span.end >= text.trimEnd().length) continue;
      this.upsertEntity({ key: e.key, type: e.type, value: e.value, attrs: e.attrs, certainty: 'provisional', confidence: e.confidence, origin: ['L0'], sources: [{ utteranceId: id, rev: 0, startMs }] });
    }
    if (r.entities.length) this.metric({ name: 'board_provisional', utteranceId: id, ms: performance.now() - t0 });
  }

  onFinal(id: string, speaker: Speaker, text: string, startMs: number, endMs: number, rev = 0, status: 'final' | 'edited' = rev > 0 ? 'edited' : 'final', source?: Utterance['speakerSource']) {
    const tFinal = performance.now();
    const r = this.d.l0.scan(text);
    const src: SourceRef = { utteranceId: id, rev, startMs };
    this.emit({ op: 'utt.upsert', u: { id, speaker, speakerSource: source ?? (speaker === 'me' || this.state.mode !== 'type' ? 'channel' : 'user'), label: this.label(speaker), startMs, endMs, text, status, rev, marks: r.marks, tags: [] } });
    this.ensureBoard(r.domainGuess);
    // D1이 정하기 전까지는 L0 단서로 도메인을 잠정 설정 (도메인 게이트가 바로 동작하게)
    if (this.state.domain === 'unknown' && r.domainGuess) this.setDomain(r.domainGuess, 0.6);

    // interim에만 있었고 final에는 없는 잠정 엔티티는 바로 지운다
    const finalKeys = new Set(r.entities.map((e) => e.key));
    for (const e of Object.values(this.state.entities)) {
      if (e.certainty === 'provisional' && !finalKeys.has(e.key) && e.sources.every((x) => x.utteranceId === id)) this.removeProvisional(e.key);
    }

    // 엔티티: 형식이 정해진 값(사전·정규식, confidence ≥ 0.9)은 바로 claimed, 나머지는 D1/L1 확인 대기
    for (const e of r.entities) {
      const cur = this.state.entities[e.key];
      const sources = cur ? dedupeSources([...cur.sources, src]) : [src];
      // 이미 기관을 자칭한 통화에서 "○○○ 검사"처럼 수사 직함이 붙은 이름은 바로 자칭 정보로 (실기: Groq 한도 초과 때 "박정훈 검사"가 잠정으로 사라짐)
      const authorityCall = Object.values(this.state.entities).some((x) => x.type === 'org' && x.certainty !== 'provisional' && ['prosecution', 'police', 'regulator'].includes(x.attrs.kind ?? ''));
      const titled = e.type === 'person' && PROSECUTION_TITLES.has(e.attrs.title ?? '') && authorityCall && speaker === 'other';
      const certainty = cur && cur.certainty !== 'provisional' ? cur.certainty : e.confidence >= 0.9 || titled ? 'claimed' : 'provisional';
      this.upsertEntity({ key: e.key, type: e.type, value: e.value, attrs: { ...cur?.attrs, ...e.attrs }, certainty, confidence: Math.max(e.confidence, cur?.confidence ?? 0), origin: [...new Set([...(cur?.origin ?? []), 'L0' as const])], sources });
      if (certainty === 'provisional') this.scheduleExpiry(e.key);
    }

    // 위험 신호는 상대 발화에서만. L0만 잡은 신호는 잠정(confirmed=false)
    if (speaker === 'other') {
      for (const cat of new Set(r.signals.map((s) => s.category))) {
        const sid = `sig:${id}:${cat}`;
        const strength = r.signals.find((s) => s.category === cat)!.strength;
        const cur = this.state.signals[sid];
        this.emit({ op: 'signal.upsert', s: { id: sid, category: cat, label: SIGNAL_LABEL[cat], origin: [...new Set([...(cur?.origin ?? []), 'L0' as const])], confirmed: cur?.confirmed ?? false, confidence: strength, sources: [src], explanation: `‘${sentenceAround(text, r.signals.find((s) => s.category === cat)!.span)}’`, active: true } });
      }
    }

    this.afterChange();

    if (speaker === 'other') {
      if (this.d.jev.enabled) {
        void this.runD1(id, tFinal);
      } else {
        // D1이 없으면(키 없음·서킷 열림) L0 신호를 그대로 확정한다 (§15 예비 경로)
        this.confirmL0Signals(id);
        this.confirmProvisional(id);
        this.afterChange();
      }
      this.agent?.trigger(`상대 발화: ${text.slice(0, 40)}`);
      // 짧은 맞장구는 L1을 부르지 않는다 (토큰 한도 절약)
      if (this.d.l1.available && text.replace(/\s+/g, '').length >= 8) void this.runL1(id, text, tFinal);
    }
  }

  private onEdit(id: string, text: string) {
    const u = this.state.utterances[id];
    if (u) this.rerun(id, text, u.speaker, u.speakerSource);
  }

  /** 발언 고치기·화자 바꾸기: 이 발화에서 나온 신호를 끄고 다시 돌린다. 이 경우에만 위험 단계가 내려갈 수 있다 (§12) */
  private rerun(id: string, text: string, speaker: Speaker, source: Utterance['speakerSource']) {
    const u = this.state.utterances[id];
    if (!u) return;
    for (const s of Object.values(this.state.signals)) {
      if (s.sources.some((x) => x.utteranceId === id) && s.active && !s.origin.includes('verify')) this.emit({ op: 'signal.upsert', s: { ...s, active: false } });
    }
    this.retractFrom(id);
    this.onFinal(id, speaker, text, u.startMs, u.endMs, u.rev + 1, text === u.text ? 'final' : 'edited', source);
    this.recomputeRisk(true);
    // 단계가 내려간 뒤의 상황 문장·추천·지도를 다시 맞춘다 (실기: 내려갔는데 "위험한 행동을 직접 요구"가 남았다)
    this.afterChange();
  }

  // ── D1 · L1 ────────────────────────────────────────────────
  private async runD1(id: string, tFinal: number) {
    // 판정 대상(last)과 맥락(context)을 나눈다. 창 전체를 주면 앞 발화의 신호가 마지막 발화에 번진다.
    const ctx = this.state.utteranceOrder.filter((uid) => uid !== id).slice(-3).map((uid) => this.state.utterances[uid]!).map((u) => ({ speaker: u.label, text: u.text }));
    const target = this.state.utterances[id]!;
    const domainCriteria = Object.fromEntries(Object.values(this.d.packs.domains).map((p) => [p.id, p.jev]));
    const catalog = this.suggestionCatalog();
    const questions: Record<string, ReturnType<typeof noul>> = {
      ...Object.fromEntries(Object.entries(SIGNAL_QUESTIONS).map(([k, q]) => [k, noul(q!)])),
      claims_authority: noul(AUTHORITY_QUESTION),
      domain: choice('이 통화는 어떤 종류의 상담인가?', domainCriteria),
    };
    if (catalog.length >= 2) questions.next = choice('사용자가 지금 하면 가장 도움이 될 것은?', Object.fromEntries(catalog.map((s) => [s.id, s.text])));
    const callId = this.state.callId;
    const a = await this.d.jev.decide({ context: ctx, last: { speaker: target.label, text: target.text } }, questions);
    if (this.state.callId !== callId) return; // 그사이 새 통화가 시작됨
    if (!a) {
      this.confirmL0Signals(id);
      this.confirmProvisional(id);
      this.afterChange();
      return;
    }
    this.applyD1(id, a, catalog);
    this.metric({ name: 'd1_roundtrip', utteranceId: id, ms: a.ms }, { name: 'final_to_d1_applied', utteranceId: id, ms: performance.now() - tFinal });
  }

  private applyD1(id: string, a: JevAnswers, catalog: Suggestion[]) {
    const u = this.state.utterances[id];
    if (!u) return;
    const src: SourceRef = { utteranceId: id, rev: u.rev, startMs: u.startMs };
    for (const cat of Object.keys(SIGNAL_QUESTIONS) as SignalCategory[]) {
      const p = a.noul[cat];
      if (p === undefined) continue;
      const sid = `sig:${id}:${cat}`;
      const cur = this.state.signals[sid];
      // 투표: D1 ≥ .85 단독 확정, .5~.85는 L0가 같이 잡았을 때만 (§9)
      if (p >= 0.85 || (p >= 0.5 && cur)) {
        this.emit({ op: 'signal.upsert', s: { id: sid, category: cat, label: SIGNAL_LABEL[cat], origin: [...new Set([...(cur?.origin ?? []), 'D1' as const])], confirmed: true, confidence: Math.max(p, cur?.confidence ?? 0), d1Prob: p, sources: cur?.sources ?? [src], explanation: cur?.explanation ?? `‘${u.text}’`, active: true } });
      } else if (cur && !cur.confirmed && cur.confidence >= 0.85 && p >= 0.25) {
        // 강한 규칙 신호(송금·인증정보 등)는 D1이 분명히 부정할 때만 버린다 (실기: 길고 잡음 많은 실제 녹음에서 D1이 낮게 봐 "신분증 사진 보내줘"가 사라짐)
        this.emit({ op: 'signal.upsert', s: { ...cur, confirmed: true, d1Prob: p } });
      } else if (cur) {
        this.emit({ op: 'signal.upsert', s: { ...cur, d1Prob: p } });
      }
    }
    if ((a.noul.claims_authority ?? 0) >= 0.7) {
      this.confirmProvisional(id, ['org', 'person']);
      this.authorityUtts.add(id);
      this.markAuthority(id);
    }
    const dom = a.choice.domain;
    if (dom && dom.confidence >= 0.8 && dom.choice !== this.state.domain) this.setDomain(dom.choice as Domain, dom.confidence);
    const next = a.choice.next;
    if (next) {
      const chosen = catalog.find((s) => s.id === next.choice);
      if (chosen) this.emit({ op: 'suggestions.set', items: [{ ...chosen, prob: next.confidence }, ...catalog.filter((s) => s.id !== chosen.id).slice(0, 1)] });
    }
    this.afterChange();
  }

  private async runL1(id: string, text: string, tFinal: number) {
    this.l1Abort?.abort();
    const ac = new AbortController();
    this.l1Abort = ac;
    const context = this.state.utteranceOrder.slice(-6, -1).map((uid) => this.state.utterances[uid]!).map((u) => `${u.label}: ${u.text}`).join('\n');
    const u = this.state.utterances[id];
    if (!u) return;
    const src: SourceRef = { utteranceId: id, rev: u.rev, startMs: u.startMs };
    try {
      const r = await this.d.l1.extract(context, `${u.label}: ${text}`, (e) => {
        // 원문 대조: quote가 실제 발화에 없으면 버린다 (§7.5 환각 방지)
        if (!e.quote || !text.replace(/\s+/g, '').includes(e.quote.replace(/\s+/g, ''))) return;
        // 형식이 정해진 값(사건번호·금액·기간·날짜)은 L0만 만든다. L1은 확인만 (§8.10 정확도 2)
        // 실측: STT 오인식 "범주에 연루"를 L1이 사건번호 "범주"로 잡아 누적 단계가 너무 일찍 떴다
        const formatted = FORMATTED_TYPES.has(e.type as Entity['type']);
        // 기관·인물은 L0 사전으로 다시 정규화해서 같은 키로 합친다
        // 부서("형사3부")는 기관 카드를 따로 만들지 않고 기존 기관의 부가 정보로, 이미 기관이 있을 때 일반 명칭("검찰청")은 버린다 (실기 잡음)
        if (e.type === 'org') {
          const existing = Object.values(this.state.entities).find((x) => x.type === 'org' && x.certainty !== 'provisional');
          // 기관이 이미 있을 때만 부서로 본다 (없으면 "신한카드 이상거래 탐지팀"처럼 그 자체가 기관이다)
          if (existing && /^[가-힣]*\d*(부|과|팀|계)$/.test(e.value.replace(/\s+/g, '')) && !/(본부|정부)$/.test(e.value)) {
            if (!existing.attrs.dept) this.upsertEntity({ ...existing, attrs: { ...existing.attrs, dept: e.value, sub: e.value } });
            return;
          }
          if (existing && GENERIC_ORGS.has(e.value.replace(/\s+/g, '')) && existing.value !== e.value) return;
        }
        // 상대가 부른 사람(전화를 받은 나)은 상대 쪽 인물이 아니다 (실기: "최지은 씨 본인 되십니까?" → 인물 카드 "최지은")
        if (e.type === 'person' && u.speaker === 'other') {
          const nm = (e.name ?? e.value).replace(/\s+/g, '');
          if (nm && new RegExp(`${nm}(씨|님|고객님)|${nm}(본인|맞으|되십|이시)`).test(text.replace(/\s+/g, ''))) { this.addressee = nm; return; } // 상대는 자기를 직함으로 부르고, 나를 "○○ 씨"로 부른다
        }
        const viaL0 = this.d.l0.scan(e.quote).entities.find((x) => x.type === e.type);
        // 상대가 "○○ 씨 명의 통장", "본인 명의 계좌"라고 하면 그 계좌는 내 계좌다 (실기: 피해자 명의 통장이 일반 계좌로 빠지고 "안전계좌"가 지도에서 밀려남)
        const flat = text.replace(/\s+/g, '');
        const mine = e.type === 'account' && u.speaker === 'other' && !/안전/.test(e.value) && (Boolean(this.state.entities['account:me']?.sources.some((x) => x.utteranceId === id)) || /(본인|고객님)명의/.test(flat) || (this.addressee && new RegExp(`${this.addressee.slice(0, 1)}[가-힣]{0,3}(씨|님)명의`).test(flat))) && /(통장|계좌)/.test(e.value) && !/안전/.test(e.value);
        const key = mine ? 'account:me' : viaL0?.key ?? (e.type === 'person' ? entityKey('person', e.name ?? e.value.split(/\s/)[0] ?? e.value) : entityKey(e.type, e.value));
        const cur = this.state.entities[key];
        if (formatted && !cur) return;
        if (cur) {
          // 형식이 정해진 값은 L0가 이긴다 → 값은 그대로, 확인만
          if (cur.certainty === 'provisional') this.upsertEntity({ ...cur, certainty: e.certainty ?? 'claimed', origin: [...new Set([...cur.origin, 'L1' as const])] });
        } else {
          this.upsertEntity({ key, type: e.type as Entity['type'], value: mine ? (viaL0?.value ?? e.value).replace(/^.*명의\s*(의|로 된)?\s*/, '') || '내 명의 계좌' : viaL0?.value ?? e.value, attrs: { ...viaL0?.attrs, ...(e.name ? { name: e.name } : {}), ...(mine ? { owner: 'me' } : {}) }, certainty: e.certainty ?? 'claimed', confidence: 0.8, origin: ['L1'], sources: [src] });
          if (this.authorityUtts.has(id)) this.markAuthority(id);
        }
        this.afterChange();
      }, () => {}, ac.signal);
      if (r) this.metric({ name: 'l1_first_entity', utteranceId: id, ms: r.firstMs ?? r.totalMs }, { name: 'final_to_l1_done', utteranceId: id, ms: performance.now() - tFinal });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') console.warn('[l1]', (err as Error).message);
    }
  }

  /** 사전에 없는 기관이라도 D1이 공공기관 자칭으로 봤으면 authority 표시 */
  private markAuthority(id: string) {
    for (const e of Object.values(this.state.entities)) {
      if (e.type !== 'org' || e.attrs.authority === 'true' || !e.sources.some((x) => x.utteranceId === id)) continue;
      this.upsertEntity({ ...e, attrs: { ...e.attrs, authority: 'true' } });
    }
  }

  private confirmL0Signals(id: string) {
    for (const s of Object.values(this.state.signals)) {
      if (!s.confirmed && s.sources.some((x) => x.utteranceId === id)) this.emit({ op: 'signal.upsert', s: { ...s, confirmed: true } });
    }
  }

  private confirmProvisional(id: string, types?: Entity['type'][]) {
    for (const e of Object.values(this.state.entities)) {
      if (e.certainty !== 'provisional' || !e.sources.some((x) => x.utteranceId === id)) continue;
      if (types && !types.includes(e.type)) continue;
      this.upsertEntity({ ...e, certainty: 'claimed', origin: [...new Set([...e.origin, 'D1' as const])] });
    }
  }

  private scheduleExpiry(key: string) {
    clearTimeout(this.expiry.get(key));
    this.expiry.set(key, setTimeout(() => {
      this.expiry.delete(key);
      this.removeProvisional(key);
    }, PROVISIONAL_TTL_MS));
  }

  /**
   * 발언 고치기·화자 바꾸기: 그 발언에서만 나온 정보는 지우고(다시 뽑는다), 다른 발언에도 근거가 있으면 이 발언 근거만 뺀다.
   * 실기: 오인식 사건번호(48270)를 고쳐도 틀린 카드가 사건 슬롯을 차지해 고친 번호가 그려지지 않았다.
   */
  private retractFrom(id: string) {
    for (const e of Object.values(this.state.entities)) {
      if (!e.sources.some((x) => x.utteranceId === id)) continue;
      const rest = e.sources.filter((x) => x.utteranceId !== id);
      if (rest.length) { this.emit({ op: 'entity.upsert', e: { ...e, sources: rest } }); continue; }
      this.emit({ op: 'entity.remove', key: e.key });
      this.canvasEntity(e, true);
      for (const b of Object.values(this.state.boards)) {
        if (b.els[`card:${e.key}`]) this.emit({ op: 'board.patch', boardId: b.id, patch: { remove: { id: `card:${e.key}` } }, atMs: this.now() });
      }
      // 그 정보로 만든 조회 결과 박스도 지운다 (고친 값으로 다시 조회)
      for (const b of Object.values(this.state.boards)) {
        for (const elId of Object.keys(b.els).filter((k) => k.includes(e.key) && k.startsWith('callout:'))) this.emit({ op: 'board.patch', boardId: b.id, patch: { remove: { id: elId } }, atMs: this.now() });
      }
      for (const k of [...this.verified]) if (k.includes(e.value) || k.includes(e.key)) this.verified.delete(k);
    }
  }

  /** 확정된 적 없는 잠정 정보만 사라질 수 있다 (§8.10 정확도 1) */
  private removeProvisional(key: string) {
    const e = this.state.entities[key];
    if (!e || e.certainty !== 'provisional') return;
    clearTimeout(this.expiry.get(key));
    this.expiry.delete(key);
    this.emit({ op: 'entity.remove', key });
    this.canvasEntity(e, true);
    for (const b of Object.values(this.state.boards)) {
      if (b.els[`card:${key}`]) this.emit({ op: 'board.patch', boardId: b.id, patch: { remove: { id: `card:${key}` } }, atMs: this.now() });
    }
  }

  // ── 엔티티 · 보드 ──────────────────────────────────────────
  private upsertEntity(e: Entity) {
    this.emit({ op: 'entity.upsert', e });
    this.ensureCanvas();
    this.canvasEntity(e);
    if (e.certainty !== 'provisional') { clearTimeout(this.expiry.get(e.key)); this.expiry.delete(e.key); }
    for (const b of Object.values(this.state.boards)) {
      const tpl = this.d.packs.templates[b.templateId];
      if (!tpl) continue;
      for (const patch of syncEntity(this.state.boards[b.id]!, tpl, e, this.now())) this.emit({ op: 'board.patch', boardId: b.id, patch, atMs: this.now() });
    }
  }

  private templateFor(domain: DomainPack['id']): BoardTemplate | undefined {
    const pack = this.d.packs.domains[domain];
    return pack ? this.d.packs.templates[pack.board] : undefined;
  }

  /** 첫 L0 단서로 템플릿을 추측해서 바로 연다. 확신이 없으면 general (§8.10-3) */
  private ensureBoard(guess?: DomainPack['id']) {
    if (this.state.boardOrder.some((id) => id !== CANVAS_ID)) return;
    if (!guess && Object.keys(this.state.entities).length === 0) return;
    const tpl = this.templateFor(guess ?? 'general') ?? this.templateFor('general');
    if (tpl && tpl.id !== 'impersonation.entityMap') this.openBoard(tpl, true);
    this.ensureCanvas();
  }

  private openBoard(tpl: BoardTemplate, activate: boolean) {
    const id = `board:${tpl.id}`;
    if (this.state.boards[id]) { if (activate) this.emit({ op: 'board.focus', boardId: id }); return; }
    this.emit({ op: 'board.create', board: createBoard(tpl, id, this.now()), activate });
    for (const e of Object.values(this.state.entities)) {
      for (const patch of syncEntity(this.state.boards[id]!, tpl, e, this.now())) this.emit({ op: 'board.patch', boardId: id, patch, atMs: this.now() });
    }
  }

  private setDomain(domain: Domain, confidence: number) {
    this.emit({ op: 'domain.set', domain, confidence });
    if (domain === 'unknown') return;
    // 첫 단어("휴대폰")로 추측해 연 요금 보드는 요금 상담이 아니라고 정해지면 닫는다 (실기: 가족 사칭 통화에 "결합 요금 상담" 탭)
    if (domain !== 'billing' && this.state.boards['board:billing.compare']) this.emit({ op: 'board.remove', boardId: 'board:billing.compare' });
    const tpl = this.templateFor(domain);
    if (!tpl || this.state.boards[`board:${tpl.id}`]) return;
    if (tpl.id === 'impersonation.entityMap') return; // 사건 지도는 ensureCaseMap이 조건을 보고 연다
    // 도메인이 바뀌면 새 탭으로. 기존 보드는 그대로 둔다 (P5). 지금 보는 게 general이면 새 보드로 이동
    const active = this.state.activeBoardId ? this.state.boards[this.state.activeBoardId] : undefined;
    this.openBoard(tpl, !active || active.templateId === 'general.facts' || active.templateId === 'canvas');
  }

  // ── 검증 ───────────────────────────────────────────────────
  /** 시연(대본 재생)일 때만 가상 명단·가상 사건 조회를 쓴다. 실제 통화에서 가상 명단 기준 "목록에 없음"은 진짜 검사도 사칭으로 만든다 */
  /** 요금표는 가상 데이터라 시연 재생에서만 쓴다 (실기: 실제 SKT 상담을 가상 결합 요금 118,000원과 대조해 "말과 다름") */
  private tariff() {
    if (!this.demo) return undefined;
    const product = Object.values(this.state.entities).find((e) => e.type === 'product')?.value ?? '결합';
    return this.d.verifier.tariff(product) ?? this.d.verifier.tariff('결합');
  }

  private get demo() {
    return this.state.mode === 'replay-fixture' || this.state.mode === 'replay-audio';
  }

  private runVerify() {
    const ents = Object.values(this.state.entities).filter((e) => e.certainty !== 'provisional');
    const org = ents.find((e) => e.type === 'org');
    for (const p of ents.filter((e) => e.type === 'person' && PROSECUTION_TITLES.has(e.attrs.title ?? ''))) {
      if (!org) continue;
      const k = `prosecutor:${org.value}:${p.attrs.name}`;
      if (this.verified.has(k)) continue;
      this.verified.add(k);
      const callId = this.state.callId;
      if (this.demo) void this.d.verifier.prosecutor(org.value, p.attrs.name ?? p.value).then((r) => this.state.callId === callId && this.onProsecutor(r, org, p));
      else void this.identityBySearch(org, p).then(() => this.state.callId === callId && this.afterChange());
    }
    for (const c of ents.filter((e) => e.type === 'case')) {
      const k = `case:${c.value}`;
      if (this.verified.has(k)) continue;
      this.verified.add(k);
      const callId = this.state.callId;
      if (this.demo) void this.d.verifier.caseNo(c.value, org?.value).then((r) => this.state.callId === callId && this.onCase(r, c));
      // 실제 통화: 사건 조회는 본인 인증이 필요해 대신 할 수 없다 → 위험 신호로 쓰지 않는다
      else this.upsertEntity({ ...c, attrs: { ...c.attrs, status: '대신 조회 불가', statusTone: 'gray', sub: '사건 조회는 본인 인증이 필요해요' } });
    }
    if (!this.demo && org && this.isAuthority(org)) this.callbackCard(org, ents.find((e) => e.type === 'person'));
    // 공식 안내 대조: 기관을 자칭한 통화에서 요구가 나오면 (§10)
    const cats = this.confirmedCategories();
    const authority = org && (['prosecution', 'police', 'regulator'].includes(org.attrs.kind ?? '') || org.attrs.authority === 'true');
    if (authority && !this.verified.has('official') && cats.some((c) => ['secrecy', 'money_transfer', 'credential_request', 'remote_app'].includes(c))) {
      this.verified.add('official');
      const callId = this.state.callId;
      void this.d.verifier.official(cats, org.attrs.kind).then((r) => r && this.state.callId === callId && this.onOfficial(r));
    }
    // 공식 안내와 다른 "요구"가 실제로 나오면 그때 신호가 된다
    if (this.state.evidence['ev:official'] && cats.some((c) => ACTION_CATEGORIES.includes(c)) && !this.state.signals['sig:verify:official_mismatch']) {
      const ev = this.state.evidence['ev:official'];
      this.emit({ op: 'signal.upsert', s: { id: 'sig:verify:official_mismatch', category: 'official_mismatch', label: SIGNAL_LABEL.official_mismatch, origin: ['verify'], confirmed: true, confidence: 0.95, sources: this.actionSources(), explanation: ev.quote ?? ev.title, active: true } });
    }
  }

  private isAuthority(org: Entity) {
    return ['prosecution', 'police', 'regulator'].includes(org.attrs.kind ?? '') || org.attrs.authority === 'true';
  }

  /**
   * 실제 통화의 신원 확인: 웹 검색은 "이름이 공개 자료에 있는지"까지만 알려 준다. 통화 상대가 본인인지는 검색으로 알 수 없고,
   * 사기범은 실존 검사 이름을 도용하기도 한다 → 어느 쪽이든 위험 신호로 쓰지 않는다. 확인은 다시 걸기(callbackCard)로.
   */
  private async identityBySearch(org: Entity, p: Entity) {
    const name = p.attrs.name ?? p.value;
    const run = this.d.web?.enabledNames.length ? await this.d.web.search(`${org.value} ${name} ${p.attrs.title ?? ''}`.trim()).catch(() => null) : null;
    const hit = run?.merged.find((h) => h.tier !== 'reference' && `${h.title} ${h.snippet}`.includes(name) && /검사|수사관|형사|조사관/.test(`${h.title} ${h.snippet}`));
    const cur = this.state.entities[p.key];
    if (!cur) return;
    const evId = `ev:identity:${p.key}`;
    this.emit({ op: 'evidence.upsert', ev: { id: evId, tier: hit ? (hit.tier === 'official' ? 'official' : 'reference') : 'lookup', title: `${org.value} ${name} ${p.attrs.title ?? ''} 공개 자료`.trim(), quote: hit?.snippet.slice(0, 120), url: hit?.url, scope: hit ? `확인 범위 · 웹 검색 (${hit.host})` : '확인 범위 · 웹 검색', query: run?.query, resultCount: run?.merged.length ?? 0, status: hit ? 'found' : 'unverifiable', reason: hit ? undefined : 'no_source', caveat: '이름이 공개 자료에 있어도 통화 상대가 그 사람이라는 뜻은 아니에요. 실존 인물 이름을 도용하기도 해요.', isMock: false, checkedAtMs: this.now(), linkedUtteranceIds: p.sources.map((x) => x.utteranceId) } });
    // 표시는 항상 "본인 확인 안 됨". 흔한 이름은 검색에 잘 걸려서 "공개 자료에 있음"이 사칭범에게 신뢰를 줄 수 있다 (실기: 사칭 통화의 "박정훈 형사")
    this.upsertEntity({ ...cur, attrs: { ...cur.attrs, status: '본인 확인 안 됨', statusTone: 'gray', sub: hit ? '같은 이름의 공개 자료 있음 — 도용일 수 있어요' : '다시 걸어서만 확인할 수 있어요' } });
  }

  /** AI 답변이 사건 지도의 "확인 방법" 카드와 같은 내용을 쓰도록 */
  private callbackHint(): string {
    const org = Object.values(this.state.entities).find((e) => e.type === 'org' && e.certainty !== 'provisional');
    if (!org) return '통화를 끊고 기관 공식 홈페이지에서 직접 찾은 대표번호로 다시 걸어 확인';
    const person = Object.values(this.state.entities).find((e) => e.type === 'person' && e.certainty !== 'provisional');
    return `통화를 끊고 ${officialLine(org.value, org.attrs.kind)}로 다시 걸어 ${person ? `${person.attrs.name ?? person.value} ${person.attrs.title ?? ''} ` : '담당자 '}연결을 요청`;
  }

  /** 실제 통화: 사건 지도에 "확인 방법" 카드 — 직접 찾은 대표번호로 다시 걸어 연결 요청 */
  private callbackCard(org: Entity, person?: Entity) {
    const num = officialLine(org.value, org.attrs.kind);
    const who = person ? `‘${person.attrs.name ?? person.value} ${person.attrs.title ?? ''}${person.attrs.title === '검사' ? '실' : ''}’ 연결을 요청하세요` : '담당자 연결을 요청하세요';
    this.boardCallout({ kind: 'callout', id: 'callout:callback', zone: 'lookup', tone: 'info', title: '확인 방법', body: `통화를 끊고 직접 찾은 대표번호로 다시 걸어 ${who}.\n${num}`, pills: [{ text: '다시 걸기', tone: 'teal' }], sources: org.sources });
  }

  private evidence(id: string, r: VerifyResult, claimId: string | undefined, links: string[]) {
    this.emit({ op: 'evidence.upsert', ev: { id, claimId, tier: r.tier, title: r.title, quote: r.quote, scope: r.scope, query: r.query, resultCount: r.resultCount, status: r.status, reason: r.reason, caveat: r.caveat, isMock: r.isMock, checkedAtMs: this.now(), linkedUtteranceIds: links } });
  }

  private onProsecutor(r: VerifyResult, org: Entity, person: Entity) {
    const links = person.sources.map((s) => s.utteranceId);
    this.evidence(`ev:prosecutor:${person.key}`, r, `claim:${person.key}:소속`, links);
    this.emit({ op: 'claim.upsert', c: { id: `claim:${person.key}:소속`, subject: person.key, predicate: '소속', value: org.value, sources: person.sources, verification: r.status, reason: r.reason, evidenceIds: [`ev:prosecutor:${person.key}`] } });
    if (r.status === 'unverifiable' && r.reason === 'not_found') {
      this.upsertEntity({ ...this.state.entities[org.key]!, attrs: { ...this.state.entities[org.key]!.attrs, status: '목록에 없음', statusTone: 'amber' } });
      this.upsertEntity({ ...this.state.entities[person.key]!, attrs: { ...this.state.entities[person.key]!.attrs, status: '신원 미확인', statusTone: 'gray' } });
      this.canvasEvidence(`prosecutor:${person.key}`, '검사 목록', `${org.value} 목록에 ‘${person.attrs.name}’ 없음`, 'unknown', `heard:${person.key}`, r.isMock);
      this.emit({ op: 'signal.upsert', s: { id: `sig:verify:impersonation:${person.key}`, category: 'impersonation', label: SIGNAL_LABEL.impersonation, origin: ['verify'], confirmed: true, confidence: 0.9, sources: person.sources, explanation: `${org.value} 공개 검사 목록에 ‘${person.attrs.name}’이 없습니다.`, active: true } });
    } else if (r.status === 'found') {
      this.upsertEntity({ ...this.state.entities[person.key]!, attrs: { ...this.state.entities[person.key]!.attrs, status: '목록에 있음', statusTone: 'teal', sub: '목록에 있어도 통화 상대가 그 사람이라는 뜻은 아니에요' } });
    } else if (r.reason === 'no_source') {
      this.upsertEntity({ ...this.state.entities[person.key]!, attrs: { ...this.state.entities[person.key]!.attrs, status: '조회 연결 전', statusTone: 'gray' } });
    }
    this.afterChange();
  }

  private onCase(r: VerifyResult, c: Entity) {
    const links = c.sources.map((s) => s.utteranceId);
    const evId = `ev:case:${c.key}`;
    this.evidence(evId, r, `claim:${c.key}:존재`, links);
    this.emit({ op: 'claim.upsert', c: { id: `claim:${c.key}:존재`, subject: c.key, predicate: '사건 존재', value: c.value, sources: c.sources, verification: r.status, reason: r.reason, evidenceIds: [evId] } });
    const notFound = r.status === 'unverifiable' && r.reason === 'not_found';
    this.upsertEntity({ ...this.state.entities[c.key]!, attrs: { ...this.state.entities[c.key]!.attrs, status: notFound ? '조회 결과 없음' : r.status === 'found' ? '자료 발견' : '조회 연결 전', statusTone: notFound ? 'amber' : r.status === 'found' ? 'teal' : 'gray' } });
    if (notFound) this.emit({ op: 'signal.upsert', s: { id: `sig:verify:case:${c.key}`, category: 'unverifiable_case', label: SIGNAL_LABEL.unverifiable_case, origin: ['verify'], confirmed: true, confidence: 0.85, sources: c.sources, explanation: `공개 조회에서 ${c.value}를 찾지 못했습니다.`, active: true } });
    const el: Extract<BoardEl, { kind: 'callout' }> = {
      kind: 'callout', id: `callout:${evId}`, zone: 'lookup', tone: 'amber', title: '사건 조회',
      body: notFound ? '공개 조회에서 사건을 찾지 못했어요' : r.status === 'found' ? '공개 조회에서 사건을 찾았어요' : '사건 조회가 아직 연결되지 않았어요',
      pills: [{ text: notFound ? '확인 불가' : r.status === 'found' ? '자료 발견' : '조회 연결 전', tone: notFound ? 'amber' : r.status === 'found' ? 'teal' : 'gray' }],
      evidenceIds: [evId], sources: c.sources,
    };
    if (r.caveat || r.isMock) el.body += `\n${[r.caveat, r.isMock ? '시연용 가상 출처' : ''].filter(Boolean).join(' · ')}`;
    this.boardCallout(el, `card:${c.key}`);
    this.canvasEvidence(evId, '사건 조회', el.body.split('\n')[0]!, notFound ? 'unknown' : r.status === 'found' ? 'confirmed' : 'unknown', `heard:${c.key}`, r.isMock);
    this.afterChange();
  }

  private onOfficial(r: VerifyResult) {
    this.evidence('ev:official', r, undefined, this.actionSources().map((s) => s.utteranceId));
    this.canvasEvidence('official', '공식 안내', r.quote ?? r.title, 'contradicted', '', r.isMock);
    this.boardCallout({ kind: 'callout', id: 'callout:ev:official', zone: 'official', tone: 'red', title: '공식 안내와 대조', body: `공식 안내는 ${r.quote?.replace(/습니다\.$/, '는다고 설명해요.') ?? r.title}`, pills: [{ text: '차이 발견', tone: 'red' }, { text: '공식 자료', tone: 'teal' }], evidenceIds: ['ev:official'], sources: [] });
    this.afterChange();
  }

  /** 캔버스 도식(규칙): 상태에서 다시 계산해서 달라진 도식만 보낸다. 에이전트 도식(ag:)은 건드리지 않는다 */
  private syncFigures() {
    const figs = buildRuleFigures(this.state, this.state.domain === 'billing' ? this.tariff() : undefined);
    for (const f of figs) {
      const cur = this.state.figures[f.id];
      if (cur) { const { meta: _m, ...rest } = cur; if (JSON.stringify(rest) === JSON.stringify(f)) continue; }
      this.emit({ op: 'figure.upsert', figure: { ...f, meta: { by: 'rule', updatedAtMs: this.now(), rev: (cur?.meta.rev ?? 0) + 1 } } });
    }
  }

  /** 에이전트가 그린 도식 (검증·안전장치 통과 후) */
  addAgentFigure(f: Figure) {
    const cur = this.state.figures[f.id];
    this.emit({ op: 'figure.upsert', figure: { ...f, meta: { by: 'agent', updatedAtMs: this.now(), rev: (cur?.meta.rev ?? 0) + 1 } } });
  }

  /** 위험 신호가 생기면 도메인과 상관없이 사건 지도를 연다 (대출·택배·가족 사칭 등도 그림으로) */
  /** 사건 지도는 위험 신호가 있거나, 사칭 유형으로 분류되고 기관·인물이 잡혔을 때 연다 (실기: 카드사 정상 통화에 빈 지도가 열렸다) */
  private ensureCaseMap() {
    if (this.state.boards[CASE_MAP]) return;
    const hasWho = Object.values(this.state.entities).some((e) => (e.type === 'org' || e.type === 'person') && e.certainty !== 'provisional');
    if (this.state.risk.level === 'none' && !(this.state.domain === 'impersonation' && hasWho)) return;
    const tpl = this.d.packs.templates['impersonation.entityMap'];
    if (!tpl) return;
    const active = this.state.activeBoardId ? this.state.boards[this.state.activeBoardId] : undefined;
    this.openBoard(tpl, !active || active.templateId === 'general.facts' || active.templateId === 'canvas');
  }

  /** 사건 지도 고도화: 요구 카드(→ 나), 범례 손글씨. 상태에서 결정론적으로 다시 계산해 달라진 것만 보낸다 */
  private syncCaseMapExtras() {
    const b = this.state.boards[CASE_MAP];
    const tpl = this.d.packs.templates['impersonation.entityMap'];
    if (!b || !tpl) return;
    const now = this.now();
    const put = (el: BoardEl, at: { x: number; y: number; w: number; h: number }) => {
      const cur = this.state.boards[CASE_MAP]!.els[el.id];
      if (!cur) this.emit({ op: 'board.patch', boardId: CASE_MAP, patch: { add: { els: [el], placed: [{ id: el.id, ...at }] } }, atMs: now }, { op: 'board.patch', boardId: CASE_MAP, patch: { badge: { id: el.id, text: '방금 추가', untilMs: now + 4000 } }, atMs: now });
      else if (JSON.stringify(cur) !== JSON.stringify(el)) this.emit({ op: 'board.patch', boardId: CASE_MAP, patch: { update: { id: el.id, fields: el } }, atMs: now });
    };
    // ① 요구 카드: 확정된 행동 신호(송금·인증정보·앱 설치)를 처음 나온 순서대로
    const zone = tpl.zones.demands!;
    const first = new Map<SignalCategory, RiskSignal>();
    for (const sg of Object.values(this.state.signals).filter((x) => x.active && x.confirmed && ACTION_CATEGORIES.includes(x.category)).sort((x, y) => (x.sources[0]?.startMs ?? 0) - (y.sources[0]?.startMs ?? 0))) if (!first.has(sg.category)) first.set(sg.category, sg);
    for (const sg of [...first.values()].slice(0, 3)) {
      const u = this.state.utterances[sg.sources[0]?.utteranceId ?? ''];
      const id = `demand:${sg.category}`;
      const cur = this.state.boards[CASE_MAP]!.placed[id];
      // 위치는 처음 놓일 때 정한다: 이미 그려진 요구 카드 수 = 다음 칸 (나중에 순서가 바뀌어도 겹치지 않게)
      // 비어 있는 가장 앞 칸 (카드가 지워진 자리를 다시 쓴다 — 개수로 정하면 남은 카드와 겹친다)
      const taken = new Set(Object.entries(this.state.boards[CASE_MAP]!.placed).filter(([k]) => k.startsWith('demand:')).map(([, p]) => p.y));
      let slot = 0;
      while (taken.has(gridCell(zone, slot).y)) slot++;
      const at = cur ?? gridCell(zone, slot);
      put({ kind: 'card', id, zone: 'demands', label: '요구', value: sg.label, sub: u ? clockOf(u.startMs) : undefined, pills: [], style: 'demand', sources: sg.sources }, at);
    }
    // 계좌 언급이 없는 사기(앱 설치 등)에서도 요구가 가리킬 "나" 카드를 둔다
    const slotMe = tpl.slots.me_account!;
    const meCard = Object.values(this.state.boards[CASE_MAP]!.els).find((el) => el.kind === 'card' && el.slot === 'me_account');
    const hasAccount = Boolean(meCard);
    if (first.size && !hasAccount) put({ kind: 'card', id: 'card:me', zone: 'slot', label: '나', value: '전화를 받은 나', pills: [], style: 'me', sources: [] }, { x: slotMe.x, y: slotMe.y, w: slotMe.w, h: slotMe.h });
    // 내 계좌 카드가 나중에 생기면 자리를 비켜 준다 (같은 칸에 두 장이 겹치지 않게)
    if (meCard && this.state.boards[CASE_MAP]!.els['card:me']) this.emit({ op: 'board.patch', boardId: CASE_MAP, patch: { remove: { id: 'card:me' } }, atMs: this.now() });
    const accId = meCard?.id ?? 'card:me';
    // 근거가 사라진 요구 카드(발언 고치기·화자 바꾸기)는 지운다. 사용자가 바로잡은 것이라 그대로 두면 틀린 그림이다
    for (const id of Object.keys(this.state.boards[CASE_MAP]!.els).filter((k) => k.startsWith('demand:'))) {
      if (!first.has(id.slice(7) as SignalCategory)) {
        this.emit({ op: 'board.patch', boardId: CASE_MAP, patch: { remove: { id } }, atMs: now });
        // remove 패치는 그 요소에 붙은 연결선도 함께 지운다 (applyBoardPatch)
      }
    }
    const acc = this.state.boards[CASE_MAP]!.placed[accId];
    const d0 = this.state.boards[CASE_MAP]!.placed[`demand:${[...first.keys()][0]}`];
    if (acc && d0 && !this.state.boards[CASE_MAP]!.edges['edge:demands->me']) {
      const g = route(d0, acc);
      this.emit({ op: 'board.patch', boardId: CASE_MAP, patch: { edges: [{ id: 'edge:demands->me', from: `demand:${[...first.keys()][0]}`, to: accId, kind: 'claim', label: '나에게 요구', path: g.path, labelAt: { x: g.labelAt.x + 4, y: g.labelAt.y } }] }, atMs: now });
    }
    // ② 범례: 점선(주장) 카드가 하나라도 생기면 (디자인 2번의 "점선 = 아직 확인 전인 주장")
    const hasClaimed = Object.values(this.state.boards[CASE_MAP]!.els).some((e) => e.kind === 'card' && e.style === 'claimed');
    if (hasClaimed) put({ kind: 'hand', id: 'hand:legend', zone: 'legend', text: '점선 = 아직 확인 전인 주장', sources: [] }, tpl.zones.legend!);
  }

  /** 에이전트가 남긴 핵심 메모를 사건 지도 손글씨로 (가장 최근 1개) */
  private caseMapAgentNote(text: string) {
    const tpl = this.d.packs.templates['impersonation.entityMap'];
    const b = this.state.boards[CASE_MAP];
    if (!b || !tpl) return;
    // 위험 신호가 없는 통화에서는 경고성 메모를 지도에 올리지 않는다 (실기: 진짜 검사 통화에 "검찰은 전화로 출석을 요구하지 않습니다")
    if (this.state.risk.level === 'none') return;
    const safe = soften(text);
    if (!safe || unknownChannel(safe)) return;
    const el: BoardEl = { kind: 'hand', id: 'hand:agent', zone: 'agent', text: safe.length > 44 ? `${safe.slice(0, 42)}…` : safe, sources: [] };
    const now = this.now();
    if (!b.els[el.id]) this.emit({ op: 'board.patch', boardId: CASE_MAP, patch: { add: { els: [el], placed: [{ id: el.id, ...tpl.zones.agent! }] } }, atMs: now });
    else this.emit({ op: 'board.patch', boardId: CASE_MAP, patch: { update: { id: el.id, fields: el } }, atMs: now }, { op: 'board.patch', boardId: CASE_MAP, patch: { badge: { id: el.id, text: '방금 갱신', untilMs: now + 4000 } }, atMs: now });
  }

  /** 요금 상담 보드(디자인 5·11번): 상태가 바뀔 때마다 다시 계산해서 달라진 요소만 보낸다 */
  private syncBillingBoard() {
    const b = this.state.boards['board:billing.compare'];
    const tpl = this.d.packs.templates['billing.compare'];
    if (!b || !tpl) return;
    const { els, placed, edges } = buildBillingBoard(this.state, tpl, this.tariff());
    const now = this.now();
    for (const el of els) {
      const cur = this.state.boards[b.id]!.els[el.id];
      if (!cur) this.emit({ op: 'board.patch', boardId: b.id, patch: { add: { els: [el], placed: placed.filter((p) => p.id === el.id) } }, atMs: now }, { op: 'board.patch', boardId: b.id, patch: { badge: { id: el.id, text: '방금 추가', untilMs: now + 4000 } }, atMs: now });
      else if (JSON.stringify(cur) !== JSON.stringify(el)) this.emit({ op: 'board.patch', boardId: b.id, patch: { update: { id: el.id, fields: el } }, atMs: now }, { op: 'board.patch', boardId: b.id, patch: { badge: { id: el.id, text: '방금 갱신', untilMs: now + 4000 } }, atMs: now });
    }
    const missing = edges.filter((e) => !this.state.boards[b.id]!.edges[e.id]);
    if (missing.length) this.emit({ op: 'board.patch', boardId: b.id, patch: { edges: missing }, atMs: now });
  }

  private canvasEvidence(id: string, label: string, value: string, tone: 'unknown' | 'confirmed' | 'contradicted', linkTo: string, isMock: boolean) {
    const b = this.canvas();
    if (!b) return;
    if (!b.els['sec:evidence']) this.canvasApply(upsertSection(b, { id: 'evidence', title: '확인 결과', layout: 'evidence' }, this.now()));
    this.canvasApply(upsertChild(this.canvas()!, { kind: 'item', id: `ev:${id}`, zone: 'canvas', section: 'sec:evidence', label, value, tone, pills: [{ text: tone === 'unknown' ? '확인 못 함' : tone === 'confirmed' ? '자료 발견' : '말과 다름', tone: tone === 'contradicted' ? 'red' : tone === 'confirmed' ? 'teal' : 'amber' }, ...(isMock ? [{ text: '시연용 가상 출처', tone: 'gray' as const }] : [])], sources: [] }, this.now()));
    const nb = this.canvas()!;
    if (nb.placed[linkTo]) this.canvasApply(link(nb, { from: `ev:${id}`, to: linkTo, kind: 'evidence' }));
  }

  private boardCallout(el: Extract<BoardEl, { kind: 'callout' }>, linkTo?: string) {
    for (const b of Object.values(this.state.boards)) {
      const tpl = this.d.packs.templates[b.templateId];
      if (!tpl) continue;
      const zone = tpl.zones[el.zone] ? el.zone : tpl.zones.checks ? 'checks' : undefined;
      if (!zone) continue;
      for (const patch of syncCallout(this.state.boards[b.id]!, tpl, { ...el, zone }, this.now(), linkTo)) this.emit({ op: 'board.patch', boardId: b.id, patch, atMs: this.now() });
    }
  }

  // ── 파생 상태 ──────────────────────────────────────────────
  private confirmedCategories(): SignalCategory[] {
    return [...new Set(Object.values(this.state.signals).filter((s) => s.active && s.confirmed).map((s) => s.category))];
  }

  private actionSources(): SourceRef[] {
    return Object.values(this.state.signals).filter((s) => s.active && s.confirmed && ACTION_CATEGORIES.includes(s.category)).flatMap((s) => s.sources);
  }

  private afterChange() {
    this.runVerify();
    this.autoSearch();
    this.syncBillingBoard();
    this.recomputeRisk(false);
    // 위험 단계를 계산한 뒤에 연다 (마지막 발화에서 처음 위험이 생기는 경우를 놓치지 않게)
    this.ensureCaseMap();
    this.syncCaseMapExtras();
    this.refreshSignalSummary();
    this.syncFigures();
    this.refreshTags();
    this.refreshSuggestions();
    const text = this.situationText();
    if (text !== this.state.situation.text) this.emit({ op: 'situation.set', text, rev: this.state.situation.rev + 1 });
  }

  private gate(): SignalCategory[] {
    const d = this.state.domain;
    return d === 'billing' || d === 'general' ? (this.d.packs.domains[d]?.gate ?? []) : [];
  }

  private recomputeRisk(allowDowngrade: boolean) {
    // "공식 안내와 다름"은 행동 요구가 있을 때만 성립한다 (실기: 고치기로 송금 요구가 사라져도 남아서 '누적'이 유지됐다)
    const om = this.state.signals['sig:verify:official_mismatch'];
    if (om) {
      const hasAction = Object.values(this.state.signals).some((x) => x.active && x.confirmed && ACTION_CATEGORIES.includes(x.category));
      if (om.active !== hasAction) this.emit({ op: 'signal.upsert', s: { ...om, active: hasAction } });
    }
    const next = nextRisk(this.state.risk, { signals: Object.values(this.state.signals), domain: this.state.domain, gate: this.gate() }, this.now(), allowDowngrade);
    if (!sameRisk(next, this.state.risk)) this.emit({ op: 'risk.set', risk: next });
    this.refreshSignalSummary();
  }

  private refreshSignalSummary() {
    const signals = Object.values(this.state.signals).filter((s) => s.active && s.confirmed);
    const cats = this.state.risk.activeCategories;
    if (!cats.length) return;
    const hasAction = cats.some((c) => ACTION_CATEGORIES.includes(c));
    const labels = cats.map((c) => SIGNAL_LABEL[c]).join(' · ');
    this.boardCallout({ kind: 'callout', id: 'callout:signals', zone: 'signals', tone: 'signal', title: `확인된 위험 신호 ${cats.length}건`, body: `${labels}.${hasAction ? '' : ' 아직 송금 요구는 없어요.'}`, pills: [], sources: signals.flatMap((s) => s.sources) });
  }

  private refreshTags() {
    const byUtt = new Map<string, string[]>();
    // 도메인 게이트로 걸러진 신호는 태그도 숨긴다 (요금 상담의 "오늘 가입하시면 할인" 등)
    const counted = new Set(this.state.risk.activeCategories);
    for (const s of Object.values(this.state.signals)) {
      if (!s.active || !s.confirmed || s.origin.includes('verify') || !counted.has(s.category)) continue;
      for (const src of s.sources) byUtt.set(src.utteranceId, [...new Set([...(byUtt.get(src.utteranceId) ?? []), s.label])]);
    }
    for (const [id, tags] of byUtt) {
      const u = this.state.utterances[id];
      if (u && u.tags.join() !== tags.join()) this.emit({ op: 'utt.upsert', u: { ...u, tags } as Utterance });
    }
  }

  private suggestionCatalog(): Suggestion[] {
    const d = this.state.domain === 'unknown' ? (this.state.boardOrder[0]?.includes('impersonation') ? 'impersonation' : 'general') : this.state.domain;
    const pack = this.d.packs.domains[d as DomainPack['id']] ?? this.d.packs.domains.general;
    const types = new Set(Object.values(this.state.entities).map((e) => e.type));
    const cats = this.confirmedCategories();
    const orgKinds = Object.values(this.state.entities).filter((e) => e.type === 'org' && e.certainty !== 'provisional').map((e) => e.attrs.kind ?? 'unknown');
    return pack.suggestions
      .filter((s) => !(s.unless?.entityType && types.has(s.unless.entityType)))
      .filter((s) => !s.requires?.signal || s.requires.signal.some((c) => cats.includes(c)))
      .filter((s) => !s.requires?.orgKind || orgKinds.some((k) => s.requires!.orgKind!.includes(k)))
      .map(({ id, kind, text, why }) => ({ id, kind, text, why }));
  }

  private refreshSuggestions() {
    const catalog = this.suggestionCatalog();
    const ids = new Set(catalog.map((s) => s.id));
    const kept = this.state.suggestions.filter((s) => ids.has(s.id));
    // 행동 요구(송금·인증정보·앱 설치)가 생기면 그 요구에 맞는 안내를 맨 앞에 (도메인과 상관없이)
    // 실기: 앱 설치 사기에 "송금하거나 인증번호를… 수사기관은…"이 떠서 상황과 안 맞았다
    const actions = this.confirmedCategories().filter((c) => ACTION_CATEGORIES.includes(c));
    const org = Object.values(this.state.entities).find((e) => e.type === 'org' && e.certainty !== 'provisional');
    const lawEnf = ['prosecution', 'police'].includes(org?.attrs.kind ?? '');
    const family = !org && familyClaim(this.state);
    const urgent: Suggestion | undefined = actions.length ? {
      id: 'dont_transfer', kind: 'action', text: warningHeadline(actions).replace(/^지금 /, ''),
      why: lawEnf ? '수사기관은 전화로 이체나 인증정보를 요구하지 않아요.' : family ? '가족이라도 원래 알던 번호로 다시 걸어 직접 확인하세요.' : '공공기관·금융회사는 전화로 앱 설치·이체·인증정보를 요구하지 않아요.',
    } : undefined;
    let items = (kept.length ? kept : catalog.slice(0, 2)).filter((x) => x.id !== 'dont_transfer');
    // 가족 사칭에 "공식 번호를 물어보세요"는 맞지 않는다 → 둘만 아는 질문
    if (family) items = [{ id: 'ask_family_secret', kind: 'ask', text: '둘만 아는 걸 물어보세요', why: '목소리만으로는 가족인지 알 수 없어요.' }, ...items.filter((x) => x.id !== 'ask_contact')];
    if (urgent) items = [urgent, ...items].slice(0, 2);
    const key = (xs: Suggestion[]) => xs.map((x) => `${x.id}:${x.text}`).join();
    if (key(items) !== key(this.state.suggestions)) this.emit({ op: 'suggestions.set', items });
  }

  /** 현재 상황 한 문장 — L2가 붙기 전까지 상태에서 결정론적으로 만든다 (§14.1-④) */
  private situationText(phase = this.state.phase): string {
    if (phase === 'ended') return '통화가 끝났어요';
    const cats = this.state.risk.activeCategories;
    const ents = Object.values(this.state.entities).filter((e) => e.certainty !== 'provisional');
    const org = ents.find((e) => e.type === 'org');
    if (this.state.risk.level === 'final') {
      const asks = [cats.includes('money_transfer') && '송금', cats.includes('remote_app') && '앱 설치', cats.includes('credential_request') && '인증번호 전달'].filter(Boolean) as string[];
      return `상대가 ${asks.length ? listWithParticle(asks) : '위험한 행동을'} 직접 요구하고 있어요`;
    }
    if (cats.includes('unverifiable_case')) return '상대가 말한 사건번호를 조회했지만 확인되지 않았어요';
    if (org && ['prosecution', 'police'].includes(org.attrs.kind ?? '')) return `수사기관을 자칭하는 상대가 ${ents.some((e) => e.type === 'account') ? '계좌 연루를 안내하는 중' : '연락한 통화'}`;
    if (org && org.attrs.kind === 'regulator') return '금융기관을 자칭하는 상대와 통화 중';
    if (org && org.attrs.authority === 'true') return `${withParticle(org.value, '을', '를')} 자칭하는 상대와 통화 중`;
    if (this.state.domain === 'billing') {
      const products = ents.filter((e) => e.type === 'product').map((e) => e.value);
      const named = products.filter((p) => p !== '결합');
      return `${named.length ? named.join('·') + ' ' : ''}${products.includes('결합') ? '결합 ' : ''}요금을 상담하는 중`;
    }
    return '통화 내용을 듣는 중';
  }

  private onAsk(text: string, preset?: string) {
    const at = this.now();
    const turnId = () => `c${this.state.chat.length + 1}`;
    this.emit({ op: 'chat.turn', turn: { id: turnId(), role: 'me', text, atMs: at, done: true } });
    const aiId = turnId();
    const fallback = this.ruleAnswer(preset);
    const chat = this.d.agentChat;
    if (!chat?.available || preset === 'todo') {
      this.emit({ op: 'chat.turn', turn: { id: aiId, role: 'ai', text: fallback, atMs: this.now(), done: true } });
      return;
    }
    // 바로 "생각 중" 말풍선 → LLM 답으로 교체 (디자인 8번)
    this.emit({ op: 'chat.turn', turn: { id: aiId, role: 'ai', text: '생각 중…', atMs: this.now(), done: false } });
    const callId = this.state.callId;
    const ctx = this.agentContext();
    const evidence = Object.values(this.state.evidence).map((e) => `${e.title}: ${e.status}${e.quote ? ` (“${e.quote}”)` : ''}`);
    const found = this.canvas() ? Object.values(this.canvas()!.els).filter((e) => e.kind === 'item' && (e.tone === 'official' || e.section === 'sec:evidence')).slice(-6).map((e) => (e.kind === 'item' ? `${e.label}: ${e.value}${e.sub ? ` — ${e.sub}` : ''}` : '')) : [];
    const q = preset === 'simplify' ? '지금 상황을 아주 쉽게 3줄로 설명해 줘.' : text;
    void chat.chat([
      { role: 'system', content: '너는 통화를 함께 듣는 보조 "이어리"다. 사용자는 통화 중이다. 3문장 이내, 쉬운 한국어로 답한다. 단정하지 않는다("사기다" 금지, "확인되지 않았다"는 가능). 진위를 묻는 질문("진짜 검사 맞아요?")에는 "아니요/맞아요"로 시작하지 말고 "통화만으로는 확인할 수 없어요"로 시작한 뒤 확인_방법을 그대로 안내한다. 이어리는 대신 전화를 끊거나 연락하거나 신고하지 않는다. 전화번호는 확인_방법에 있는 번호와 경찰 112, 금융감독원 1332만 쓴다(검색 결과에 나온 번호는 쓰지 않는다). 근거가 있으면 짧게 언급한다.' },
      { role: 'user', content: JSON.stringify({ 질문: q, 위험_단계: ctx.risk, 신호: ctx.signals, 최근_대화: ctx.transcript.slice(-6), 확인_결과: evidence, 찾은_자료: found, 확인_방법: this.callbackHint() }) },
    ], []).then((r) => {
      if (this.state.callId !== callId) return;
      const answer = r?.msg.content?.trim();
      // 확인되지 않은 전화번호는 지운다 (실측: 검색 결과의 업체 번호를 "지검 공식 대표번호"로 안내)
      const softened = answer && !/제가 (대신|끊|신고)/.test(answer) ? soften(scrubPhones(answer.slice(0, 400)).text) : null;
      const safe = softened ?? fallback;
      this.emit({ op: 'chat.turn', turn: { id: aiId, role: 'ai', text: safe, atMs: this.now(), done: true } });
      // 물어본 답은 분석 로그에도 남긴다
      const b = this.canvas();
      if (b && safe !== fallback) {
        if (!b.els['sec:think']) this.canvasApply(upsertSection(b, { id: 'think', title: '이어리 메모', layout: 'notes' }, this.now()));
        this.canvasApply(upsertChild(this.canvas()!, { kind: 'item', id: `ask:${aiId}`, zone: 'canvas', section: 'sec:think', label: 'AI 답변', value: q.slice(0, 40), sub: safe.slice(0, 120), tone: 'info', pills: [], sources: [] }, this.now()));
      }
    }).catch(() => this.emit({ op: 'chat.turn', turn: { id: aiId, role: 'ai', text: fallback, atMs: this.now(), done: true } }));
    if (!preset) this.agent?.trigger(`사용자 질문: ${text}`);
  }

  /** LLM이 없을 때의 답: 상태에서 결정론적으로 */
  private ruleAnswer(preset?: string): string {
    if (preset === 'simplify' || preset === 'evidence') {
      const lines = Object.values(this.state.evidence).map((ev) => `· ${ev.title}: ${ev.status === 'mismatch' ? '말과 다름' : ev.status === 'unverifiable' ? (ev.reason === 'no_source' ? '조회 연결 전' : '확인 불가') : ev.status === 'found' ? '자료 발견' : '조회 중'}`);
      return lines.length ? `지금까지 확인한 것:\n${lines.join('\n')}` : '아직 확인한 근거가 없어요.';
    }
    if (preset === 'todo') return this.state.suggestions.map((s) => `· ${s.text}`).join('\n') || '지금 따로 할 일은 없어요.';
    return '지금은 답을 만들 수 없어요. 보드와 근거를 확인해 주세요.';
  }

  dispose() {
    this.agent?.stop();
    this.stopPlayback?.();
    this.closeStreams();
    for (const t of this.expiry.values()) clearTimeout(t);
    this.l1Abort?.abort();
  }
}

function dedupeSources(xs: SourceRef[]): SourceRef[] {
  const m = new Map<string, SourceRef>();
  for (const x of xs) m.set(x.utteranceId, x);
  return [...m.values()];
}

/** 신호가 잡힌 부분이 들어 있는 문장 (실기: 패턴 조각 "‘외부에 말씀하시면 안’"이 어색했다) */
function sentenceAround(text: string, span: { start: number; end: number }) {
  const starts = [...text.matchAll(/[.!?。]\s*/g)].map((m) => m.index! + m[0].length);
  const from = Math.max(0, ...starts.filter((i) => i <= span.start));
  const endM = text.slice(span.end).search(/[.!?。]/);
  const to = endM < 0 ? text.length : span.end + endM;
  const s = text.slice(from, to).trim();
  return s.length > 48 ? `${s.slice(0, 46)}…` : s;
}


/** ["송금", "인증번호 전달"] → "송금과 인증번호 전달을", 3개면 "A, B와 C를" */
function listWithParticle(xs: string[]) {
  const last = xs[xs.length - 1]!;
  const head = xs.slice(0, -1);
  const joined = head.length ? `${head.slice(0, -1).map((x) => `${x}, `).join('')}${withParticle(head[head.length - 1]!, '과', '와')} ` : '';
  return `${joined}${withParticle(last, '을', '를')}`;
}

function concatPcm(chunks: Uint8Array[]): Int16Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total - (total % 2));
  let o = 0;
  for (const c of chunks) { const n = Math.min(c.length, buf.length - o); buf.set(c.subarray(0, n), o); o += n; }
  return new Int16Array(buf.buffer, 0, buf.length / 2);
}

/** 기관별 다시 걸 번호: 검증된 공식 번호만 (core/safety OFFICIAL_NUMBERS와 같은 번호) */
function officialLine(org: string, kind?: string): string {
  if (kind === 'prosecution' || /검찰|지검/.test(org)) return '검찰 민원 1301 또는 공식 홈페이지의 해당 청 대표번호';
  if (/금융감독원|금감원/.test(org) || kind === 'regulator') return '금융감독원 1332';
  if (/건강보험/.test(org)) return '국민건강보험공단 1577-1000';
  if (kind === 'police' || /경찰/.test(org)) return '경찰 민원은 공식 홈페이지 대표번호 · 긴급 신고 112';
  if (kind === 'finance' || /카드|은행|뱅크|증권|보험/.test(org)) return '카드 뒷면·통장·공식 앱에 적힌 고객센터 번호';
  return '기관 공식 홈페이지에서 찾은 대표번호';
}
