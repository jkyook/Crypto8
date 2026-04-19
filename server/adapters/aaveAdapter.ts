/**
 * Aave V3 adapter — Arbitrum / Base / Ethereum.
 * (network + subtype) 조합으로 배분 비율을 결정한다.
 *
 * 배분 테이블 (DEFAULT_PRODUCTS protocolMix 기준):
 *   multi-stable    Arbitrum USDC 45%
 *   multi-balanced  Base USDC 50%
 *   arb-stable      Arbitrum USDC 45%
 *   base-stable     Base USDC 50%
 *   sol-stable      0% (Aave 미사용)
 *   Ethereum        USDC 40% (향후 Ethereum 상품 추가 시)
 */
import type { AdapterExecutionContext, AdapterExecutionResult } from "./types";

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
  // Ethereum Blue-chip — WETH 공급. defi_anal.py 기준: WETH supply ~1.8%
  "Ethereum:eth-bluechip": [
    { chain: "Ethereum", action: "WETH Supply", weight: 0.3 }
  ]
};

/** 테이블에 없을 때 사용하는 기존 Multi fallback */
const MULTI_FALLBACK: AaveAlloc[] = [
  { chain: "Arbitrum", action: "USDC Supply", weight: 0.2 },
  { chain: "Base", action: "USDC Supply", weight: 0.15 }
];

export async function executeAavePlan(context: AdapterExecutionContext): Promise<AdapterExecutionResult[]> {
  const network = context.productNetwork ?? "Multi";
  const subtype = context.productSubtype ?? "";
  const status = context.mode === "live" ? "submitted" : "simulated";
  const txPrefix = context.mode === "live" ? "aave_live" : "aave_sim";

  const tableKey = `${network}:${subtype}`;
  const allocs = AAVE_ALLOC_TABLE[tableKey] ?? MULTI_FALLBACK;

  return allocs.map((a) => ({
    protocol: "Aave" as const,
    chain: a.chain,
    action: a.action,
    allocationUsd: Number((context.depositUsd * a.weight).toFixed(2)),
    txId: buildTxId(txPrefix, context),
    status
  }));
}
