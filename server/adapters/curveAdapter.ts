/**
 * Curve Finance adapter — Ethereum mainnet.
 *
 * ■ live 실행: 미지원 (unsupported 반환)
 *   pool별 ABI/시그니처 관리, wrapped/underlying 차이 처리,
 *   min mint amount/slippage 적용 후 활성화 예정.
 *
 * defi_anal.py 분석 기준:
 *   eth-stable    3pool(DAI-USDC-USDT) 35%
 *   eth-bluechip  stETH-ETH 40%
 */
import type { AdapterExecutionContext, AdapterExecutionResult } from "./types";
import { buildUnsupportedResult } from "./types";

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

  if (network !== "Ethereum") return [];

  const tableKey = `${network}:${subtype}`;
  const allocs: CurveAlloc[] = CURVE_ALLOC_TABLE[tableKey] ?? [
    { action: "3pool (DAI-USDC-USDT) LP", weight: 0.35 }
  ];

  if (allocs.length === 0) return [];

  // dry-run 모드
  if (context.mode === "dry-run") {
    return allocs.map((a) => ({
      protocol: "Curve" as const,
      chain: "Ethereum" as const,
      action: a.action,
      allocationUsd: Number((context.depositUsd * a.weight).toFixed(2)),
      txId: buildTxId("crv_sim", context),
      status: "dry-run" as const
    }));
  }

  // live 모드: 미지원
  return allocs.map((a) => buildUnsupportedResult(
    {
      protocol: "Curve",
      chain: "Ethereum",
      action: a.action,
      allocationUsd: Number((context.depositUsd * a.weight).toFixed(2))
    },
    "Curve live execution requires pool ABI management and min_mint_amount/slippage enforcement (not yet implemented)"
  ));
}
