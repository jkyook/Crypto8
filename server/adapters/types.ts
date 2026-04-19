export type ExecutionMode = "dry-run" | "live";

export type ProductNetwork = "Ethereum" | "Arbitrum" | "Base" | "Solana" | "Multi";

export type AdapterExecutionContext = {
  jobId: string;
  mode: ExecutionMode;
  depositUsd: number;
  timestamp: string;
  /** 예치상품의 대상 네트워크. 미지정 시 "Multi"로 처리. */
  productNetwork?: ProductNetwork;
};

export type AdapterExecutionResult = {
  protocol: "Aave" | "Uniswap" | "Orca" | "Aerodrome" | "Raydium" | "Curve";
  chain: "Arbitrum" | "Base" | "Solana" | "Ethereum";
  action: string;
  allocationUsd: number;
  txId: string;
  status: "simulated" | "submitted";
};
