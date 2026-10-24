// 이어리 실시간 서버: Bun 네이티브 WebSocket 하나로 상태 op을 주고받는다. (§2, §6)
import { join } from 'node:path';
import { createL0 } from '@eary/core';
import { loadPacks, loadYaml } from '@eary/core/src/load';
import { C2SSchema, type S2C } from '@eary/schema';
import { FastLlm, L1Chain } from './fastLlm';
import { JevClient } from './jev';
import { chainFromEnv, GroqChat } from './groqChat';
import { CallRecords } from './records';
import { Cassette } from './cassette';
import { RtzrAuth } from './rtzr';
import { createProviders, WebSearch } from './search';
import { CallSession } from './session';
import { createVerifier, type MockData } from './verify';

const DATA = join(import.meta.dir, '../../../data');
const WEB_DIST = join(import.meta.dir, '../../web/dist');
const PORT = Number(process.env.PORT ?? 8787);

const packs = loadPacks(DATA);
const l0 = createL0(packs.lexicon, Object.values(packs.domains));
const jev = new JevClient(process.env.TYPESAFE_API_KEY);
// L1: Groq qwen → (한도 시) Cerebras. Cerebras 모델명은 키를 받은 뒤 /v1/models로 확인해 CEREBRAS_L1_MODEL에 넣는다
const l1 = new L1Chain([
  new FastLlm({ ...process.env, L1_PROVIDER: 'groq' }),
  new FastLlm({ ...process.env, L1_PROVIDER: 'cerebras' }, { model: process.env.CEREBRAS_L1_MODEL || undefined }),
  // Gemini는 L1에 넣지 않는다: 첫 엔티티 3.5s, 4s 제한 초과 (2026-10-24 실측). 에이전트 체인에만 쓴다
]);
const rtzr = new RtzrAuth(process.env.RTZR_CLIENT_ID, process.env.RTZR_CLIENT_SECRET);
// 보드 에이전트: 무료 등급 한도가 모델별이라 L1(qwen)과 다른 모델을 쓴다 (docs/adr/l1-model.md)
const agentChat = new GroqChat(chainFromEnv(process.env, process.env.AGENT_MODELS ?? 'openai/gpt-oss-120b,openai/gpt-oss-20b', process.env.CEREBRAS_AGENT_MODELS ?? 'gpt-oss-120b', process.env.GEMINI_AGENT_MODELS ?? 'gemini-flash-lite-latest'));
const web = new WebSearch(createProviders(process.env));
// 카세트: 녹화한 외부 응답으로 네트워크 없이 같은 시연 (EARY_CASSETTE=record:이름 | replay:이름)
const cassette = Cassette.fromEnv(process.env.EARY_CASSETTE, join(import.meta.dir, '../../../packages/scenario/cassettes'));
if (cassette) {
  jev.decide = cassette.wrap('jev', (state: unknown, _q: Parameters<typeof jev.decide>[1]) => JSON.stringify((state as { last?: unknown }).last ?? state).slice(0, 200), jev.decide.bind(jev));
  const rawSearch = web.search.bind(web);
  web.search = cassette.wrap('search', (q) => String(q), async (q: string, onPartial?: Parameters<typeof rawSearch>[1]) => {
    const r = await rawSearch(q, undefined, 10_000); // 녹화는 끝까지 기다려 늦은 공급사 결과도 담는다
    onPartial?.(r.merged, 'cassette');
    return r;
  }) as typeof web.search;
  const rawChat = agentChat.chat.bind(agentChat);
  agentChat.chat = cassette.wrap('chat', (msgs) => String((msgs as { content: string | null }[]).at(-1)?.content ?? '').slice(0, 120), rawChat);
  const rawExtract = l1.extract.bind(l1);
  l1.extract = async (ctx, last, onEntity, onRelation, signal) => {
    const run = cassette.wrap('l1', (l: string) => l, async (l: string) => { const ents: unknown[] = []; const r = await rawExtract(ctx, l, (e) => ents.push(e), onRelation, signal); return { r, ents }; });
    const out = await run(last);
    for (const e of (out?.ents ?? []) as Parameters<typeof onEntity>[0][]) onEntity(e);
    return out?.r ?? null;
  };
  console.log(`[eary] 카세트 ${cassette.mode} (${cassette.size}개)`);
}
const records = new CallRecords(process.env.EARY_DB ?? join(DATA, 'eary.db'), Number(process.env.RETENTION_DAYS ?? 7));
const AUDIO_DIR = join(import.meta.dir, '../../../packages/scenario/audio');
const verifier = createVerifier(loadYaml<MockData>(join(DATA, 'mock/lookups.yaml')));

type WsData = { session?: CallSession };

// 세션은 연결과 분리해서 보관한다: 새로고침·끊김에도 통화가 이어진다. 연결이 없으면 10분 뒤 정리
const SESSION_TTL_MS = 10 * 60_000;
const sessions = new Map<string, { s: CallSession; timer?: ReturnType<typeof setTimeout> }>();
const newSession = (send: (m: S2C) => void) => {
  const s = new CallSession({ packs, l0, jev, l1, verifier, rtzr, audioDir: AUDIO_DIR, agentChat, web, records, log: (l) => console.log('[canvas]', l), send });
  sessions.set(s.id, { s });
  return s;
};

const server = Bun.serve<WsData>({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      return srv.upgrade(req, { data: {} }) ? undefined : new Response('upgrade failed', { status: 400 });
    }
    if (url.pathname === '/records') return Response.json(records.list());
    if (url.pathname === '/health') return Response.json({ ok: true, stt: rtzr.enabled, d1: jev.enabled, l1: l1.enabled, sessions: sessions.size });
    // 시연 오디오 (브라우저 재생용 스테레오 WAV)
    const audio = url.pathname.match(/^\/audio\/([\w-]+)\.wav$/);
    if (audio) {
      const f = Bun.file(join(AUDIO_DIR, `${audio[1]}.wav`));
      return (await f.exists()) ? new Response(f, { headers: { 'Content-Type': 'audio/wav' } }) : new Response('not found', { status: 404 });
    }
    // 빌드된 웹앱 (개발 중에는 Vite dev server가 /ws를 프록시)
    const file = Bun.file(join(WEB_DIST, url.pathname === '/' ? 'index.html' : url.pathname));
    if (await file.exists()) return new Response(file);
    const index = Bun.file(join(WEB_DIST, 'index.html'));
    return (await index.exists()) ? new Response(index) : new Response('web 빌드 없음: bun run dev:web 으로 개발 서버를 쓰세요', { status: 404 });
  },
  websocket: {
    open() {
      // 첫 메시지(hello)를 보고 기존 세션에 붙일지 새로 만들지 정한다
    },
    message(ws, raw) {
      if (typeof raw !== 'string') { ws.data.session?.audio(new Uint8Array(raw)); return; } // [1B 채널][PCM16 16kHz]
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { return; }
      const msg = C2SSchema.safeParse(parsed);
      if (!msg.success) {
        ws.send(JSON.stringify({ t: 'error', code: 'bad_message', message: msg.error.issues[0]?.message ?? 'invalid', recoverable: true } satisfies S2C));
        return;
      }
      const send = (m: S2C) => ws.send(JSON.stringify(m));
      if (!ws.data.session) {
        const known = msg.data.t === 'hello' && msg.data.sessionId ? sessions.get(msg.data.sessionId) : undefined;
        if (known) {
          clearTimeout(known.timer);
          known.s.attach(send);
          ws.data.session = known.s;
        } else {
          ws.data.session = newSession(send);
          if (msg.data.t === 'hello') { send(ws.data.session.welcome()); return; }
          send(ws.data.session.welcome());
        }
      }
      ws.data.session.handle(msg.data);
    },
    close(ws) {
      const s = ws.data.session;
      if (!s) return;
      const entry = sessions.get(s.id);
      if (entry) entry.timer = setTimeout(() => { s.dispose(); sessions.delete(s.id); }, SESSION_TTL_MS);
    },
  },
});

console.log(`[eary] http://localhost:${server.port}  STT(RTZR)=${rtzr.enabled ? 'on' : 'off'}  D1(Jev)=${jev.enabled ? 'on' : 'off'}  L1=[${l1.names.join(' → ')}]  agent=[${agentChat.names.join(' → ')}]  search=[${web.enabledNames.join(',')}]`);
