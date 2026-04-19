/**
 * 전략 엔진 — 네트워크별 Allocation 셋과 guardrail 검증 로직.
 * 각 OPTION_* 상수는 DEFAULT_PRODUCTS protocolMix 및 서버 adapter weight table과 동기화되어야 한다.
 *
 * defi_anal.py 분석 기준 expectedApr:
 *   Aave Arb USDC: 3.36%, Aave Base USDC: 4.26%, Aave ETH USDC: 3.0%, Aave ETH WETH: 1.8%
 *   Uni Arb USDC-USDT: 6.4%, Uni Arb ETH-USDC ±50%: 35.85%
 *   Uni Base ETH-USDC: 28%, Uni Base USDC-USDT: 6.0%
 *   Uni ETH USDC-USDT: 5.0%, Uni ETH ETH-USDC: 12%
 *   Orca USDC-USDT: 4.83%, Orca SOL-USDC: 12%, Orca mSOL-SOL: 7%
 *   Curve 3pool: 2.5%, Curve stETH-ETH: 3.5%
 */

import type { Allocation, PortfolioPlan } from "../types";
import type { ProductSubtype } from "./api";

// ─── Multi-chain ────────────────────────────────────────────────────────────

/** Multi-network Stable 8% 기반 전략 (기존 L2*) */
export const OPTION_MULTI_STABLE: Allocation[] = [
  { key: "aave-arb-usdc",    label: "Aave V3 USDC",             protocol: "Aave",    chain: "Arbitrum", targetWeight: 0.45, expectedApr: 0.0336 },
  { key: "uni-arb-usdc-usdt",label: "Uniswap V3 USDC-USDT",    protocol: "Uniswap", chain: "Arbitrum", targetWeight: 0.35, expectedApr: 0.064 },
  { key: "orca-usdc-usdt",   label: "Orca USDC-USDT",           protocol: "Orca",    chain: "Solana",   targetWeight: 0.20, expectedApr: 0.0483 }
];

/** Multi-network Balanced 7.2% 기반 전략 */
export const OPTION_MULTI_BALANCED: Allocation[] = [
  { key: "aave-base-usdc",   label: "Aave V3 USDC",             protocol: "Aave",    chain: "Base",     targetWeight: 0.50, expectedApr: 0.0426 },
  { key: "uni-arb-eth-usdc", label: "Uniswap V3 ETH-USDC (±50%)", protocol: "Uniswap", chain: "Arbitrum", targetWeight: 0.30, expectedApr: 0.3585 },
  { key: "orca-msol-sol",    label: "Orca mSOL-SOL",            protocol: "Orca",    chain: "Solana",   targetWeight: 0.20, expectedApr: 0.07 }
];

/** @deprecated OPTION_MULTI_STABLE로 대체. 하위 호환을 위해 유지. */
export const OPTION_L2_STAR: Allocation[] = [
  { key: "aave-arb-usdc",    label: "Aave V3 USDC",             protocol: "Aave",    chain: "Arbitrum", targetWeight: 0.2,  expectedApr: 0.0336 },
  { key: "aave-base-usdc",   label: "Aave V3 USDC",             protocol: "Aave",    chain: "Base",     targetWeight: 0.15, expectedApr: 0.0426 },
  { key: "orca-sol-usdc-usdt",label: "Orca USDC-USDT",          protocol: "Orca",    chain: "Solana",   targetWeight: 0.2,  expectedApr: 0.0483 },
  { key: "uni-arb-usdc-usdt",label: "Uniswap V3 USDC-USDT",    protocol: "Uniswap", chain: "Arbitrum", targetWeight: 0.25, expectedApr: 0.064 },
  { key: "uni-arb-eth-usdc", label: "Uniswap V3 ETH-USDC (±50%)", protocol: "Uniswap", chain: "Arbitrum", targetWeight: 0.15, expectedApr: 0.3585 },
  { key: "cash-usdc-buffer", label: "USDC 현금 버퍼",           protocol: "Cash",    chain: "Multi",    targetWeight: 0.05, expectedApr: 0 }
];

// ─── Arbitrum ────────────────────────────────────────────────────────────────

/** Arbitrum Stable 7.6% — Aave 45% + Uniswap USDC-USDT 35% + Uniswap ETH-USDC 20% */
export const OPTION_ARBITRUM_STABLE: Allocation[] = [
  { key: "aave-arb-usdc",     label: "Aave V3 USDC",                protocol: "Aave",    chain: "Arbitrum", targetWeight: 0.45, expectedApr: 0.0336 },
  { key: "uni-arb-usdc-usdt", label: "Uniswap V3 USDC-USDT (0.01%)", protocol: "Uniswap", chain: "Arbitrum", targetWeight: 0.35, expectedApr: 0.064 },
  { key: "uni-arb-eth-usdc",  label: "Uniswap V3 ETH-USDC (±50%)",  protocol: "Uniswap", chain: "Arbitrum", targetWeight: 0.20, expectedApr: 0.3585 }
];

// ─── Base ─────────────────────────────────────────────────────────────────────

/** Base USDC Core 7.0% — Aave 50% + Uniswap ETH-USDC 30% + Uniswap USDC-USDT 20% */
export const OPTION_BASE_STABLE: Allocation[] = [
  { key: "aave-base-usdc",     label: "Aave V3 USDC",            protocol: "Aave",    chain: "Base", targetWeight: 0.50, expectedApr: 0.0426 },
  { key: "uni-base-eth-usdc",  label: "Uniswap V3 Base ETH-USDC (0.05%)", protocol: "Uniswap", chain: "Base", targetWeight: 0.30, expectedApr: 0.28 },
  { key: "uni-base-usdc-usdt", label: "Uniswap V3 Base USDC-USDT (0.01%)", protocol: "Uniswap", chain: "Base", targetWeight: 0.20, expectedApr: 0.06 }
];

// ─── Solana ───────────────────────────────────────────────────────────────────

/** Solana Orca Blend 7.4% — Orca USDC-USDT 40% + SOL-USDC 35% + mSOL-SOL 25% */
export const OPTION_SOLANA_STABLE: Allocation[] = [
  { key: "orca-usdc-usdt", label: "Orca USDC-USDT Whirlpool (0.01%)", protocol: "Orca", chain: "Solana", targetWeight: 0.40, expectedApr: 0.0483 },
  { key: "orca-sol-usdc",  label: "Orca SOL-USDC Whirlpool",         protocol: "Orca", chain: "Solana", targetWeight: 0.35, expectedApr: 0.12 },
  { key: "orca-msol-sol",  label: "Orca mSOL-SOL Whirlpool",         protocol: "Orca", chain: "Solana", targetWeight: 0.25, expectedApr: 0.07 }
];

// ─── Ethereum ────────────────────────────────────────────────────────────────

/** Ethereum Stable 4.2% — Aave USDC 40% + Curve 3pool 35% + Uniswap USDC-USDT 25% */
export const OPTION_ETHEREUM_STABLE: Allocation[] = [
  { key: "aave-eth-usdc",   label: "Aave V3 USDC",                  protocol: "Aave",    chain: "Ethereum", targetWeight: 0.40, expectedApr: 0.03 },
  { key: "crv-3pool",       label: "Curve 3pool (DAI-USDC-USDT)",   protocol: "Curve",   chain: "Ethereum", targetWeight: 0.35, expectedApr: 0.025 },
  { key: "uni-eth-usdc-usdt",label: "Uniswap V3 USDC-USDT (0.01%)", protocol: "Uniswap", chain: "Ethereum", targetWeight: 0.25, expectedApr: 0.05 }
];

/** Ethereum Blue-chip 5.5% — Aave WETH 30% + Curve stETH-ETH 40% + Uniswap ETH-USDC 30% */
export const OPTION_ETHEREUM_BLUECHIP: Allocation[] = [
  { key: "aave-eth-weth",   label: "Aave V3 WETH",                  protocol: "Aave",    chain: "Ethereum", targetWeight: 0.30, expectedApr: 0.018 },
  { key: "crv-steth-eth",   label: "Curve stETH-ETH",               protocol: "Curve",   chain: "Ethereum", targetWeight: 0.40, expectedApr: 0.035 },
  { key: "uni-eth-eth-usdc", label: "Uniswap V3 ETH-USDC (0.05%)", protocol: "Uniswap", chain: "Ethereum", targetWeight: 0.30, expectedApr: 0.12 }
];

// ─── Catalog ──────────────────────────────────────────────────────────────────

/** ProductSubtype → Allocation[] 카탈로그. 포트폴리오 플래너·guardrail 검증에 활용. */
export const STRATEGY_CATALOG: Record<ProductSubtype, Allocation[]> = {
  "multi-stable":   OPTION_MULTI_STABLE,
  "multi-balanced": OPTION_MULTI_BALANCED,
  "arb-stable":     OPTION_ARBITRUM_STABLE,
  "base-stable":    OPTION_BASE_STABLE,
  "sol-stable":     OPTION_SOLANA_STABLE,
  "eth-stable":     OPTION_ETHEREUM_STABLE,
  "eth-bluechip":   OPTION_ETHEREUM_BLUECHIP
};

// ─── Guardrails ───────────────────────────────────────────────────────────────

export const guardrails = {
  maxSinglePoolWeight: 0.5,    // 단일 네트워크 상품에서는 50%까지 허용
  maxSingleChainWeight: 1.0,   // 단일 네트워크 상품이므로 1.0 허용
  minProtocols: 1
};

export function buildPlan(depositUsd: number, subtype?: ProductSubtype): PortfolioPlan {
  const allocations = subtype ? (STRATEGY_CATALOG[subtype] ?? OPTION_L2_STAR) : OPTION_L2_STAR;

  const items = allocations.map((item) => {
    const allocationUsd = depositUsd * item.targetWeight;
    const expectedYieldUsd = allocationUsd * item.expectedApr;
    return { ...item, allocationUsd, expectedYieldUsd };
  });

  const expectedAnnualYieldUsd = items.reduce((acc, item) => acc + item.expectedYieldUsd, 0);

  return {
    totalDepositUsd: depositUsd,
    items,
    expectedAnnualYieldUsd
  };
}

export function checkGuardrails(subtype?: ProductSubtype) {
  const allocations = subtype ? (STRATEGY_CATALOG[subtype] ?? OPTION_L2_STAR) : OPTION_L2_STAR;

  const chainWeights = allocations.reduce<Record<string, number>>((acc, item) => {
    acc[item.chain] = (acc[item.chain] ?? 0) + item.targetWeight;
    return acc;
  }, {});

  const uniqueProtocols = new Set(allocations.map((item) => item.protocol).filter((p) => p !== "Cash"));
  const maxPool = Math.max(...allocations.map((item) => item.targetWeight));
  const maxChain = Math.max(...Object.values(chainWeights));

  return {
    maxPoolOk: maxPool <= guardrails.maxSinglePoolWeight,
    maxChainOk: maxChain <= guardrails.maxSingleChainWeight,
    minProtocolOk: uniqueProtocols.size >= guardrails.minProtocols,
    chainWeights
  };
}
