export type ExecutionMode = "dry-run" | "live";

export type ProductNetwork = "Ethereum" | "Arbitrum" | "Base" | "Solana" | "Multi";

/**
 * 상품 서브타입 — 동일 네트워크 내에서 배분 비율이 다른 상품을 구분.
 * 각 어댑터는 (productNetwork + productSubtype) 조합으로 정확한 비율을 조회한다.
 *
 * 현재 정의된 상품:
 *   multi-stable    → Multi-network Stable 8%      (Aave Arb 45% + Uniswap Arb 35% + Orca 20%)
 *   multi-balanced  → Multi-network Balanced 7.2%  (Aave Base 50% + Uniswap Arb 30% + Orca 20%)
 *   arb-stable      → Arbitrum Stable 7.6%         (Aave Arb 45% + Uni Arb USDC-USDT 35% + Uni Arb ETH-USDC 20%)
 *   base-stable     → Base USDC Core 7.0%           (Aave Base 50% + Uni Base ETH-USDC 30% + Uni Base USDC-USDT 20%)
 *   sol-stable      → Solana Orca Blend 7.4%        (Orca USDC-USDT 40% + Orca SOL-USDC 35% + Orca mSOL-SOL 25%)
 */
export type ProductSubtype =
  | "multi-stable"
  | "multi-balanced"
  | "arb-stable"
  | "base-stable"
  | "sol-stable"
  | "eth-stable"
  | "eth-bluechip";

export type AdapterExecutionContext = {
  jobId: string;
  mode: ExecutionMode;
  depositUsd: number;
  timestamp: string;
  /** 예치상품의 대상 네트워크. 미지정 시 "Multi"로 처리. */
  productNetwork?: ProductNetwork;
  /** 상품 서브타입. 동일 네트워크 내 배분 비율 분기에 사용. */
  productSubtype?: ProductSubtype;
  protocolReadiness?: ProtocolExecutionReadiness[];
  /** 브라우저 지갑이 직접 실행한 결과(예: Solana Orca live). */
  clientExecutionResults?: AdapterExecutionResult[];
};

export type AdapterExecutionResult = {
  protocol: "Aave" | "Uniswap" | "Orca" | "Aerodrome" | "Raydium" | "Curve";
  chain: "Arbitrum" | "Base" | "Solana" | "Ethereum";
  action: string;
  allocationUsd: number;
  txId: string;
  status: "simulated" | "submitted";
};

export type ProtocolExecutionReadiness = {
  protocol: AdapterExecutionResult["protocol"];
  chain: AdapterExecutionResult["chain"];
  action: string;
  implemented: boolean;
  flagOn: boolean;
  ready: boolean;
  reason: string;
};
