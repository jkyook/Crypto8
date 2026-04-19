/**
 * Raydium AMM adapter — Solana chain (simulation only).
 * Raydium는 Solana 대표 AMM으로 SOL-USDC, BOME-SOL 등 고유동성 풀을 보유한다.
 * defi_anal.py 분석 기준: SOL-USDC 연평균 APY ~18%, mSOL-SOL ~7%.
 * 현재는 dry-run 시뮬레이션만 지원한다.
 */
import type { AdapterExecutionContext, AdapterExecutionResult } from "./types";

function buildTxId(prefix: string, context: AdapterExecutionContext): string {
  return `${prefix}_${context.jobId}_${Date.now()}`;
}

export async function executeRaydiumPlan(context: AdapterExecutionContext): Promise<AdapterExecutionResult[]> {
  const network = context.productNetwork ?? "Multi";
  const status = "simulated" as const; // Raydium live 실행은 추후 구현

  let solUsdcAmount: number;

  if (network === "Solana") {
    // Solana Alpha: SOL-USDC에 35% 배정
    solUsdcAmount = Number((context.depositUsd * 0.35).toFixed(2));
  } else {
    // Multi-chain에서 Raydium 비중 없음 (Orca가 Solana 담당)
    solUsdcAmount = 0;
  }

  if (solUsdcAmount <= 0) {
    return [];
  }

  return [
    {
      protocol: "Raydium",
      chain: "Solana",
      action: "SOL-USDC AMM LP",
      allocationUsd: solUsdcAmount,
      txId: buildTxId("ray_sim", context),
      status
    }
  ];
}
