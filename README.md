# 이어리 EARY

통화를 함께 듣고, 판단을 돕는 AI. 설계는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## 실행
```bash
bun install
cp .env.example .env            # TYPESAFE_API_KEY 등 채우기 (없으면 해당 계층은 자동으로 꺼짐)
bun run dev:server              # :8787  (WebSocket /ws, 빌드된 웹 제공)
bun run dev:web                 # :5173  (개발용, /ws는 8787로 프록시)
```
- 화면에서 **시연 시작 · 사칭 의심 전화** / **대조군 · 요금 상담** / **자유 입력**
- `⌘⇧D` 개발 패널: 재생 속도, 문장 직접 주입, 지연 측정(p50/p95), 공급사 상태

## 확인
```bash
bun test                                      # core 단위 + 시나리오 골든 (결정론, 키 불필요)
bun apps/server/test/live-jev.ts impersonation-01   # 실제 Jev로 단계 전이·지연 확인
bun apps/server/test/ws-e2e.ts impersonation-01 4                # 실행 중인 서버에 WS로 붙어 4배속 종단 확인 (텍스트 재생)
bun apps/server/test/ws-e2e.ts impersonation-01 1 replay-audio   # 진짜 RTZR 거치는 시연 (57초)
bun apps/server/test/ws-live.ts <16kHz mono wav>                 # 브라우저 live 프레임 흉내
bun packages/scenario/make-audio.ts impersonation-01             # 대본 → TTS 시연 오디오 다시 만들기 (macOS)
bun apps/server/test/ws-type.ts                                  # 대본 밖 자유 입력 확인
BENCH_GAP_MS=6500 bun apps/server/test/l1-bench.ts               # L1 모델 벤치 (docs/adr/l1-model.md)
bun --env-file=.env apps/server/test/search-probe.ts "검색어"      # 다중 검색 공급사별 지연·결과 확인
GAP=4000 TAIL=15000 bun apps/server/test/ws-type.ts               # 자유 입력 + 분석 보드 결과 출력
```

## 현재 상태
전체 목록과 진행 상황은 [docs/BACKLOG.md](docs/BACKLOG.md), 문서와 다른 점은 [ARCHITECTURE §20](docs/ARCHITECTURE.md).

- 실시간: RTZR STT → L0 규칙 → Jev 판정 → L1(Groq qwen) → 위험 엔진 → 사건 지도·요금 비교 보드
- 검색·분석: 다중 검색 + 보드 에이전트(Groq → Gemini) → 분석 로그 · 공식 근거 탭 · AI에게 요청
- 통화 후: 리뷰 · 전체 기록 · 신고 준비안 · 일정(.ics) · 기록 저장(SQLite)
- 실행 모드: 시연(진짜 STT 거치는 대본 오디오) · 텍스트 재생 · PC 통화(마이크+탭) · 스피커폰(마이크 하나, 목소리 등록) · 자유 입력
- 카세트: `EARY_CASSETTE=record:demo` 로 녹화, `EARY_CASSETTE=replay:demo` 로 네트워크 없이 재생
