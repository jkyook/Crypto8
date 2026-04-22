/**
 * Aerodrome Finance adapter — Base chain.
 *
 * ■ live 실행: 미지원 (unsupported 반환)
 *   Base 전용 라우팅, pool/gauge 구조 확인, gauge staking 연동 후 활성화 예정.
 *
 * Base Stable:   USDC-USDT Slipstream LP 50%
 * Multi (기본):  USDC-USDT Slipstream LP 20%
 */
import type { AdapterExecutionContext, AdapterExecutionResult } from "./types";
import { buildUnsupportedResult } from "./types";

function buildTxId(prefix: string, context: AdapterExecutionContext): string {
  return `${prefix}_${context.jobId}_${Date.now()}`;
}

export async function executeAerodromePlan(context: AdapterExecutionContext): Promise<AdapterExecutionResult[]> {
  const network = context.productNetwork ?? "Multi";

  let usdcUsdtWeight: number;
  if (network === "Base") {
    usdcUsdtWeight = 0.5;
  } else {
    usdcUsdtWeight = 0.2;
  }

  const usdcUsdtAmount = Number((context.depositUsd * usdcUsdtWeight).toFixed(2));

  if (usdcUsdtAmount <= 0) return [];

  const baseResult = {
    protocol: "Aerodrome" as const,
    chain: "Base" as const,
    action: "USDC-USDT Slipstream LP (0.01%)",
    allocationUsd: usdcUsdtAmount
  };

  // dry-run 모드
  if (context.mode === "dry-run") {
    return [{
      ...baseResult,
      txId: buildTxId("aero_sim", context),
      status: "dry-run" as const
    }];
  }

  // live 모드: 미지원
  return [buildUnsupportedResult(
    baseResult,
    "Aerodrome live execution requires pool/gauge structure verification and gauge staking support (not yet implemented)"
  )];
}
