/**
 * Curve Finance adapter — Ethereum mainnet (시뮬레이션 전용).
 * (network + subtype) 조합으로 배분 비율을 결정한다.
 *
 * defi_anal.py 분석 기준:
 *   eth-stable    3pool(DAI-USDC-USDT) 35%
 *   eth-bluechip  stETH-ETH 40%
 */
import type { AdapterExecutionContext, AdapterExecutionResult } from "./types";

function buildTxId(prefix: string, context: AdapterExecutionContext): string {
  return `${prefix}_${context.jobId}_${Date.now()}`;
}

type CurveAlloc = { action: string; weight: number };

const CURVE_ALLOC_TABLE: Record<string, CurveAlloc[]> = {
  "Ethereum:eth-stable": [
    { action: "3pool (DAI-USDC-USDT) LP", weight: 0.35 }
  ],
  "Ethereum:eth-bluechip": [
    { action: "stETH-ETH LP", weight: 0.4 }
  ]
};

export async function executeCurvePlan(context: AdapterExecutionContext): Promise<AdapterExecutionResult[]> {
  const network = context.productNetwork ?? "Multi";
  const subtype = context.productSubtype ?? "";
  const status = "simulated" as const;

  if (network !== "Ethereum") return [];

  const tableKey = `${network}:${subtype}`;
  // 테이블에 없는 Ethereum 상품은 기본적으로 3pool 35% 사용
  const allocs: CurveAlloc[] = CURVE_ALLOC_TABLE[tableKey] ?? [
    { action: "3pool (DAI-USDC-USDT) LP", weight: 0.35 }
  ];

  return allocs.map((a) => ({
    protocol: "Curve" as const,
    chain: "Ethereum" as const,
    action: a.action,
    allocationUsd: Number((context.depositUsd * a.weight).toFixed(2)),
    txId: buildTxId("crv_sim", context),
    status
  }));
}
