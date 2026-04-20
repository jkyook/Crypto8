/**
 * Orca Whirlpool adapter — Solana chain.
 * (network + subtype) 조합으로 배분 비율을 결정한다.
 *
 * ■ live 실행: 미지원 (ENABLE_ORCA_LIVE 플래그 있어도 unsupported 반환)
 *   공식 Whirlpools SDK 연동 후 활성화 예정.
 *
 *   multi-stable    USDC-USDT Whirlpool 20%
 *   multi-balanced  mSOL-SOL Whirlpool 20%
 *   arb-stable      0%
 *   base-stable     0%
 *   sol-stable      USDC-USDT 40% + SOL-USDC 35% + mSOL-SOL 25%
 */
import type { AdapterExecutionContext, AdapterExecutionResult } from "./types";
import { buildUnsupportedResult } from "./types";

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

  const tableKey = `${network}:${subtype}`;
  const allocs = ORCA_ALLOC_TABLE[tableKey] ?? ORCA_MULTI_FALLBACK;

  if (allocs.length === 0) return [];

  // dry-run 모드
  if (context.mode === "dry-run") {
    return allocs.map((a) => ({
      protocol: "Orca" as const,
      chain: "Solana" as const,
      action: a.action,
      allocationUsd: Number((context.depositUsd * a.weight).toFixed(2)),
      txId: buildTxId("orca_sim", context),
      status: "dry-run" as const
    }));
  }

  // live 모드: Orca live 실행 미지원 (공식 Whirlpools SDK 연동 필요)
  return allocs.map((a) => buildUnsupportedResult(
    {
      protocol: "Orca",
      chain: "Solana",
      action: a.action,
      allocationUsd: Number((context.depositUsd * a.weight).toFixed(2))
    },
    "Orca Whirlpools live execution requires official SDK integration (not yet implemented)"
  ));
}
