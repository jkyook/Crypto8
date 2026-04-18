import type { DepositPositionPayload } from "./api";

type Mix = { name: string; weight: number; pool?: string };

/** 풀/프로토콜명으로 체인 라벨 추정 (표시용). */
export function inferChainFromMix(mix: Mix): string {
  const pool = (mix.pool ?? "").toLowerCase();
  const name = mix.name.toLowerCase();
  if (pool.includes("base") && !pool.includes("arbitrum")) {
    return "Base";
  }
  if (pool.includes("arbitrum") || pool.includes("arb ")) {
    return "Arbitrum";
  }
  if (name.includes("orca") || pool.includes("solana") || pool.includes("whirlpool")) {
    return "Solana";
  }
  if (name.includes("uniswap")) {
    return "Arbitrum";
  }
  if (name.includes("aave")) {
    return pool.includes("base") ? "Base" : "Arbitrum";
  }
  return "기타";
}

/** 예치 포지션에서 체인별 USD 노출 합산. */
export function aggregateChainUsdFromPositions(positions: DepositPositionPayload[]): Record<string, number> {
  const acc: Record<string, number> = {};
  for (const pos of positions) {
    for (const mix of pos.protocolMix) {
      const chain = inferChainFromMix(mix);
      const usd = pos.amountUsd * mix.weight;
      acc[chain] = (acc[chain] ?? 0) + usd;
    }
  }
  return acc;
}

/** 상품 목표 APR 기반 연간 추정 수익(USD, 명목). */
export function estimateAnnualYieldUsd(positions: DepositPositionPayload[]): number {
  return positions.reduce((sum, p) => sum + p.amountUsd * p.expectedApr, 0);
}
