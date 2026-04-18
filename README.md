# Crypto8 Yield Orchestrator MVP

지갑 연결 + 예치 계획 + 총괄 에이전트 제어판을 포함한 React MVP입니다.

## 실행

```bash
npm install
cp .env.example .env
npm run prisma:generate
npm run prisma:seed
npm run dev:api
npm run dev:web
```

## Prisma 마이그레이션

```bash
# 클라이언트 생성
npm run prisma:generate

# 개발 마이그레이션 실행
npm run prisma:migrate -- --name your_change_name

# DB 브라우저
npm run prisma:studio

# 기본 계정 시드
npm run prisma:seed
```

- 기준 스키마: `prisma/schema.prisma`
- 기준 마이그레이션: `prisma/migrations/0001_init/migration.sql`
- 현재 DB: `server/data/crypto8.db` (`DATABASE_URL="file:../server/data/crypto8.db"`)

## 환경변수

- `VITE_PHANTOM_APP_ID`: Phantom Portal에서 발급받은 App ID
  - 없으면 `injected` provider만 활성화됩니다.
- `VITE_API_BASE_URL`: 오케스트레이터 API 주소
- `JWT_SECRET`: 서버 JWT 서명 키 (운영환경에서 반드시 변경)
- `EXECUTION_MODE`: `dry-run`(기본) 또는 `live`
- `LIVE_EXECUTION_CONFIRM`: live 모드 활성화 시 `YES` 필요
- `ARBITRUM_RPC_URL`: Uniswap live 경로용 Arbitrum RPC URL
- `ARBITRUM_EXECUTOR_PRIVATE_KEY`: Uniswap live 경로용 실행 지갑 키
- `UNISWAP_SLIPPAGE_BPS`: Uniswap mint 최소수량 계산용 슬리피지 bps (기본 50 = 0.5%)
- `UNISWAP_USDC_USDT_FEE_TIER`: USDC-USDT 풀 fee tier (기본 100 = 0.01%)
- `UNISWAP_USDC_USDT_POOL_ADDRESS`: USDC-USDT 풀 주소 (Arbitrum)
- `UNISWAP_POOL_MIN_LIQUIDITY`: live 실행 전 풀 최소 유동성 기준
- `UNISWAP_FULL_RANGE_TICK_LOWER` / `UNISWAP_FULL_RANGE_TICK_UPPER`: V3 틱 범위
- `UNISWAP_DEADLINE_SEC`: mint 트랜잭션 deadline 초 (기본 1200초)
- `EXECUTION_RETRY_COUNT`: 실행 어댑터 실패 시 재시도 횟수 (기본 3)

## MVP 실행 범위·체인·지갑 정책

### 지갑(UI)

- Phantom 기준 **Solana** 주소로 연결·해제 및 잔고(SOL/USDC) 조회.
- 예치 실행 패널의 **메시지 서명(`signMessage`)**은 해당 Job에 대한 **실행 의사 확인**용이며, 브라우저 지갑이 Arbitrum 등 EVM에서 Aave/Uniswap 예치 트랜잭션을 **직접 전송하지는 않습니다**.

### 서버 실행

- `EXECUTION_MODE=dry-run`(기본): 어댑터가 시뮬레이션 중심으로 동작합니다.
- `EXECUTION_MODE=live`이고 `LIVE_EXECUTION_CONFIRM=YES`일 때만 라이브 의미의 온체인 호출이 켜집니다(어댑터·실행 지갑·RPC 등 환경 필요).
- 프로토콜별 호출은 `server/executionAdapter.ts`가 Aave·Uniswap·Orca 어댑터를 묶는 구조입니다.
- 공개 엔드포인트 `GET /api/runtime/info`로 현재 표시용 실행 모드(dry-run/live)를 조회할 수 있습니다.
- 공개 `GET /api/health`로 DB 연결·실효 실행 모드·버전·가동 시간을 점검할 수 있습니다. 엔드포인트·멱등 키 요약은 `agents/API-OVERVIEW.md`를 참고하세요.

### 예치·실행 API(RBAC)

- `GET /api/portfolio/positions`: `orchestrator`, `security`, `viewer` (본인 `username` 기준)
- `GET /api/portfolio/withdrawals`: `orchestrator`, `security`, `viewer` — 서버에 기록된 출금 장부(본인 기준, `id`·`amountUsd`·`createdAt`)
- `POST /api/portfolio/positions`: `orchestrator`, `security`, `viewer` — 본인 계정 기준 예치 포지션 생성
- `POST /api/portfolio/withdraw`: `orchestrator`, `security`, `viewer` — LIFO로 본인 예치를 차감하고, 실제 차감된 USD 합계를 `withdrawnUsd`로 응답합니다. `withdrawnUsd`가 0보다 크면 `withdrawal_ledger`에 한 줄이 추가됩니다.
- `POST /api/orchestrator/jobs`: `orchestrator`, `security`, `viewer` — 본인 계정 기준 실행 Job 생성
- `POST /api/security/approve`: `orchestrator`, `security`, `viewer` — `security`는 전체 Job, 그 외 역할은 본인 Job 승인
- `POST /api/orchestrator/execute/:jobId`: `orchestrator`, `security`, `viewer` — `security`는 전체 Job, 그 외 역할은 본인 Job 실행
- 단일 요청 한도: 예치/인출 금액 `amountUsd` ≤ 1억 USD(코드 상한), `protocolMix` 최대 24행, 상품명·풀 라벨 길이 제한

## 포함 기능

- Phantom 지갑 연결/해제
- Option L2* 기반 예치 비중 자동 계산
- 예상 연 수익(USD) 계산
- 총괄 에이전트 리스크 레벨 산정
- 역할별 에이전트 작업(P0~P3) 자동 생성
- API 기반 실행 흐름: 작업 생성 -> 보안 승인 -> 실행
- 실행 감사 이벤트 로그 API: `/api/orchestrator/execution-events`
- 실행 멱등성: 같은 Job 재실행 시 `already executed - idempotent skip`
- 같은 `Idempotency-Key` 재요청 시 기존 결과 재응답(idempotent replay)
- 실행 어댑터 1차 구조: Aave/Uniswap/Orca 프로토콜별 분리
- Uniswap(Arbitrum) 어댑터는 live 모드에서 USDC approve 트랜잭션 전송 지원
- USDC/USDT 가격은 DefiLlama 우선, 실패 시 CoinGecko, 최종 1:1 fallback
- live 모드에서는 mint 전 `slot0/liquidity` 검사 후 임계치 미달 시 실행 차단
- auth/execute 엔드포인트 rate limit 기본 적용
- 실행 실패 시 지수형 백오프(단순) 재시도 후 실패 이벤트 기록
- 보안 승인 로그 조회 API (`/api/security/approvals`)
- JWT + RBAC 기반 권한 분리
  - orchestrator/security/viewer: 예치 포지션 생성·인출·Job 생성·승인·실행 쓰기 API 사용 가능
  - security: 운영 검토 목적의 전체 Job/실행 이벤트 조회 가능
  - orchestrator/viewer: 본인 `username` 기준 Job/포지션/실행 이벤트로 격리
- SQLite DB(`server/data/crypto8.db`) 기반 영속 저장
- 사용자/작업/승인/리프레시 세션을 SQLite 테이블로 관리
- bcrypt 해시 검증 + Refresh Token 수명주기 지원 (`/api/auth/refresh`, `/api/auth/logout`)

## 기본 계정 (개발용)

- `orchestrator_admin / orchestrator123`
- `security_admin / security123`
- `viewer_admin / viewer123`

## UI/UX 운영 원칙 (고정)

- 텍스트 최소화: 설명 문구/중복 제목을 줄이고 핵심 정보만 노출
- 행동 우선: 핵심 CTA(입금/인출)는 크게, 시선이 가는 위치에 배치
- 블록체인 실행 원칙: UI는 Phantom(Solana) 연결·서명으로 의사를 남기고, 실제 프로토콜 전송은 서버 `EXECUTION_MODE`에 따름(README «MVP 실행 범위» 참고)
- 정보 계층화: 메인 메뉴는 간결하게 유지하고 부가/관리 기능은 `More`로 수납
- 일관된 상단 구조: 좌측 `Crypto8` + Yield Console 부제, 중앙 **예치·실행·포트폴리오·운영** 4축 메뉴, 우측 지갑/도구를 한 줄 유지
- 지갑 상호작용: 기본은 컴팩트, 클릭 시 아래로 자연스럽게 확장(화면 점프 금지)
- 레이어 규칙: 드롭다운/모달/본문의 z-index 우선순위를 명확히 유지
- 팝업 시야 규칙: 실행 팝업은 상단에 붙이지 않고 본문 시야(중단~하단 시작점)에서 바로 인지되게 배치
- 균형 레이아웃: 상품 영역과 액션 영역 간 충분한 간격을 두고 비대칭 배치 지양
- 데이터 기준 표기: 예치 관련 합산 값은 USD 기준으로 명확히 표시

## 최근 지시의 공통 방향성 (추상 요약)

- 사용자 인지 부하를 낮추고 핵심 의사결정 정보만 전면에 배치한다.
- 화면 구조는 일관된 내비게이션 계층을 유지해 사용자가 현재 맥락을 잃지 않게 한다.
- 실행 UX는 단계를 단순화하되, 블록체인 실행의 신뢰성(지갑 연동/승인)은 절대 약화하지 않는다.
- 데이터 표시는 숫자 중심 KPI와 실행 단위 상세를 함께 제공해 요약-상세 탐색이 자연스럽게 이어지게 한다.
- 외부 데이터(이율/뉴스)는 단일 실패 지점 없이 동작하도록 복원력 있는 수집 구조를 유지한다.

## 다음 구현 권장

- 브라우저 지갑에서 직접 보내는 온체인 예치 플로우(체인별 지갑 통합 또는 전용 커스터디)
- 서버측 전략 실행 오케스트레이터(API + Queue)
- 시세/APY 실시간 데이터 소스 연동
- 감사 로그/승인 로그 저장
- DB/Redis 기반 영속 큐 전환 (현재 인메모리)
