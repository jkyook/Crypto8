-- Migration: 0013_position_accounting
-- 포지션 회계 필드 추가 (P1)
-- principalUsd, currentValueUsd, unrealizedPnlUsd, realizedPnlUsd,
-- feesPaidUsd, netApy, entryPrice, expectedApr, protocolPositionId

ALTER TABLE "positions" ADD COLUMN "principal_usd"        REAL;
ALTER TABLE "positions" ADD COLUMN "current_value_usd"    REAL;
ALTER TABLE "positions" ADD COLUMN "unrealized_pnl_usd"   REAL;
ALTER TABLE "positions" ADD COLUMN "realized_pnl_usd"     REAL;
ALTER TABLE "positions" ADD COLUMN "fees_paid_usd"        REAL;
ALTER TABLE "positions" ADD COLUMN "net_apy"              REAL;
ALTER TABLE "positions" ADD COLUMN "entry_price"          REAL;
ALTER TABLE "positions" ADD COLUMN "expected_apr"         REAL;
ALTER TABLE "positions" ADD COLUMN "protocol_position_id" TEXT;

-- 기존 active 포지션의 principal_usd를 amount_usd로 초기화 (cost basis 추정)
UPDATE "positions"
SET "principal_usd" = "amount_usd"
WHERE "principal_usd" IS NULL;
