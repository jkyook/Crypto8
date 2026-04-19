/**
 * Orca Whirlpool adapter — Solana chain.
 * productNetwork에 따라 단일 Solana 전략 또는 Multi-chain 비중으로 분기한다.
 * defi_anal.py 분석 기준 APY: SOL-USDC ~12%, mSOL-SOL ~7%, USDC-USDT ~4.83%
 */
import type { AdapterExecutionContext, AdapterExecutionResult } from "./types";

function buildTxId(prefix: string, context: AdapterExecutionContext): string {
  return `${prefix}_${context.jobId}_${Date.now()}`;
}

export async function executeOrcaPlan(context: AdapterExecutionContext): Promise<AdapterExecutionResult[]> {
  const network = context.productNetwork ?? "Multi";
  const status = context.mode === "live" ? "submitted" : "simulated";
  const txPrefix = context.mode === "live" ? "orca_live" : "orca_sim";

  if (network === "Solana") {
    // Solana Stable: USDC-USDT 60% + mSOL-SOL 40%
    const usdcUsdtAmount = Number((context.depositUsd * 0.6).toFixed(2));
    const msolSolAmount = Number((context.depositUsd * 0.4).toFixed(2));
    return [
      {
        protocol: "Orca",
        chain: "Solana",
        action: "USDC-USDT Whirlpool (0.01%)",
        allocationUsd: usdcUsdtAmount,
        txId: buildTxId(txPrefix, context),
        status
      },
      {
        protocol: "Orca",
        chain: "Solana",
        action: "mSOL-SOL Whirlpool",
        allocationUsd: msolSolAmount,
        txId: buildTxId(txPrefix, context),
        status
      }
    ];
  }

  // Multi-chain: USDC-USDT 20%
  const amount = Number((context.depositUsd * 0.2).toFixed(2));
  return [
    {
      protocol: "Orca",
      chain: "Solana",
      action: "USDC-USDT Whirlpool",
      allocationUsd: amount,
      txId: buildTxId(txPrefix, context),
      status
    }
  ];
}
