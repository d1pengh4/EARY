// 동형 리듀서: 서버와 클라이언트가 같은 op을 같은 순서로 적용하면 같은 상태가 된다. (§4, §6)
import type { CallState, Mode, Op } from '@eary/schema';
import { applyBoardPatch } from './board';
import { EMPTY_RISK } from './risk';

export function initialState(callId: string, mode: Mode = 'replay-fixture'): CallState {
  return {
    callId, mode, phase: 'idle', consentNotified: false, domain: 'unknown', domainConfidence: 0,
    situation: { text: '통화를 기다리는 중', rev: 0 },
    utterances: {}, utteranceOrder: [], entities: {}, claims: {}, evidence: {}, signals: {},
    risk: EMPTY_RISK, boards: {}, boardOrder: [], suggestions: [], chat: [], figures: {}, figureOrder: [], nowMs: 0,
  };
}

export function applyOp(s: CallState, op: Op): CallState {
  switch (op.op) {
    case 'call.reset':
      return op.state;
    case 'phase.set':
      return { ...s, phase: op.phase, nowMs: Math.max(s.nowMs, op.atMs) };
    case 'clock':
      return { ...s, nowMs: op.nowMs };
    case 'utt.upsert': {
      const prev = s.utterances[op.u.id];
      if (prev && prev.rev > op.u.rev) return s; // 오래된 rev 거부
      const order = prev ? s.utteranceOrder : [...s.utteranceOrder, op.u.id];
      return { ...s, utterances: { ...s.utterances, [op.u.id]: op.u }, utteranceOrder: order };
    }
    case 'entity.upsert':
      return { ...s, entities: { ...s.entities, [op.e.key]: op.e } };
    case 'entity.remove': {
      const entities = { ...s.entities };
      delete entities[op.key];
      return { ...s, entities };
    }
    case 'claim.upsert':
      return { ...s, claims: { ...s.claims, [op.c.id]: op.c } };
    case 'evidence.upsert':
      return { ...s, evidence: { ...s.evidence, [op.ev.id]: op.ev } };
    case 'signal.upsert':
      return { ...s, signals: { ...s.signals, [op.s.id]: op.s } };
    case 'risk.set':
      return { ...s, risk: op.risk };
    case 'domain.set':
      return { ...s, domain: op.domain, domainConfidence: op.confidence };
    case 'situation.set':
      return op.rev < s.situation.rev ? s : { ...s, situation: { text: op.text, rev: op.rev } };
    case 'board.create':
      if (s.boards[op.board.id]) return s;
      return { ...s, boards: { ...s.boards, [op.board.id]: op.board }, boardOrder: [...s.boardOrder, op.board.id], activeBoardId: op.activate || !s.activeBoardId ? op.board.id : s.activeBoardId };
    case 'board.remove': {
      if (!s.boards[op.boardId]) return s;
      const { [op.boardId]: _gone, ...boards } = s.boards;
      const boardOrder = s.boardOrder.filter((id) => id !== op.boardId);
      return { ...s, boards, boardOrder, activeBoardId: s.activeBoardId === op.boardId ? boardOrder[0] : s.activeBoardId };
    }
    case 'board.patch': {
      const b = s.boards[op.boardId];
      if (!b) return s;
      return { ...s, boards: { ...s.boards, [op.boardId]: applyBoardPatch(b, op.patch, op.atMs) } };
    }
    case 'board.focus':
      return s.boards[op.boardId] ? { ...s, activeBoardId: op.boardId } : s;
    case 'suggestions.set':
      return { ...s, suggestions: op.items };
    case 'figure.upsert': {
      const has = Boolean(s.figures[op.figure.id]);
      return { ...s, figures: { ...s.figures, [op.figure.id]: op.figure }, figureOrder: has ? s.figureOrder : [...s.figureOrder, op.figure.id] };
    }
    case 'review.set':
      return { ...s, review: op.review };
    case 'chat.turn': {
      const i = s.chat.findIndex((t) => t.id === op.turn.id);
      const chat = i < 0 ? [...s.chat, op.turn] : s.chat.map((t, k) => (k === i ? op.turn : t));
      return { ...s, chat };
    }
  }
}

export function applyOps(s: CallState, ops: Op[]): CallState {
  return ops.reduce(applyOp, s);
}
