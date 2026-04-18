# Crypto8 API 개요 (P0/P1)

인증이 필요한 엔드포인트는 `Authorization: Bearer <access_token>` 을 사용합니다. 운영 로그 추적을 위해 응답 헤더 `X-Request-Id`가 설정됩니다(요청에 `X-Request-Id`를 넣으면 그 값을 유지).

## 공개

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/health` | `ok`, `version`, `database`(Prisma ping), `executionMode`, `uptimeSec` |
| GET | `/api/runtime/info` | UI용 실행 모드·라이브 확인 여부·정책 문구 |
| GET | `/api/market/rates` | APR 스냅샷(외부 소스) |

## 인증·RBAC

| 메서드 | 경로 | 역할 |
|--------|------|------|
| POST | `/api/auth/login` | 공개 |
| POST | `/api/auth/refresh` | 공개 |
| POST | `/api/auth/logout` | 공개 |
| GET | `/api/portfolio/positions` | orchestrator, security, viewer |
| GET | `/api/portfolio/withdrawals` | orchestrator, security, viewer |
| POST | `/api/portfolio/positions` | orchestrator |
| POST | `/api/portfolio/withdraw` | orchestrator |
| POST | `/api/orchestrator/jobs` | orchestrator |
| GET | `/api/orchestrator/jobs` | orchestrator, security, viewer |
| GET | `/api/orchestrator/jobs/:jobId` | orchestrator, security, viewer |
| POST | `/api/orchestrator/execute/:jobId` | orchestrator |
| GET | `/api/orchestrator/execution-events?jobId=` | orchestrator, security, viewer |
| POST | `/api/security/approve` | security |

## 실행 멱등·상관

- `POST /api/orchestrator/execute/:jobId`  
  - 헤더 `Idempotency-Key`: 동일 `(jobId, key)` 재요청 시 기록 재생.  
  - JSON 본문(선택): `{ "correlationId": "uuid", "positionId": "pos_..." }` 또는 헤더 `X-Correlation-Id`.  
  - 성공 응답에 `payload` 포함: 어댑터별 `adapterResults`, `mode`, `retries`, 상관 필드 등(v1 스키마).

## 로깅

- 서버는 각 HTTP 요청 종료 시 JSON 한 줄을 `stdout`에 남깁니다(`requestId`, `method`, `path`, `status`, `ms`).
