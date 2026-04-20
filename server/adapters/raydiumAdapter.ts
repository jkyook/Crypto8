/**
 * Raydium AMM adapter — Solana chain.
 *
 * ■ live 실행: 미지원 (unsupported 반환)
 *   공식 Raydium SDK, CPMM/CLMM 풀 타입 구분,
 *   add/remove liquidity quote 연동 후 활성화 예정.
 *
 * defi_anal.py 분석 기준: SOL-USDC 연평균 APY ~18%, mSOL-SOL ~7%.
 * Solana Alpha: SOL-USDC AMM LP 35%
 */
import type { AdapterExecutionContext, AdapterExecutionResult } from "./types";
import { buildUnsupportedResult } from "./types";

function buildTxId(prefix: string, context: AdapterExecutionContext): string {
  return `${prefix}_${context.jobId}_${Date.now()}`;
}

export async function executeRaydiumPlan(context: AdapterExecutionContext): Promise<AdapterExecutionResult[]> {
  const network = context.productNetwork ?? "Multi";

  let solUsdcWeight: number;
  if (network === "Solana") {
    solUsdcWeight = 0.35;
  } else {
    solUsdcWeight = 0; // Multi-chain에서 Raydium 비중 없음
  }

  if (solUsdcWeight <= 0) return [];

  const solUsdcAmount = Number((context.depositUsd * solUsdcWeight).toFixed(2));

  const baseResult = {
    protocol: "Raydium" as const,
    chain: "Solana" as const,
    action: "SOL-USDC AMM LP",
    allocationUsd: solUsdcAmount
  };

  // dry-run 모드
  if (context.mode === "dry-run") {
    return [{
      ...baseResult,
      txId: buildTxId("ray_sim", context),
      status: "dry-run" as const
    }];
  }

  // live 모드: 미지원
  return [buildUnsupportedResult(
    baseResult,
    "Raydium live execution requires official SDK with CPMM/CLMM pool type detection (not yet implemented)"
  )];
}
