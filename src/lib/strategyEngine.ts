import type { Allocation, PortfolioPlan } from "../types";

export const OPTION_L2_STAR: Allocation[] = [
  {
    key: "aave-arb-usdc",
    label: "Aave V3 USDC",
    protocol: "Aave",
    chain: "Arbitrum",
    targetWeight: 0.2,
    expectedApr: 0.0336
  },
  {
    key: "aave-base-usdc",
    label: "Aave V3 USDC",
    protocol: "Aave",
    chain: "Base",
    targetWeight: 0.15,
    expectedApr: 0.0426
  },
  {
    key: "orca-sol-usdc-usdt",
    label: "Orca USDC-USDT",
    protocol: "Orca",
    chain: "Solana",
    targetWeight: 0.2,
    expectedApr: 0.0483
  },
  {
    key: "uni-arb-usdc-usdt",
    label: "Uniswap V3 USDC-USDT",
    protocol: "Uniswap",
    chain: "Arbitrum",
    targetWeight: 0.25,
    expectedApr: 0.064
  },
  {
    key: "uni-arb-eth-usdc",
    label: "Uniswap V3 ETH-USDC (±50%)",
    protocol: "Uniswap",
    chain: "Arbitrum",
    targetWeight: 0.15,
    expectedApr: 0.3585
  },
  {
    key: "cash-usdc-buffer",
    label: "USDC 현금 버퍼",
    protocol: "Cash",
    chain: "Multi",
    targetWeight: 0.05,
    expectedApr: 0
  }
];

export const guardrails = {
  maxSinglePoolWeight: 0.25,
  maxSingleChainWeight: 0.6,
  minProtocols: 3
};

export function buildPlan(depositUsd: number): PortfolioPlan {
  const items = OPTION_L2_STAR.map((item) => {
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

export function checkGuardrails() {
  const chainWeights = OPTION_L2_STAR.reduce<Record<string, number>>((acc, item) => {
    acc[item.chain] = (acc[item.chain] ?? 0) + item.targetWeight;
    return acc;
  }, {});

  const uniqueProtocols = new Set(OPTION_L2_STAR.map((item) => item.protocol).filter((p) => p !== "Cash"));
  const maxPool = Math.max(...OPTION_L2_STAR.map((item) => item.targetWeight));
  const maxChain = Math.max(...Object.values(chainWeights));

  return {
    maxPoolOk: maxPool <= guardrails.maxSinglePoolWeight,
    maxChainOk: maxChain <= guardrails.maxSingleChainWeight,
    minProtocolOk: uniqueProtocols.size >= guardrails.minProtocols,
    chainWeights
  };
}
