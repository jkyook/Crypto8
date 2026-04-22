import type { MarketAprSnapshot, ProductNetwork, ProductSubtype } from "./api";
import { APR_DAYS_PER_YEAR } from "./constants";

/**
 * UI에서 보여주는 수익 상품 정의.
 * subtype은 서버 어댑터의 배분 비율 결정에 쓰이므로 api.ts ProductSubtype과 일치해야 한다.
 */
export type YieldProduct = {
  id: string;
  name: string;
  networkGroup: "multi" | "arbitrum" | "base" | "solana" | "ethereum";
  subtype: ProductSubtype;
  targetApr: number;
  estFeeBps: number;
  lockDays: number;
  protocolMix: Array<{ name: string; weight: number; pool?: string }>;
  detail: string;
};

export type ProductNetworkGroup = YieldProduct["networkGroup"];

/** UI의 networkGroup(소문자) → 서버 어댑터의 ProductNetwork(PascalCase) 변환. */
export function networkGroupToProductNetwork(networkGroup: ProductNetworkGroup): ProductNetwork {
  const map: Record<ProductNetworkGroup, ProductNetwork> = {
    multi: "Multi",
    arbitrum: "Arbitrum",
    base: "Base",
    solana: "Solana",
    ethereum: "Ethereum"
  };
  return map[networkGroup] ?? "Multi";
}

/** networkGroup → 기본 ProductSubtype (사용자 추가 상품 등 subtype 미지정 시 fallback). */
export function networkGroupToDefaultSubtype(networkGroup: ProductNetworkGroup): ProductSubtype {
  const map: Record<ProductNetworkGroup, ProductSubtype> = {
    multi: "multi-stable",
    arbitrum: "arb-stable",
    base: "base-stable",
    solana: "sol-stable",
    ethereum: "eth-stable"
  };
  return map[networkGroup] ?? "multi-stable";
}

export const PRODUCT_NETWORK_GROUPS: Array<{
  key: ProductNetworkGroup;
  label: string;
  description: string;
}> = [
  { key: "multi", label: "복수 네트워크", description: "Arbitrum · Base · Solana를 함께 쓰는 기존 분산형 상품" },
  { key: "arbitrum", label: "Arbitrum", description: "브릿지 없이 Arbitrum 안에서 Aave/Uniswap 풀로 분산" },
  { key: "base", label: "Base", description: "Base 네트워크 안에서 USDC 중심 공급/LP로 구성" },
  { key: "solana", label: "Solana", description: "Solana 안에서 Orca Whirlpool 기반 스테이블/LST 풀로 구성" },
  { key: "ethereum", label: "Ethereum", description: "Ethereum 메인넷에서 Aave/Curve/Uniswap 풀로 구성된 안정형 상품" }
];

export const PRODUCT_NETWORK_LABELS = PRODUCT_NETWORK_GROUPS.reduce(
  (acc, group) => ({ ...acc, [group.key]: group.label }),
  {} as Record<ProductNetworkGroup, string>
);

export function buildDefaultProductMix(networkGroup: ProductNetworkGroup): YieldProduct["protocolMix"] {
  if (networkGroup === "arbitrum") {
    return [
      { name: "Aave", weight: 0.45, pool: "Aave v3 Arbitrum USDC eMode" },
      { name: "Uniswap", weight: 0.35, pool: "Uniswap v3 Arbitrum USDC-USDT 0.05%" },
      { name: "Uniswap", weight: 0.2, pool: "Uniswap v3 Arbitrum ETH-USDC 0.05% (±50%)" }
    ];
  }
  if (networkGroup === "base") {
    return [
      { name: "Aave", weight: 0.5, pool: "Aave v3 Base USDC eMode" },
      { name: "Uniswap", weight: 0.3, pool: "Uniswap v3 Base ETH-USDC 0.05%" },
      { name: "Uniswap", weight: 0.2, pool: "Uniswap v3 Base USDC-USDT 0.05%" }
    ];
  }
  if (networkGroup === "solana") {
    return [
      { name: "Orca", weight: 0.4, pool: "Orca Whirlpools USDC-USDT" },
      { name: "Orca", weight: 0.35, pool: "Orca Whirlpools SOL-USDC" },
      { name: "Orca", weight: 0.25, pool: "Orca Whirlpools mSOL-SOL" }
    ];
  }
  if (networkGroup === "ethereum") {
    return [
      { name: "Aave", weight: 0.4, pool: "Aave v3 Ethereum USDC" },
      { name: "Curve", weight: 0.35, pool: "Curve 3pool DAI-USDC-USDT" },
      { name: "Uniswap", weight: 0.25, pool: "Uniswap v3 Ethereum USDC-USDT 0.01%" }
    ];
  }
  return [
    { name: "Aave", weight: 0.34, pool: "Aave v3 Arbitrum USDC eMode" },
    { name: "Uniswap", weight: 0.33, pool: "Uniswap v3 Arbitrum USDC-USDT 0.05%" },
    { name: "Orca", weight: 0.33, pool: "Orca Whirlpools SOL-USDC" }
  ];
}

/** 프로토콜명을 기반으로 스냅샷의 해당 프로토콜 연 APR(소수)을 반환. */
export function mixItemAnnualAprDecimal(name: string, snapshot: MarketAprSnapshot): number {
  const key = name.toLowerCase();
  if (key.includes("aave")) return snapshot.aave;
  if (key.includes("uniswap")) return snapshot.uniswap;
  return snapshot.orca;
}

/** 연 APR(소수) → 단순 선형 근사 7일 수익률(퍼센트 포인트, 예 0.12 → 0.12%). */
export function aprDecimalToSimpleWeekYieldPercentPoints(annualAprDecimal: number): number {
  return annualAprDecimal * (7 / APR_DAYS_PER_YEAR) * 100;
}

export const DEFAULT_PRODUCTS: YieldProduct[] = [
  {
    id: "p-multi-stable-8",
    name: "Multi-network Stable 8%",
    networkGroup: "multi",
    subtype: "multi-stable",
    targetApr: 0.08,
    estFeeBps: 65,
    lockDays: 30,
    protocolMix: [
      { name: "Aave", weight: 0.45, pool: "Aave v3 Arbitrum USDC eMode" },
      { name: "Uniswap", weight: 0.35, pool: "Uniswap v3 Arbitrum USDC-USDT 0.05%" },
      { name: "Orca", weight: 0.2, pool: "Orca Whirlpools SOL-USDC" }
    ],
    detail: "초기 전략 문서 기반 기본 상품. Arbitrum, Base, Solana를 함께 쓰는 안정성 중심 분산 예치."
  },
  {
    id: "p-multi-balanced-72",
    name: "Multi-network Balanced 7.2%",
    networkGroup: "multi",
    subtype: "multi-balanced",
    targetApr: 0.072,
    estFeeBps: 58,
    lockDays: 21,
    protocolMix: [
      { name: "Aave", weight: 0.5, pool: "Aave v3 Base USDC eMode" },
      { name: "Uniswap", weight: 0.3, pool: "Uniswap v3 Arbitrum ETH-USDC 0.05% (±50%)" },
      { name: "Orca", weight: 0.2, pool: "Orca Whirlpools mSOL-SOL" }
    ],
    detail: "변동성 완화를 우선한 중립형 예치상품. 네트워크 간 분산 효과를 유지합니다."
  },
  {
    id: "p-arbitrum-stable-76",
    name: "Arbitrum Stable 7.6%",
    networkGroup: "arbitrum",
    subtype: "arb-stable",
    targetApr: 0.076,
    estFeeBps: 48,
    lockDays: 21,
    protocolMix: [
      { name: "Aave", weight: 0.45, pool: "Aave v3 Arbitrum USDC eMode" },
      { name: "Uniswap", weight: 0.35, pool: "Uniswap v3 Arbitrum USDC-USDT 0.05%" },
      { name: "Uniswap", weight: 0.2, pool: "Uniswap v3 Arbitrum ETH-USDC 0.05% (±50%)" }
    ],
    detail: "브릿지 없이 Arbitrum 내에서 USDC 공급과 스테이블/ETH-USDC LP를 조합한 상품."
  },
  {
    id: "p-base-usdc-70",
    name: "Base USDC Core 7.0%",
    networkGroup: "base",
    subtype: "base-stable",
    targetApr: 0.07,
    estFeeBps: 44,
    lockDays: 21,
    protocolMix: [
      { name: "Aave", weight: 0.5, pool: "Aave v3 Base USDC eMode" },
      { name: "Uniswap", weight: 0.3, pool: "Uniswap v3 Base ETH-USDC 0.05%" },
      { name: "Uniswap", weight: 0.2, pool: "Uniswap v3 Base USDC-USDT 0.05%" }
    ],
    detail: "Base 네트워크 안에서 Aave USDC 공급과 Uniswap Base LP를 묶어 네트워크 이동을 줄입니다."
  },
  {
    id: "p-solana-orca-74",
    name: "Solana Orca Blend 7.4%",
    networkGroup: "solana",
    subtype: "sol-stable",
    targetApr: 0.074,
    estFeeBps: 42,
    lockDays: 14,
    protocolMix: [
      { name: "Orca", weight: 0.4, pool: "Orca Whirlpools USDC-USDT" },
      { name: "Orca", weight: 0.35, pool: "Orca Whirlpools SOL-USDC" },
      { name: "Orca", weight: 0.25, pool: "Orca Whirlpools mSOL-SOL" }
    ],
    detail: "Solana 네트워크 안에서 Orca 스테이블·SOL·LST 풀을 나눠 담는 단일 네트워크 상품."
  },
  {
    id: "p-eth-stable-42",
    name: "Ethereum Stable 4.2%",
    networkGroup: "ethereum",
    subtype: "eth-stable",
    targetApr: 0.042,
    estFeeBps: 55,
    lockDays: 30,
    protocolMix: [
      { name: "Aave", weight: 0.4, pool: "Aave v3 Ethereum USDC" },
      { name: "Curve", weight: 0.35, pool: "Curve 3pool DAI-USDC-USDT" },
      { name: "Uniswap", weight: 0.25, pool: "Uniswap v3 Ethereum USDC-USDT 0.01%" }
    ],
    detail: "Ethereum 메인넷에서 Aave USDC 공급, Curve 3pool, Uniswap 스테이블 LP를 조합한 안정형 상품."
  },
  {
    id: "p-eth-bluechip-55",
    name: "Ethereum Blue-chip 5.5%",
    networkGroup: "ethereum",
    subtype: "eth-bluechip",
    targetApr: 0.055,
    estFeeBps: 58,
    lockDays: 30,
    protocolMix: [
      { name: "Aave", weight: 0.3, pool: "Aave v3 Ethereum WETH" },
      { name: "Curve", weight: 0.4, pool: "Curve stETH-ETH" },
      { name: "Uniswap", weight: 0.3, pool: "Uniswap v3 Ethereum ETH-USDC 0.05%" }
    ],
    detail: "Ethereum 메인넷 대표 자산(ETH/stETH) 중심의 Blue-chip 예치상품. Curve LSD 수익 포함."
  }
];
