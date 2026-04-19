/**
 * Orca Whirlpool adapter — Solana chain.
 * (network + subtype) 조합으로 배분 비율을 결정한다.
 *
 *   multi-stable    USDC-USDT Whirlpool 20%
 *   multi-balanced  mSOL-SOL Whirlpool 20%
 *   arb-stable      0%
 *   base-stable     0%
 *   sol-stable      USDC-USDT 40% + SOL-USDC 35% + mSOL-SOL 25%
 */
import type { AdapterExecutionContext, AdapterExecutionResult } from "./types";

function buildTxId(prefix: string, context: AdapterExecutionContext): string {
  return `${prefix}_${context.jobId}_${Date.now()}`;
}

type OrcaAlloc = { action: string; weight: number };

const ORCA_ALLOC_TABLE: Record<string, OrcaAlloc[]> = {
  "Multi:multi-stable": [
    { action: "USDC-USDT Whirlpool (0.01%)", weight: 0.2 }
  ],
  "Multi:multi-balanced": [
    { action: "mSOL-SOL Whirlpool", weight: 0.2 }
  ],
  "Arbitrum:arb-stable": [],
  "Base:base-stable": [],
  "Solana:sol-stable": [
    { action: "USDC-USDT Whirlpool (0.01%)", weight: 0.4 },
    { action: "SOL-USDC Whirlpool", weight: 0.35 },
    { action: "mSOL-SOL Whirlpool", weight: 0.25 }
  ]
};

const ORCA_MULTI_FALLBACK: OrcaAlloc[] = [
  { action: "USDC-USDT Whirlpool", weight: 0.2 }
];

export async function executeOrcaPlan(context: AdapterExecutionContext): Promise<AdapterExecutionResult[]> {
  const network = context.productNetwork ?? "Multi";
  const subtype = context.productSubtype ?? "";
  const status = context.mode === "live" ? "submitted" : "simulated";
  const txPrefix = context.mode === "live" ? "orca_live" : "orca_sim";

  const tableKey = `${network}:${subtype}`;
  const allocs = ORCA_ALLOC_TABLE[tableKey] ?? ORCA_MULTI_FALLBACK;

  if (allocs.length === 0) return [];

  return allocs.map((a) => ({
    protocol: "Orca" as const,
    chain: "Solana" as const,
    action: a.action,
    allocationUsd: Number((context.depositUsd * a.weight).toFixed(2)),
    txId: buildTxId(txPrefix, context),
    status
  }));
}
