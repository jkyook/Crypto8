/**
 * Aerodrome Finance adapter — Base chain (simulation only).
 * Aerodrome는 Base 체인의 대표 DEX로, Uniswap V3 기반 CLMM(Slipstream) 풀을 운영한다.
 * 현재는 dry-run 시뮬레이션만 지원하며, live 모드도 simulated 상태로 반환한다.
 */
import type { AdapterExecutionContext, AdapterExecutionResult } from "./types";

function buildTxId(prefix: string, context: AdapterExecutionContext): string {
  return `${prefix}_${context.jobId}_${Date.now()}`;
}

export async function executeAerodromePlan(context: AdapterExecutionContext): Promise<AdapterExecutionResult[]> {
  const network = context.productNetwork ?? "Multi";
  const status = "simulated" as const; // Aerodrome live 실행은 추후 구현

  // Base-only 상품 vs Multi-chain 상품 배분 비율 분기
  let usdcUsdtAmount: number;
  let ethUsdcAmount: number;

  if (network === "Base") {
    // Base Stable: 50% USDC-USDT / Base Yield: 25% USDC-USDT
    usdcUsdtAmount = Number((context.depositUsd * 0.5).toFixed(2));
    ethUsdcAmount = 0;
  } else {
    // Multi-chain 포트폴리오에서 Aerodrome Base 비중 (20%)
    usdcUsdtAmount = Number((context.depositUsd * 0.2).toFixed(2));
    ethUsdcAmount = 0;
  }

  const results: AdapterExecutionResult[] = [
    {
      protocol: "Aerodrome",
      chain: "Base",
      action: "USDC-USDT Slipstream LP (0.01%)",
      allocationUsd: usdcUsdtAmount,
      txId: buildTxId("aero_sim", context),
      status
    }
  ];

  if (ethUsdcAmount > 0) {
    results.push({
      protocol: "Aerodrome",
      chain: "Base",
      action: "WETH-USDC Slipstream LP (0.05%)",
      allocationUsd: ethUsdcAmount,
      txId: buildTxId("aero_sim", context),
      status
    });
  }

  return results;
}
