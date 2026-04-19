# Crypto8 DeFi 경쟁력 개선 로드맵

작성일: 2026-04-18  
대상 프로젝트: `/Users/yugjingwan/PycharmProjects/Crypto8`

## 1. 현재 포지션

Crypto8은 현재 **예치 전략 대시보드 + dry-run 실행 오케스트레이터 MVP**에 가깝다. 시장의 성숙한 DeFi 제품들은 단순 예치/실행을 넘어 리스크 파라미터, 포지션 회계, 자동 리밸런싱, 온체인 상태 추적, 수익률 검증, 운영 중단 장치를 촘촘하게 갖춘다.

Crypto8의 적합한 방향은 Aave, Uniswap, Orca를 직접 대체하는 개별 프로토콜이 아니라, 여러 프로토콜을 연결해 사용자의 자금을 운영·감시·기록하는 **DeFi Yield Operating Console**이다.

## 2. 시장 비교 요약

| 비교 대상 | 핵심 강점 | Crypto8에 반영할 점 |
| --- | --- | --- |
| Aave | Health factor, E-mode, isolation mode, supply/borrow caps | 자산별 한도·청산 위험·담보 안정성 지표 |
| Morpho | Isolated market, LLTV, vault curator, supply cap, allocator | 시장별 노출 한도, curator형 전략 관리, 재배분 로직 |
| Uniswap | Concentrated liquidity, v4 hooks, dynamic pool customization | range in/out, impermanent loss, dynamic slippage, hook risk |
| Beefy/Yearn | Vault, strategy, auto-compounding, share accounting | vault/share 기반 회계, harvest/compound 기록, 전략 버전 관리 |
| Pendle | PT/YT yield tokenization, fixed yield, maturity | 고정수익/변동수익 분리, 만기형 상품, implied APY 비교 |

## 3. 개선 원칙

1. 구조: 단일 대시보드성 UI에서 운영 콘솔 구조로 전환한다.
2. 기능: 예치 기록 중심에서 포지션 회계, 리스크, 실행 상태, 리밸런싱 중심으로 확장한다.
3. 디자인: 사용자에게 “현재 안전한가”, “무엇을 해야 하는가”, “실행이 어디까지 갔는가”를 먼저 보여준다.
4. 추가기능: Aave/Uniswap/Orca별 전문 지표를 붙이고, vault/fixed yield 상품으로 확장한다.
5. 보안: live 실행 전 allowlist, 한도, emergency pause, audit trail, idempotency를 강화한다.
6. 편의성: 실패 시 다음 행동, 데이터 기준 시각, 예상 비용과 순수익을 명확히 표시한다.

## 4. 우선순위별 작업

### P0. 구조·기능·디자인 기반 개선

- 포트폴리오 탭에 운영 관제 패널 추가
- 예치 포지션 기준 risk score, exposure, concentration, APR 품질 신호 계산
- 리밸런싱 추천과 다음 조치 표시
- 실행 화면에 단계형 상태와 추적 키를 더 명확히 표시
- README/API 문서의 RBAC 정책 정합성 유지

### P1. 포지션 회계 모델

현재 `amountUsd` 중심 구조를 아래 필드로 확장한다.

- `principalUsd`
- `currentValueUsd`
- `realizedPnlUsd`
- `unrealizedPnlUsd`
- `feesPaidUsd`
- `netApy`
- `entryPrice`
- `positionShares`
- `protocolPositionId`
- `txHash`
- `chainId`
- `blockNumber`
- `lastSyncedAt`

### P2. 리스크 엔진

단순 `Low/Medium/High/Critical` 외에 정량화된 risk score를 도입한다.

- 프로토콜 TVL
- 풀 유동성
- 24h/7d 거래량
- APY 급변률
- stablecoin depeg 거리
- chain 장애/혼잡도
- smart contract audit 여부
- oracle freshness
- withdrawal liquidity
- single protocol/chain exposure
- max drawdown 추정

권장 출력:

```ts
type RiskAssessment = {
  riskScore: number;
  riskLevel: "Low" | "Medium" | "High" | "Critical";
  riskReasons: string[];
  recommendedAction: string;
};
```

### P3. 실행 상태 추적

실행 이벤트 상태를 다음처럼 세분화한다.

- `planned`
- `approval_required`
- `approved`
- `signing`
- `submitted`
- `confirmed`
- `finalized`
- `partially_failed`
- `reverted`
- `rolled_back`
- `manual_review_required`

live 모드에서는 `txHash`, `nonce`, `gasUsed`, `effectiveGasPrice`, `receiptStatus`, `confirmations`를 저장한다.

### P4. 전략 리밸런싱

목표 비중과 현재 비중의 차이를 계산하고, gas/slippage를 고려해 실행 가치가 있는 리밸런싱만 추천한다.

```ts
type RebalanceRecommendation = {
  from: string;
  to: string;
  amountUsd: number;
  reason: string;
  estimatedGasUsd: number;
  estimatedSlippageUsd: number;
  expectedBenefitUsd30d: number;
};
```

### P5. 프로토콜별 전문 지표

#### Aave

- supply cap / borrow cap utilization
- health factor
- E-mode 가능 여부
- isolation asset 여부
- collateral enabled 여부
- liquidation threshold, LTV, liquidation bonus
- 위험 시 추가 담보·부분 상환·출금 중지 권고

#### Uniswap / Orca

- 현재 가격이 tick range 안/밖인지 표시
- range utilization
- impermanent loss 추정
- fee APR vs price risk 분리
- dynamic slippage
- pool liquidity depth
- volume/TVL ratio
- range out 자동 감지 후 리밸런싱 제안
- Uniswap v4 hook 사용 풀의 hook risk 표시

#### Beefy / Yearn형 Vault

- Crypto8 내부 vault product 모델
- share 기반 입출금 회계
- gross APR / net APY 구분
- performance fee, withdrawal fee 모델
- harvest/compound 기록
- auto-compound simulation
- strategy versioning

#### Pendle형 Fixed Yield

- fixed yield 상품 카테고리
- implied APY vs underlying APY 비교
- maturity date
- principal protection 여부
- YT-like 고위험 yield exposure 경고
- 만기 전/후 exit 시나리오

## 5. 데이터 개선

- DefiLlama, protocol subgraph, on-chain pool state 병렬 조회
- APY source와 confidence 저장
- APR/APY 계산식 명시
- gross yield, incentive yield, fee yield 분리
- 이상치 탐지: 전일 대비 200% 이상 급변 시 재조회
- 데이터 freshness 표시
- 추정치, 실현치, 온체인 확인값 구분
- CSV 대신 DB snapshot 중심으로 전환

## 6. 보안 개선

### P0 보안

- live 모드 실행 전 allowlist protocol/chain/pool 검증
- 서버 실행 지갑 key custody 정책 명확화
- slippage 상한
- max transaction amount
- daily user limit
- emergency pause
- approval TTL
- idempotency key 필수화
- replay 방지
- 감사 로그 불변성 강화

### P1 운영

- 모든 실행에 requestId/correlationId/jobId/txHash 연결
- DB transaction으로 출금/ledger 원자화
- failed execution dead-letter queue
- retry with exponential backoff + jitter
- protocol별 circuit breaker
- health check에 외부 RPC/API 상태 포함
- SQLite에서 Postgres 전환
- backup/restore runbook

## 7. 편의성 개선

- 첫 화면을 총 예치액, 순 APY, 위험 점수, 조치 필요, 최근 실행 상태 중심으로 재구성
- 예치 상품에 위험 대비 수익 표시
- 실행 플로우를 계획 → 승인 → 서명 → 제출 → 확인 → 기록 단계로 표시
- 실패 시 재시도, 취소, 수동 확인, 고객 지원 행동을 명확히 안내
- 포트폴리오 상세에 chain/protocol/pool별 drill-down 추가
- 모든 수익률에 데이터 기준 시각 표시

## 8. 테스트 계획

- RBAC: 세 역할 모두 쓰기 가능, 타인 Job 차단
- 출금 LIFO
- idempotency replay
- Critical risk execution block
- APR fallback
- adapter partial failure
- live mode guard
- API contract
- 주요 UI 플로우

## 9. 실행 로드맵

### Phase 1: 운영 콘솔 기반, 1-2주

- RBAC 문서/테스트 정리
- 출금/ledger DB transaction 처리
- execution state 세분화
- risk score v1 추가
- 포지션 currentValue/PnL 필드 추가
- build/test CI 구성

### Phase 2: DeFi 운영 콘솔화, 2-4주

- Aave health/cap 지표
- Uniswap range/tick/range-out 지표
- APR 다중 소스와 anomaly detector
- 리밸런싱 추천 엔진
- protocol별 circuit breaker
- 실행 이벤트 timeline UI

### Phase 3: Vault/상품화, 4-8주

- share 기반 vault accounting
- auto-compound simulation
- fixed yield/Pendle류 상품 비교 화면
- strategy versioning
- fee model
- user-facing performance report

### Phase 4: 운영/실서비스 준비

- SQLite에서 Postgres 전환
- queue/dead-letter
- monitoring/alerting
- backup/restore
- security audit checklist
- live execution dry-run replay environment

## 10. 1차 적용 범위

이번 1차 적용에서는 다음을 반영한다.

- 이 문서 저장
- 포트폴리오 운영 현황 패널 추가
- risk score v1 계산
- concentration, chain exposure, estimated APY 표시
- 리밸런싱 후보와 다음 조치 표시
- 보안 체크리스트 UI 표시
- 예치·승인·실행 RBAC 문서 정합성 유지
