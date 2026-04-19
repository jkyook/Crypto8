/**
 * Aave V3 adapter — Arbitrum / Base / Ethereum 지원.
 * productNetwork에 따라 단일 체인 또는 멀티체인으로 분기한다.
 * defi_anal.py 분석 기준 APY: Arbitrum USDC ~3.36%, Base USDC ~4.26%, ETH mainnet USDC ~3.0%
 */
import type { AdapterExecutionContext, AdapterExecutionResult } from "./types";

function buildTxId(prefix: string, context: AdapterExecutionContext): string {
  return `${prefix}_${context.jobId}_${Date.now()}`;
}

export async function executeAavePlan(context: AdapterExecutionContext): Promise<AdapterExecutionResult[]> {
  const network = context.productNetwork ?? "Multi";
  const status = context.mode === "live" ? "submitted" : "simulated";
  const txPrefix = context.mode === "live" ? "aave_live" : "aave_sim";

  if (network === "Arbitrum") {
    // Arbitrum 전용: USDC 50%, WETH 0% (Stable 기준; Growth 상품은 35%)
    const usdcAmount = Number((context.depositUsd * 0.5).toFixed(2));
    return [
      {
        protocol: "Aave",
        chain: "Arbitrum",
        action: "USDC Supply (eMode)",
        allocationUsd: usdcAmount,
        txId: buildTxId(txPrefix, context),
        status
      }
    ];
  }

  if (network === "Base") {
    // Base 전용: USDC 50%, WETH 0% (Stable 기준; Yield 상품은 35%)
    const usdcAmount = Number((context.depositUsd * 0.5).toFixed(2));
    return [
      {
        protocol: "Aave",
        chain: "Base",
        action: "USDC Supply (eMode)",
        allocationUsd: usdcAmount,
        txId: buildTxId(txPrefix, context),
        status
      }
    ];
  }

  if (network === "Ethereum") {
    // Ethereum 전용: USDC 40%
    const usdcAmount = Number((context.depositUsd * 0.4).toFixed(2));
    return [
      {
        protocol: "Aave",
        chain: "Ethereum",
        action: "USDC Supply",
        allocationUsd: usdcAmount,
        txId: buildTxId(txPrefix, context),
        status
      }
    ];
  }

  // Multi-chain (기본): Arbitrum 20% + Base 15%
  const arbAmount = Number((context.depositUsd * 0.2).toFixed(2));
  const baseAmount = Number((context.depositUsd * 0.15).toFixed(2));
  return [
    {
      protocol: "Aave",
      chain: "Arbitrum",
      action: "USDC Supply",
      allocationUsd: arbAmount,
      txId: buildTxId(txPrefix, context),
      status
    },
    {
      protocol: "Aave",
      chain: "Base",
      action: "USDC Supply",
      allocationUsd: baseAmount,
      txId: buildTxId(txPrefix, context),
      status
    }
  ];
}
