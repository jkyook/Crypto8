/**
 * 서버 `executionAdapter` 분배 비율과 동일한 **시뮬 견적 행**(UI 미리보기용).
 * (approve 행 등 allocationUsd 0은 제외)
 *
 * productNetwork + productSubtype 조합으로 서버 어댑터의 weight table과 동기화.
 * DEFAULT_PRODUCTS의 protocolMix 변경 시 이 파일도 함께 수정해야 함.
 */

import type { ProductNetwork, ProductSubtype } from "./api";

export type ExecutionPreviewRow = {
  protocol: string;
  chain: string;
  action: string;
  allocationUsd: number;
};

type PreviewAlloc = {
  protocol: string;
  chain: string;
  action: string;
  weight: number;
};

/**
 * (network:subtype) → 미리보기 행 배분 테이블.
 * server/adapters/ 각 어댑터의 weight table과 반드시 일치해야 한다.
 */
const PREVIEW_ALLOC_TABLE: Record<string, PreviewAlloc[]> = {
  "Multi:multi-stable": [
    { protocol: "Aave",    chain: "Arbitrum", action: "USDC Supply (eMode)",            weight: 0.45 },
    { protocol: "Uniswap", chain: "Arbitrum", action: "USDC-USDT LP (0.01%)",           weight: 0.35 },
    { protocol: "Orca",    chain: "Solana",   action: "USDC-USDT Whirlpool (0.01%)",    weight: 0.20 }
  ],
  "Multi:multi-balanced": [
    { protocol: "Aave",    chain: "Base",     action: "USDC Supply (eMode)",            weight: 0.50 },
    { protocol: "Uniswap", chain: "Arbitrum", action: "ETH-USDC LP (0.05%, ±50%)",     weight: 0.30 },
    { protocol: "Orca",    chain: "Solana",   action: "mSOL-SOL Whirlpool",            weight: 0.20 }
  ],
  "Arbitrum:arb-stable": [
    { protocol: "Aave",    chain: "Arbitrum", action: "USDC Supply (eMode)",            weight: 0.45 },
    { protocol: "Uniswap", chain: "Arbitrum", action: "USDC-USDT LP (0.01%)",           weight: 0.35 },
    { protocol: "Uniswap", chain: "Arbitrum", action: "ETH-USDC LP (0.05%, ±50%)",     weight: 0.20 }
  ],
  "Base:base-stable": [
    { protocol: "Aave",    chain: "Base",     action: "USDC Supply (eMode)",            weight: 0.50 },
    { protocol: "Uniswap", chain: "Base",     action: "ETH-USDC LP (0.05%)",           weight: 0.30 },
    { protocol: "Uniswap", chain: "Base",     action: "USDC-USDT LP (0.01%)",          weight: 0.20 }
  ],
  "Solana:sol-stable": [
    { protocol: "Orca",    chain: "Solana",   action: "USDC-USDT Whirlpool (0.01%)",   weight: 0.40 },
    { protocol: "Orca",    chain: "Solana",   action: "SOL-USDC Whirlpool",            weight: 0.35 },
    { protocol: "Orca",    chain: "Solana",   action: "mSOL-SOL Whirlpool",            weight: 0.25 }
  ]
};

/** 테이블 미지정 시 기존 Multi 동작 유지 */
const MULTI_FALLBACK: PreviewAlloc[] = [
  { protocol: "Aave",    chain: "Arbitrum", action: "USDC Supply",        weight: 0.20 },
  { protocol: "Aave",    chain: "Base",     action: "USDC Supply",        weight: 0.15 },
  { protocol: "Uniswap", chain: "Arbitrum", action: "USDC-USDT LP",      weight: 0.25 },
  { protocol: "Uniswap", chain: "Arbitrum", action: "ETH-USDC LP route", weight: 0.15 },
  { protocol: "Orca",    chain: "Solana",   action: "USDC-USDT Whirlpool", weight: 0.20 }
];

export function buildExecutionPreviewRows(
  depositUsd: number,
  productNetwork?: ProductNetwork,
  productSubtype?: ProductSubtype
): ExecutionPreviewRow[] {
  if (!Number.isFinite(depositUsd) || depositUsd <= 0) return [];

  const tableKey = productNetwork && productSubtype
    ? `${productNetwork}:${productSubtype}`
    : "";

  const allocs = PREVIEW_ALLOC_TABLE[tableKey] ?? MULTI_FALLBACK;

  return allocs.map((a) => ({
    protocol: a.protocol,
    chain: a.chain,
    action: a.action,
    allocationUsd: Number((depositUsd * a.weight).toFixed(2))
  }));
}
