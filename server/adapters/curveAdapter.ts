/**
 * Curve Finance adapter — Ethereum mainnet (simulation only).
 * Curve는 Ethereum 대표 stable DEX로 3pool(DAI-USDC-USDT), stETH-ETH 등 운영.
 * defi_anal.py 분석 기준: 3pool ~2.5%, stETH-ETH ~3.5%, FRAX-USDC ~3.0%.
 * 현재는 dry-run 시뮬레이션만 지원한다.
 */
import type { AdapterExecutionContext, AdapterExecutionResult } from "./types";

function buildTxId(prefix: string, context: AdapterExecutionContext): string {
  return `${prefix}_${context.jobId}_${Date.now()}`;
}

export async function executeCurvePlan(context: AdapterExecutionContext): Promise<AdapterExecutionResult[]> {
  const network = context.productNetwork ?? "Multi";
  const status = "simulated" as const; // Curve live 실행은 추후 구현

  if (network !== "Ethereum") {
    return [];
  }

  // Ethereum Stable: 3pool 35% / Ethereum Blue-chip: stETH-ETH 40%
  // 기본값으로 혼합 배분 사용 (Ethereum Stable 기준)
  const threepoolAmount = Number((context.depositUsd * 0.35).toFixed(2));
  const stethAmount = 0; // Blue-chip 모드는 추후 분기 처리

  return [
    {
      protocol: "Curve",
      chain: "Ethereum",
      action: "3pool (DAI-USDC-USDT) LP",
      allocationUsd: threepoolAmount,
      txId: buildTxId("crv_sim", context),
      status
    },
    ...(stethAmount > 0
      ? [
          {
            protocol: "Curve" as const,
            chain: "Ethereum" as const,
            action: "stETH-ETH LP",
            allocationUsd: stethAmount,
            txId: buildTxId("crv_sim", context),
            status
          }
        ]
      : [])
  ];
}
