/**
 * Aave V3 adapter — Arbitrum / Base / Ethereum.
 * (network + subtype) 조합으로 배분 비율을 결정한다.
 *
 * ■ live 실행 조건
 *   EXECUTION_MODE=live
 *   LIVE_EXECUTION_CONFIRM=YES
 *   ENABLE_AAVE_LIVE=true
 *
 * 위 조건이 모두 충족되지 않으면 live 모드 요청 시 status="unsupported" 를 반환한다.
 * 가짜 txId(aave_live_*)를 반환하지 않는다.
 *
 * 배분 테이블 (DEFAULT_PRODUCTS protocolMix 기준):
 *   multi-stable    Arbitrum USDC 45%
 *   multi-balanced  Base USDC 50%
 *   arb-stable      Arbitrum USDC 45%
 *   base-stable     Base USDC 50%
 *   sol-stable      0% (Aave 미사용)
 *   Ethereum        USDC 40%
 */
import type { AdapterExecutionContext, AdapterExecutionResult } from "./types";
import { isAdapterLiveEnabled, buildUnsupportedResult } from "./types";

function buildTxId(prefix: string, context: AdapterExecutionContext): string {
  return `${prefix}_${context.jobId}_${Date.now()}`;
}

type AaveAlloc = {
  chain: "Arbitrum" | "Base" | "Ethereum";
  action: string;
  weight: number;
};

/** (network:subtype) → Aave 배분 테이블 */
const AAVE_ALLOC_TABLE: Record<string, AaveAlloc[]> = {
  "Multi:multi-stable": [
    { chain: "Arbitrum", action: "USDC Supply (eMode)", weight: 0.45 }
  ],
  "Multi:multi-balanced": [
    { chain: "Base", action: "USDC Supply (eMode)", weight: 0.5 }
  ],
  "Arbitrum:arb-stable": [
    { chain: "Arbitrum", action: "USDC Supply (eMode)", weight: 0.45 }
  ],
  "Base:base-stable": [
    { chain: "Base", action: "USDC Supply (eMode)", weight: 0.5 }
  ],
  "Solana:sol-stable": [],
  "Ethereum:eth-stable": [
    { chain: "Ethereum", action: "USDC Supply", weight: 0.4 }
  ],
  "Ethereum:eth-bluechip": [
    { chain: "Ethereum", action: "WETH Supply", weight: 0.3 }
  ]
};

/** 테이블에 없을 때 사용하는 Multi fallback */
const MULTI_FALLBACK: AaveAlloc[] = [
  { chain: "Arbitrum", action: "USDC Supply", weight: 0.2 },
  { chain: "Base", action: "USDC Supply", weight: 0.15 }
];

export async function executeAavePlan(context: AdapterExecutionContext): Promise<AdapterExecutionResult[]> {
  const network = context.productNetwork ?? "Multi";
  const subtype = context.productSubtype ?? "";

  const tableKey = `${network}:${subtype}`;
  const allocs = AAVE_ALLOC_TABLE[tableKey] ?? MULTI_FALLBACK;

  if (allocs.length === 0) return [];

  // dry-run 모드: 시뮬레이션 결과 반환
  if (context.mode === "dry-run") {
    return allocs.map((a) => ({
      protocol: "Aave" as const,
      chain: a.chain,
      action: a.action,
      allocationUsd: Number((context.depositUsd * a.weight).toFixed(2)),
      txId: buildTxId("aave_sim", context),
      status: "dry-run" as const
    }));
  }

  // live 모드: feature flag 확인
  if (!isAdapterLiveEnabled("Aave")) {
    return allocs.map((a) => buildUnsupportedResult(
      {
        protocol: "Aave",
        chain: a.chain,
        action: a.action,
        allocationUsd: Number((context.depositUsd * a.weight).toFixed(2))
      },
      "Aave live execution requires ENABLE_AAVE_LIVE=true and LIVE_EXECUTION_CONFIRM=YES"
    ));
  }

  // 이 어댑터는 Job 실행 디스패처용 시뮬레이션 레이어입니다.
  // 실제 Aave V3 온체인 실행은 /api/aave/usdc/supply-tx → /api/aave/usdc/confirm 흐름을 사용하세요.
  return allocs.map((a) => buildUnsupportedResult(
    {
      protocol: "Aave",
      chain: a.chain,
      action: a.action,
      allocationUsd: Number((context.depositUsd * a.weight).toFixed(2))
    },
    "Aave live execution adapter is not yet implemented. Use /api/aave/supply endpoint directly."
  ));
}
